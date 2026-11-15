// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Renders readable Java from the IR, with a COBOL ↔ Java line mapping.
 */
import type { CobolProgram, Pic, RelOp, SqlInfo } from "../cobol/types";
import { sentence } from "../text";
import type { JCond, JExpr, JField, JGroup, JProgram, JStmt, NumTarget } from "./ir";
import { conditionMethod, constName, uniq } from "./naming";
import { numLiteral } from "./transpile";

export interface JavaFile {
  name: string;
  content: string;
  kind: "main" | "record" | "runtime";
}

export interface LineMap {
  stmtId: number;
  cobolStart: number;
  cobolEnd: number;
  javaStart: number;
  javaEnd: number;
}

export interface RenderedJava {
  files: JavaFile[];
  mapping: LineMap[];
}

export interface RenderOptions {
  /** Program summary (class javadoc). */
  summary?: string;
  /** Business-rule comment per COBOL statement id. */
  rules?: Map<number, string>;
}

const IND = "    ";

class Writer {
  lines: string[] = [];
  ind = 0;
  line(s = "") {
    this.lines.push(s ? IND.repeat(this.ind) + s : "");
  }
  get n() {
    return this.lines.length;
  }
}

const OPS: Record<string, string> = { add: "add", sub: "subtract", mul: "multiply", div: "divide", pow: "pow" };
const JOP: Record<RelOp, string> = { "=": "==", "<>": "!=", ">": ">", "<": "<", ">=": ">=", "<=": "<=" };

export function renderJava(jp: JProgram, prog: CobolProgram, others: Map<string, JProgram>, opts: RenderOptions = {}): RenderedJava {
  const picConsts = new Map<string, Pic>();
  const instances = new Map<string, string>();
  let usesMc = false;
  let usesExternal = false;
  let usesSql = false;
  let usesRounding = false;
  let usesExit = false;
  let usesEnv = false;
  const cursors = new Map<string, { field: string; constName: string; sql?: string }>();
  const mapping: LineMap[] = [];
  const commented = new Set<number>();

  const fieldOf = (cobol: string): JField | undefined => jp.fields.get(cobol);
  const picConst = (cobol: string): string => {
    const f = fieldOf(cobol);
    const name = "PIC_" + (f?.constant ? f.name : constName(cobol));
    if (f?.pic) picConsts.set(name, f.pic);
    return name;
  };

  // ---------- expressions ----------
  const path = (e: JExpr & { k: "field" }): string => {
    const f = fieldOf(e.f);
    const p = f?.path ?? e.f;
    if (e.sub) return `${p}[${num(e.sub)}.intValueExact() - 1]`;
    return p;
  };

  const num = (e: JExpr): string => {
    switch (e.k) {
      case "num":
        return numLiteral(e.v);
      case "field":
        if (e.f === "SQLCODE") return "BigDecimal.valueOf(sqlcode)";
        return path(e);
      case "op": {
        const a = num(e.a);
        if (e.op === "div") {
          usesMc = true;
          return `${a}.divide(${num(e.b)}, MC)`;
        }
        if (e.op === "pow") {
          usesMc = true;
          const exp = e.b.k === "num" ? e.b.v : `${num(e.b)}.intValueExact()`;
          return `${a}.pow(${exp}, MC)`;
        }
        return `${a}.${OPS[e.op]}(${num(e.b)})`;
      }
      case "neg":
        return `${num(e.e)}.negate()`;
      case "parse":
        return `Pic.parse(${str(e.e)})`;
      case "func": {
        const args = e.args.map(num);
        switch (e.name) {
          case "MAX":
            return args.reduce((x, y) => `${x}.max(${y})`);
          case "MIN":
            return args.reduce((x, y) => `${x}.min(${y})`);
          case "ABS":
            return `${args[0]}.abs()`;
          case "INTEGER":
            return `${args[0]}.setScale(0, RoundingMode.FLOOR)`;
          case "INTEGER-PART":
            return `${args[0]}.setScale(0, RoundingMode.DOWN)`;
          default:
            return `Pic.intrinsic("${e.name}", ${args.join(", ")})`;
        }
      }
      default:
        return `Pic.parse(${str(e)})`;
    }
  };

  /** Method chain split into segments for multi-line output. */
  const chain = (e: JExpr): string[] => {
    if (e.k === "op" && e.op !== "pow") {
      const left = chain(e.a);
      if (e.op === "div") {
        usesMc = true;
        return [...left, `.divide(${num(e.b)}, MC)`];
      }
      return [...left, `.${OPS[e.op]}(${num(e.b)})`];
    }
    return [num(e)];
  };

  const str = (e: JExpr): string => {
    switch (e.k) {
      case "str":
        return JSON.stringify(e.v.replace(/\s+$/, ""));
      case "fill":
        return JSON.stringify(e.ch.repeat(e.len));
      case "field":
        return path(e);
      case "digits": {
        const inner = num(e.e);
        if (e.e.k === "field") return `Pic.digits(${inner}, ${picConst(e.e.f)})`;
        return `Pic.digits(${inner})`;
      }
      case "func":
        if (e.name === "ACCEPT") {
          usesEnv = true;
          return `Environment.accept("${(e.args[1] as { v: string }).v || "CONSOLE"}")`;
        }
        return `String.valueOf(${num(e)})`;
      default:
        return `${num(e)}.toPlainString()`;
    }
  };

  const isSqlcode = (e: JExpr) => e.k === "field" && e.f === "SQLCODE";

  const cond = (c: JCond, parentOp?: "and" | "or"): string => {
    switch (c.k) {
      case "and":
      case "or": {
        const s = `${cond(c.a, c.k)} ${c.k === "and" ? "&&" : "||"} ${cond(c.b, c.k)}`;
        return parentOp && parentOp !== c.k ? `(${s})` : s;
      }
      case "not":
        return c.c.k === "cond88" || c.c.k === "isNumeric" ? `!${cond(c.c)}` : `!(${cond(c.c)})`;
      case "cmpNum": {
        if (isSqlcode(c.a) && c.b.k === "num") return `sqlcode ${JOP[c.op]} ${c.b.v}`;
        if (c.b.k === "num" && /^0+(\.0+)?$/.test(c.b.v)) return `${num(c.a)}.signum() ${JOP[c.op]} 0`;
        return `${num(c.a)}.compareTo(${num(c.b)}) ${JOP[c.op]} 0`;
      }
      case "cmpStr": {
        const a = str(c.a);
        const b = str(c.b);
        if (c.op === "=" || c.op === "<>") {
          const neg = c.op === "<>" ? "!" : "";
          if (b === '""') return `${neg}${a}.isEmpty()`;
          return `${neg}${a}.equals(${b})`;
        }
        return `${a}.compareTo(${b}) ${JOP[c.op]} 0`;
      }
      case "cond88":
        return c.call;
      case "isNumeric": {
        const f = c.e.k === "field" ? fieldOf(c.e.f) : undefined;
        const s = f && !f.isNum ? `Pic.isNumeric(${f.path}, ${f.length})` : "true";
        return c.neg ? `!${s}` : s;
      }
    }
  };

  // ---------- statements ----------
  const w = new Writer();
  let localCounter = new Map<string, number>();
  const local = (base: string) => {
    const n = (localCounter.get(base) ?? 0) + 1;
    localCounter.set(base, n);
    return n === 1 ? base : base + n;
  };

  const emitComment = (s: JStmt) => {
    if (commented.has(s.o.id)) return;
    commented.add(s.o.id);
    const rule = opts.rules?.get(s.o.id);
    if (rule) w.line(`// ${rule}`);
    else if (s.o.comment) w.line(`// ${sentence(s.o.comment)}`);
  };

  const numRhs = (t: NumTarget, code?: string): { text: string; trailing?: string } => {
    const f = fieldOf(t.f);
    const pic = f?.pic;
    const e = code ?? num(t.e);
    if (!t.fit || !pic) return { text: e };
    const decisionNote = t.decision ? (t.fit.mode === "HALF_UP" ? "ROUNDED: half up, same as COBOL" : `ROUNDED: ${t.fit.mode}, team convention`) : undefined;
    if (t.fit.overflow === "reproduce") {
      const pc = picConst(t.f);
      if (t.fit.mode === "DOWN") return { text: `Pic.store(${e}, ${pc})`, trailing: decisionNote };
      usesRounding = true;
      return { text: `Pic.store(${e}, ${pc}, RoundingMode.${t.fit.mode})`, trailing: decisionNote };
    }
    usesRounding = true;
    return { text: `${e}.setScale(${pic.scale}, RoundingMode.${t.fit.mode})${pic.signed ? "" : ".abs()"}`, trailing: decisionNote ?? "overflow not reproduced (convention)" };
  };

  const emitAssign = (t: NumTarget, code?: string) => {
    const f = fieldOf(t.f);
    const lhs = t.f === "SQLCODE" ? "sqlcode" : path({ k: "field", f: t.f, sub: t.sub });
    if (t.f === "SQLCODE") {
      w.line(`sqlcode = ${code ?? num(t.e)}.intValue();`);
      return;
    }
    const { text, trailing } = numRhs(t, code);
    const full = `${lhs} = ${text};${trailing ? `   // ${trailing}` : ""}`;
    if (code || full.length + w.ind * 4 <= 112) {
      w.line(full);
      return;
    }
    // Split over several lines
    const pic = f?.pic;
    const segs = chain(t.e);
    if (t.fit && pic && t.fit.overflow === "reproduce") {
      const pc = picConst(t.f);
      w.line(`${lhs} = Pic.store(`);
      w.ind += 2;
      w.line(segs[0]);
      w.ind++;
      segs.slice(1).forEach((sg, i) => w.line(sg + (i === segs.length - 2 ? "," : "")));
      if (segs.length === 1) w.lines[w.lines.length - 1] += ",";
      w.ind--;
      w.line(t.fit.mode === "DOWN" ? `${pc});` : `${pc}, RoundingMode.${t.fit.mode});${trailing ? `   // ${trailing}` : ""}`);
      w.ind -= 2;
    } else {
      w.line(`${lhs} = ${segs[0]}`);
      w.ind += 2;
      segs.slice(1).forEach((sg, i) => w.line(sg + (i === segs.length - 2 && !(t.fit && pic) ? ";" : "")));
      if (t.fit && pic) w.line(`.setScale(${pic.scale}, RoundingMode.${t.fit.mode})${pic.signed ? "" : ".abs()"};${trailing ? `   // ${trailing}` : ""}`);
      else if (segs.length === 1) w.lines[w.lines.length - 1] += ";";
      w.ind -= 2;
    }
  };

  const emitCond = (prefix: string, c: string, suffix: string) => {
    const full = `${prefix}${c}${suffix}`;
    if (full.length + w.ind * 4 <= 100) {
      w.line(full);
      return;
    }
    const parts = c.split(/ (?=\|\| |&& )/);
    w.line(prefix + parts[0]);
    w.ind += 2;
    parts.slice(1).forEach((p, i) => w.line(p + (i === parts.length - 2 ? suffix : "")));
    w.ind -= 2;
  };

  const sqlText = (sql: SqlInfo) => {
    let t = sql.text.replace(/\s+/g, " ").trim();
    if (sql.op === "SELECT") t = t.replace(/\s+INTO\s+.+?\s+FROM\s+/i, " FROM ");
    const into = new Set(sql.into);
    const params: string[] = [];
    t = t.replace(/:([A-Za-z0-9][A-Za-z0-9-]*)/g, (_, v: string) => {
      const name = v.toUpperCase();
      if (!into.has(name)) params.push(name);
      return "?";
    });
    return { text: t, params: params.map((p) => fieldOf(p)?.path ?? p) };
  };

  const emitFetchInto = (vars: string[], row: string) => {
    vars.forEach((v, i) => {
      const f = fieldOf(v);
      if (!f) return;
      if (f.isNum) w.line(`${f.path} = ${row}.decimal(${i + 1}, ${picConst(v)});`);
      else w.line(`${f.path} = ${row}.text(${i + 1}, ${f.length});`);
    });
  };

  const emit = (s: JStmt, isLastTop = false) => {
    const start = w.n + 1;
    emitComment(s);
    switch (s.k) {
      case "setNum": {
        const main = s.targets.filter((t) => !t.afterStore);
        const late = s.targets.filter((t) => t.afterStore);
        if (s.sizeError && s.targets.length > 1) {
          // Several targets: each one that overflows keeps its value, the others are stored.
          const flag = local("sizeError");
          w.line(`boolean ${flag} = false;`);
          const guarded = (t: NumTarget, cand: string) => {
            const pc = picConst(t.f);
            const mode = t.fit?.mode ?? "DOWN";
            usesRounding = true;
            w.line(`if (Pic.overflows(${cand}, ${pc}, RoundingMode.${mode})) ${flag} = true;`);
            w.line(`else ${path({ k: "field", f: t.f, sub: t.sub })} = Pic.store(${cand}, ${pc}, RoundingMode.${mode});`);
          };
          const cands = main.map((t) => {
            const c = local("candidate");
            w.line(`BigDecimal ${c} = ${num(t.e)};`);
            return c;
          });
          main.forEach((t, i) => guarded(t, cands[i]));
          for (const t of late) {
            const c = local("candidate");
            w.line(`BigDecimal ${c} = ${num(t.e)};`);
            guarded(t, c);
          }
          w.line(`if (${flag}) {   // ON SIZE ERROR`);
          w.ind++;
          (s.sizeError.on ?? []).forEach((x) => emit(x));
          w.ind--;
          w.line("} else {");
          w.ind++;
          (s.sizeError.not ?? []).forEach((x) => emit(x));
          w.ind--;
          w.line("}");
        } else if (s.sizeError) {
          const t = s.targets[0];
          const pc = picConst(t.f);
          const mode = t.fit?.mode ?? "DOWN";
          usesRounding = true;
          const cand = local("candidate");
          w.line(`BigDecimal ${cand} = ${num(t.e)};`);
          w.line(`if (Pic.overflows(${cand}, ${pc}, RoundingMode.${mode})) {   // ON SIZE ERROR`);
          w.ind++;
          (s.sizeError.on ?? []).forEach((x) => emit(x));
          w.ind--;
          w.line("} else {");
          w.ind++;
          w.line(`${path({ k: "field", f: t.f, sub: t.sub })} = Pic.store(${cand}, ${pc}, RoundingMode.${mode});`);
          (s.sizeError.not ?? []).forEach((x) => emit(x));
          w.ind--;
          w.line("}");
        } else {
          // When a later target reads a field stored by an earlier one (COMPUTE A B = A + 1),
          // evaluate every expression first, like COBOL does.
          const stored = new Set<string>();
          let aliased = false;
          for (const t of main) {
            if (fieldRefs(t.e).some((f) => stored.has(f))) aliased = true;
            stored.add(t.f);
          }
          if (aliased) {
            const temps = main.map((t) => {
              const v = local("value");
              w.line(`BigDecimal ${v} = ${num(t.e)};`);
              return v;
            });
            main.forEach((t, i) => emitAssign(t, temps[i]));
          } else main.forEach((t) => emitAssign(t));
          late.forEach((t) => emitAssign(t));
        }
        break;
      }
      case "setStr": {
        const f = fieldOf(s.f);
        const rhs = str(s.e);
        const lhs = path({ k: "field", f: s.f, sub: s.sub });
        const trunc = s.e.k === "field" && fieldOf(s.e.f) && (fieldOf(s.e.f)!.length > (f?.length ?? 1)) ? `Pic.truncate(${rhs}, ${f?.length})` : rhs;
        w.line(`${lhs} = ${trunc};${s.note ? `   // ${s.note}` : ""}`);
        break;
      }
      case "if":
        emitCond("if (", cond(s.c), ") {");
        w.ind++;
        s.then.forEach((x) => emit(x));
        w.ind--;
        if (s.else && s.else.length) {
          w.line("} else {");
          w.ind++;
          s.else.forEach((x) => emit(x));
          w.ind--;
        }
        w.line("}");
        break;
      case "switchStr":
        w.line(`switch (${str(s.subject)}) {`);
        w.ind++;
        for (const c of s.cases) {
          w.line(`case ${c.values.map((v) => JSON.stringify(v)).join(", ")} -> {`);
          w.ind++;
          c.body.forEach((x) => emit(x));
          w.ind--;
          w.line("}");
        }
        w.line("default -> {");
        w.ind++;
        (s.other ?? []).forEach((x) => emit(x));
        w.ind--;
        w.line("}");
        w.ind--;
        w.line("}");
        break;
      case "chain":
        s.cases.forEach((c, i) => {
          emitCond(i === 0 ? "if (" : "} else if (", cond(c.c), ") {");
          w.ind++;
          c.body.forEach((x) => emit(x));
          w.ind--;
        });
        if (s.other && s.other.length) {
          w.line("} else {");
          w.ind++;
          s.other.forEach((x) => emit(x));
          w.ind--;
        }
        w.line("}");
        break;
      case "perform":
        s.methods.forEach((m) => w.line(`${m}();`));
        break;
      case "block":
        s.body.forEach((x) => emit(x));
        break;
      case "while":
        if (s.doWhile) {
          w.line("do {");
          w.ind++;
          s.body.forEach((x) => emit(x));
          w.ind--;
          emitCond("} while (", cond(s.c), ");");
        } else {
          emitCond("while (", cond(s.c), ") {");
          w.ind++;
          s.body.forEach((x) => emit(x));
          w.ind--;
          w.line("}");
        }
        break;
      case "repeat": {
        const i = local("i");
        w.line(`for (int ${i} = 0, n = ${num(s.n)}.intValueExact(); ${i} < n; ${i}++) {`);
        w.ind++;
        s.body.forEach((x) => emit(x));
        w.ind--;
        w.line("}");
        break;
      }
      case "varying": {
        emit(s.init);
        emitCond("while (", cond(s.c), ") {");
        w.ind++;
        s.body.forEach((x) => emit(x));
        const stepTarget = (s.step as JStmt & { k: "setNum" }).targets[0];
        const f = fieldOf(stepTarget.f);
        if (f?.pic && stepTarget.fit) {
          const max = "9".repeat(f.pic.intDigits);
          w.line(`${f.path} = Pic.store(${num(stepTarget.e)}, ${picConst(stepTarget.f)});   // PIC ${f.pic.raw}: wraps to 0 after ${max}`);
        } else emit(s.step);
        w.ind--;
        w.line("}");
        break;
      }
      case "call": {
        if (s.external) {
          usesExternal = true;
          const args = s.args.map((a) => (a.literal ? str(a.literal) : (jp.groups.find((g) => g.cobol === a.cobol)?.varName ?? fieldOf(a.cobol)?.path ?? a.cobol)));
          w.line(`external.call("${s.program}"${args.length ? ", " + args.join(", ") : ""});   // program not in the sources`);
          break;
        }
        const callee = others.get(s.program);
        const cls = callee?.className ?? s.program;
        const inst = instances.get(s.program) ?? cls[0].toLowerCase() + cls.slice(1);
        instances.set(s.program, inst);
        const after: string[] = [];
        const argNames = s.args.map((a) => {
          if (a.literal) return str(a.literal);
          const cg = jp.groups.find((g) => g.cobol === a.cobol);
          const pg = callee?.groups.find((g) => g.cobol === a.param);
          if (cg && pg && cg.copybook && cg.copybook === pg.copybook) return cg.varName;
          if (cg && pg) {
            const v = local(pg.varName + "Arg");
            w.line(`${pg.qualified} ${v} = new ${pg.qualified}();`);
            pg.fields.forEach((pf, k) => {
              const cf = cg.fields[k];
              if (cf) w.line(`${v}.${pf.name} = ${cf.path};`);
            });
            if (a.mode === "REFERENCE")
              pg.fields.forEach((pf, k) => {
                const cf = cg.fields[k];
                if (cf) after.push(`${cf.path} = ${v}.${pf.name};`);
              });
            return v;
          }
          return fieldOf(a.cobol)?.path ?? a.cobol;
        });
        w.line(`${inst}.run(${argNames.join(", ")});`);
        after.forEach((l) => w.line(l));
        break;
      }
      case "exit":
        if (isLastTop) w.line(`// ${s.how}: end of program`);
        else {
          usesExit = true;
          w.line(`throw new ProgramExit();   // ${s.how}`);
        }
        break;
      case "print": {
        const parts = s.parts.map((p) => {
          if (p.k === "field") {
            const f = fieldOf(p.f);
            if (f?.isNum) return `Pic.display(${path(p)}, ${picConst(p.f)})`;
            return `Pic.pad(${path(p)}, ${f?.length ?? 1})`;
          }
          if (p.k === "str" || p.k === "fill") return JSON.stringify(p.k === "str" ? p.v : p.ch.repeat(p.len));
          return `${num(p)}.toPlainString()`;
        });
        w.line(`System.out.println(${parts.join(" + ") || '""'});`);
        break;
      }
      case "sql": {
        usesSql = true;
        const sql = s.sql;
        const { text, params } = sqlText(sql);
        const shortCobol = sql.text.replace(/\s+/g, " ").slice(0, 80);
        w.line(`// EXEC SQL ${shortCobol}${sql.text.length > 80 ? "…" : ""}`);
        if (sql.op === "SELECT") {
          const l = local("row");
          w.line(`Row ${l} = sql.select(`);
          w.ind += 2;
          w.line(`${JSON.stringify(text)}${params.length ? "," : ");"}`);
          if (params.length) w.line(`${params.join(", ")});`);
          w.ind -= 2;
          w.line(`sqlcode = ${l}.sqlcode();`);
          w.line(`if (${l}.found()) {`);
          w.ind++;
          emitFetchInto(sql.into, l);
          w.ind--;
          w.line("}");
        } else if (sql.op === "OPEN" || sql.op === "CLOSE" || sql.op === "FETCH") {
          const c = sql.cursor ?? "CURSOR";
          const cur = cursors.get(c) ?? { field: "cursor" + c.split(/[-_]/).filter((x) => x !== "C").map((x) => x[0] + x.slice(1).toLowerCase()).join(""), constName: "QUERY_" + c.replace(/-/g, "_") };
          cursors.set(c, cur);
          if (sql.op === "OPEN") {
            w.line(`${cur.field} = sql.open(${cur.constName});`);
            w.line("sqlcode = 0;");
          } else if (sql.op === "CLOSE") {
            w.line(`${cur.field}.close();`);
            w.line("sqlcode = 0;");
          } else {
            const l = local("row");
            w.line(`Row ${l} = ${cur.field}.next();`);
            w.line(`sqlcode = ${l}.sqlcode();`);
            w.line(`if (${l}.found()) {`);
            w.ind++;
            emitFetchInto(sql.into, l);
            w.ind--;
            w.line("}");
          }
        } else if (sql.op === "INCLUDE" || sql.op === "DECLARE") {
          w.line("// (declaration, nothing to execute)");
        } else {
          w.line(`sqlcode = sql.execute(`);
          w.ind += 2;
          w.line(`${JSON.stringify(text)}${params.length ? "," : ");"}`);
          if (params.length) w.line(`${params.join(", ")});`);
          w.ind -= 2;
        }
        break;
      }
      case "todo":
        w.line(`// TODO MIGRATE BY HAND (COBOL line ${s.o.line}): ${s.text}`);
        if (s.blocking) w.line(`throw new UnsupportedOperationException(${JSON.stringify(`${s.construct}, line ${s.o.line}`)});`);
        break;
      case "noop":
        if (s.text === "CONTINUE") w.line("// CONTINUE");
        break;
    }
    if (!s.o.file) mapping.push({ stmtId: s.o.id, cobolStart: s.o.line, cobolEnd: s.o.endLine, javaStart: start, javaEnd: w.n });
  };

  // ---------- method bodies ----------
  w.ind = 1;
  const lastEntry = jp.entry[jp.entry.length - 1];
  const paramGroups = jp.params.map((p) => jp.groups.find((g) => g.cobol === p) ?? null);
  // run()
  const execStart = w.n;
  const sig = jp.params
    .map((p, i) => {
      const g = paramGroups[i];
      if (g) return `${g.cls} ${g.varName}`;
      const f = fieldOf(p);
      return `${f?.isNum ? "BigDecimal" : "String"} ${f?.name ?? p}`;
    })
    .join(", ");
  const bodyStart = w.n;
  const methodsWriter: string[] = [];
  // Paragraphs are rendered first to know whether ProgramExit is needed.
  const methodBlocks: { lines: string[]; maps: LineMap[] }[] = [];
  for (const p of jp.paragraphs) {
    const sub = new Writer();
    const saveLines = w.lines;
    const saveMapLen = mapping.length;
    w.lines = sub.lines;
    w.ind = 1;
    localCounter = new Map();
    w.line("");
    if (p.dead) {
      w.line(`// ${p.cobol} (COBOL line ${p.line}): never called, not converted (dead code).`);
      if (p.comment) w.line(`// ${sentence(p.comment)}`);
    } else {
      w.line(`/** ${p.cobol}${p.comment ? " — " + sentence(p.comment) : ""} */`);
      w.line(`private void ${p.method}() {`);
      w.ind++;
      p.body.forEach((s, i) => emit(s, p.method === lastEntry && i === p.body.length - 1 && s.k === "exit"));
      w.ind--;
      w.line("}");
    }
    methodBlocks.push({ lines: sub.lines, maps: mapping.splice(saveMapLen) });
    w.lines = saveLines;
  }
  void execStart;
  void bodyStart;
  void methodsWriter;

  // ---------- class header ----------
  const h = new Writer();
  const title = prog.title ? sentence(prog.title) : jp.className;
  h.line(`// ${jp.className}.java`);
  h.line(`// Converted by Mue from ${prog.file}${prog.author ? ` (original author: ${prog.author}${prog.dateWritten ? ", " + prog.dateWritten : ""})` : ""}.`);
  h.line("// Do not edit without re-running the equivalence check.");
  h.line(`package ${jp.conventions.package};`);
  h.line("");
  h.line("import java.math.BigDecimal;");
  if (usesMc) h.line("import java.math.MathContext;");
  if (usesRounding || usesMc) h.line("import java.math.RoundingMode;");
  h.line("import mue.runtime.Pic;");
  if (usesSql) h.line("import mue.runtime.Sql;");
  if (usesSql && cursors.size) h.line("import mue.runtime.Sql.Cursor;");
  if (usesSql) h.line("import mue.runtime.Sql.Row;");
  if (usesExternal) h.line("import mue.runtime.ExternalPrograms;");
  if (usesExit) h.line("import mue.runtime.ProgramExit;");
  if (usesEnv) h.line("import mue.runtime.Environment;");
  h.line("");
  h.line("/**");
  h.line(` * ${title}.`);
  if (opts.summary) for (const l of wrap(opts.summary, 90)) h.line(` * ${l}`);
  h.line(` * <p>Original COBOL program: ${prog.id}.</p>`);
  h.line(" */");
  h.line(`public class ${jp.className} {`);
  h.ind = 1;
  if (usesMc) {
    h.line("");
    h.line("/** Precision of divisions: 34 significant digits. */");
    h.line("private static final MathContext MC = MathContext.DECIMAL128;");
  }
  // Constants
  const consts = [...jp.fields.values()].filter((f) => f.constant);
  if (consts.length) h.line("");
  for (const f of consts) {
    if (f.comment) h.line(`/** ${sentence(f.comment)} */`);
    h.line(`private static final BigDecimal ${f.name} = ${f.init};   // ${f.cobol} PIC ${f.pic?.raw}`);
  }
  if (picConsts.size) {
    h.line("");
    h.line("// Formats of the original fields: number of digits, decimals, sign.");
    for (const [name, pic] of [...picConsts].sort()) h.line(`private static final Pic ${name} = Pic.of("${pic.raw}");`);
  }
  for (const [c, cur] of cursors) {
    const decl = prog.sqlDeclarations.find((d) => d.cursor === c);
    const q = decl ? decl.text.replace(/^\s*DECLARE\s+\S+\s+CURSOR\s+(WITH\s+HOLD\s+)?FOR\s+/i, "").replace(/\s+/g, " ").trim() : "";
    h.line("");
    h.line(`private static final String ${cur.constName} =`);
    h.line(`        ${JSON.stringify(q)};`);
  }
  // Fields
  h.line("");
  const tops = [...jp.fields.values()].filter((f) => !f.owner && !f.constant && f.cobol !== "SQLCODE");
  for (const f of tops) {
    if (f.comment) h.line(`/** ${sentence(f.comment)} */`);
    const type = f.isNum ? "BigDecimal" : "String";
    const init = f.occurs ? (f.isNum ? `Pic.zeros(${f.occurs})` : `Pic.blanks(${f.occurs})`) : f.init;
    h.line(`private ${type}${f.occurs ? "[]" : ""} ${f.name} = ${init};   // ${f.cobol}${f.pic ? " PIC " + f.pic.raw : ""}`);
  }
  if (jp.fields.has("SQLCODE")) h.line("private int sqlcode;   // SQLCODE (SQLCA)");
  for (const [, cur] of cursors) h.line(`private Cursor ${cur.field};`);
  for (const g of jp.groups) {
    if (g.isParam) h.line(`private ${g.cls} ${g.varName};   // ${g.cobol} (area received from the caller)`);
    else h.line(`private final ${g.cls} ${g.varName} = new ${g.cls}();   // ${g.cobol}`);
  }
  if (usesSql) h.line("private final Sql sql = Sql.connect();");
  if (usesExternal) h.line("private final ExternalPrograms external = ExternalPrograms.defaults();");
  for (const [pgm, inst] of instances) {
    const cls = others.get(pgm)?.className ?? pgm;
    h.line(`private final ${cls} ${inst} = new ${cls}();   // CALL '${pgm}'`);
  }
  // Level-88 conditions on standalone fields
  for (const it of prog.items) {
    if (it.children.length || !it.conditions.length) continue;
    const f = fieldOf(it.name);
    if (!f) continue;
    for (const c of it.conditions) {
      const m = `is${capFirst(conditionMethod(c.name))}`;
      const vals = c.values.map((v) => (v.kind === "str" ? JSON.stringify(v.value) : v.kind === "num" ? `new BigDecimal("${v.value}")` : '""'));
      h.line("");
      h.line(`/** Condition ${c.name}. */`);
      h.line(`private boolean ${m}() {`);
      h.ind++;
      h.line(`return ${vals.map((v) => (f.isNum ? `${f.path}.compareTo(${v}) == 0` : `${f.path}.equals(${v})`)).join(" || ") || "false"};`);
      h.ind--;
      h.line("}");
    }
  }
  // Nested classes (group items local to the program)
  for (const g of jp.groups.filter((x) => !x.copybook)) {
    h.line("");
    renderGroupClass(h, g, true);
  }
  // run()
  h.line("");
  h.line("/** Entry point: equivalent to calling the COBOL program. */");
  h.line(`public void run(${sig}) {`);
  h.ind++;
  jp.params.forEach((p, i) => {
    const g = paramGroups[i];
    const n = g ? g.varName : fieldOf(p)?.name ?? p;
    h.line(`this.${n} = ${n};`);
  });
  if (usesExit) {
    h.line("try {");
    h.ind++;
  }
  for (const m of jp.entry) h.line(`${m}();`);
  if (usesExit) {
    h.ind--;
    h.line("} catch (ProgramExit exit) {");
    h.line("    // GOBACK / STOP RUN");
    h.line("}");
  }
  h.ind--;
  h.line("}");

  // Assembly and offset of the line mapping
  const lines = [...h.lines];
  const finalMap: LineMap[] = [];
  for (const b of methodBlocks) {
    const offset = lines.length;
    lines.push(...b.lines);
    for (const m of b.maps) finalMap.push({ ...m, javaStart: m.javaStart + offset, javaEnd: m.javaEnd + offset });
  }
  lines.push("}");
  lines.push("");

  const files: JavaFile[] = [{ name: `${jp.className}.java`, content: lines.join("\n"), kind: "main" }];
  for (const g of jp.groups.filter((x) => x.copybook)) {
    const r = new Writer();
    r.line(`// ${g.cls}.java`);
    r.line(`// Converted by Mue from copybook ${g.copybook}, shared between programs.`);
    r.line(`package ${jp.conventions.package};`);
    r.line("");
    r.line("import java.math.BigDecimal;");
    r.line("");
    renderGroupClass(r, g, false);
    files.push({ name: `${g.cls}.java`, content: r.lines.join("\n") + "\n", kind: "record" });
  }
  files.push(...runtimeFiles({ sql: usesSql, external: usesExternal, exit: usesExit, env: usesEnv }));
  return { files, mapping: finalMap };
}

/** Fields read by an IR expression. */
function fieldRefs(e: JExpr, out: string[] = []): string[] {
  switch (e.k) {
    case "field":
      out.push(e.f);
      if (e.sub) fieldRefs(e.sub, out);
      break;
    case "op":
      fieldRefs(e.a, out);
      fieldRefs(e.b, out);
      break;
    case "neg":
    case "digits":
    case "parse":
      fieldRefs(e.e, out);
      break;
    case "func":
      e.args.forEach((a) => fieldRefs(a, out));
      break;
  }
  return out;
}

function capFirst(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function renderGroupClass(w: Writer, g: JGroup, nested: boolean) {
  if (g.comment) w.line(`/** ${sentence(g.comment)} (${g.cobol}) */`);
  else w.line(`/** Group ${g.cobol}${g.copybook ? ` (copybook ${g.copybook})` : ""}. */`);
  w.line(`public ${nested ? "static " : ""}class ${g.cls} {`);
  w.ind++;
  const used = new Set<string>();
  for (const f of g.fields) {
    used.add(f.name);
    if (f.comment) w.line(`/** ${sentence(f.comment)} */`);
    const type = f.isNum ? "BigDecimal" : "String";
    const init = f.occurs ? (f.isNum ? `Pic.zeros(${f.occurs})` : `Pic.blanks(${f.occurs})`) : f.init;
    w.line(`public ${type}${f.occurs ? "[]" : ""} ${f.name} = ${init};   // ${f.cobol}${f.pic ? " PIC " + f.pic.raw : ""}`);
  }
  for (const c of g.conditions) {
    const f = g.fields.find((x) => x.cobol === c.field);
    if (!f) continue;
    const m = uniq(c.method, used);
    const vals = c.values.map((v) => (v.num ? `${f.name}.compareTo(new BigDecimal("${v.v}")) == 0` : `${f.name}.equals(${JSON.stringify(v.v.replace(/\s+$/, ""))})`));
    w.line("");
    w.line(`/** ${c.name} */`);
    w.line(`public boolean ${m}() {`);
    w.ind++;
    w.line(`return ${vals.join(" || ") || "false"};`);
    w.ind--;
    w.line("}");
  }
  w.ind--;
  w.line("}");
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > width) {
      out.push(cur.trim());
      cur = w;
    } else cur += " " + w;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Runtime files shipped next to the converted code (plain Java, no dependency). */
export function runtimeFiles(uses: { sql: boolean; external: boolean; exit: boolean; env: boolean }): JavaFile[] {
  const files: JavaFile[] = [{ name: "Pic.java", content: PIC_RUNTIME, kind: "runtime" }];
  if (uses.sql) files.push({ name: "Sql.java", content: SQL_RUNTIME, kind: "runtime" });
  if (uses.external) files.push({ name: "ExternalPrograms.java", content: EXTERNAL_RUNTIME, kind: "runtime" });
  if (uses.exit) files.push({ name: "ProgramExit.java", content: EXIT_RUNTIME, kind: "runtime" });
  if (uses.env) files.push({ name: "Environment.java", content: ENV_RUNTIME, kind: "runtime" });
  return files;
}

const PIC_RUNTIME = `// Pic.java — Mue runtime library (shipped with the converted code).
// Reproduces the COBOL rules for storing a value into a PIC field: decimals, sign,
// high-order digits. Plain Java, no dependency.
package mue.runtime;

import java.math.BigDecimal;
import java.math.RoundingMode;

public final class Pic {
    public final int intDigits;
    public final int scale;
    public final boolean signed;

    private Pic(int intDigits, int scale, boolean signed) {
        this.intDigits = intDigits;
        this.scale = scale;
        this.signed = signed;
    }

    /** Describes a numeric COBOL PIC, for example "S9(9)V99". */
    public static Pic of(String picture) {
        String x = picture.toUpperCase();
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < x.length(); i++) {
            char c = x.charAt(i);
            if (c == '(') {
                int end = x.indexOf(')', i);
                int n = Integer.parseInt(x.substring(i + 1, end));
                b.append(String.valueOf(b.charAt(b.length() - 1)).repeat(n - 1));
                i = end;
            } else {
                b.append(c);
            }
        }
        String s = b.toString();
        boolean signed = s.startsWith("S");
        String body = s.replace("S", "");
        int v = body.indexOf('V');
        int intDigits = v < 0 ? body.length() : v;
        int scale = v < 0 ? 0 : body.length() - v - 1;
        return new Pic(intDigits, scale, signed);
    }

    /** Store without ROUNDED: decimals are truncated. */
    public static BigDecimal store(BigDecimal value, Pic pic) {
        return store(value, pic, RoundingMode.DOWN);
    }

    /** COBOL store: decimals, sign lost on an unsigned PIC, high-order digits truncated. */
    public static BigDecimal store(BigDecimal value, Pic pic, RoundingMode mode) {
        BigDecimal x = value.setScale(pic.scale, mode);
        if (!pic.signed) x = x.abs();
        BigDecimal limit = BigDecimal.TEN.pow(pic.intDigits);
        if (x.abs().compareTo(limit) >= 0) {
            x = x.remainder(limit);
        }
        return x;
    }

    /** True when the value does not fit in the field (ON SIZE ERROR). */
    public static boolean overflows(BigDecimal value, Pic pic, RoundingMode mode) {
        BigDecimal x = value.setScale(pic.scale, mode);
        return x.abs().compareTo(BigDecimal.TEN.pow(pic.intDigits)) >= 0;
    }

    /** Console rendering of a numeric field (DISPLAY). */
    public static String display(BigDecimal value, Pic pic) {
        return value.setScale(pic.scale, RoundingMode.DOWN).toPlainString();
    }

    /** Renders an alphanumeric field over its COBOL length. */
    public static String pad(String value, int length) {
        return String.format("%-" + length + "s", value);
    }

    /** Numeric to alphanumeric MOVE: digits without sign or decimal point. */
    public static String digits(BigDecimal value, Pic pic) {
        String d = value.abs().setScale(pic.scale, RoundingMode.DOWN).toPlainString().replace(".", "");
        int width = pic.intDigits + pic.scale;
        String z = "0".repeat(Math.max(0, width - d.length())) + d;
        return z.substring(z.length() - width);
    }

    public static String digits(BigDecimal value) {
        return value.abs().toPlainString().replace(".", "");
    }

    public static BigDecimal parse(String text) {
        String t = text.trim();
        return t.matches("[+-]?\\\\d+(\\\\.\\\\d+)?") ? new BigDecimal(t) : BigDecimal.ZERO;
    }

    public static String truncate(String text, int length) {
        return text.length() <= length ? text : text.substring(0, length).stripTrailing();
    }

    public static boolean isNumeric(String text, int length) {
        return String.format("%-" + length + "s", text).chars().allMatch(Character::isDigit);
    }

    /** Intrinsic functions without a direct BigDecimal equivalent (MOD, REM). */
    public static BigDecimal intrinsic(String name, BigDecimal a, BigDecimal b) {
        switch (name) {
            case "MOD": return a.subtract(b.multiply(new BigDecimal(a.divide(b, 0, RoundingMode.FLOOR).toBigInteger())));
            case "REM": return a.subtract(b.multiply(new BigDecimal(a.divide(b, 0, RoundingMode.DOWN).toBigInteger())));
            default: throw new UnsupportedOperationException("FUNCTION " + name);
        }
    }

    public static BigDecimal[] zeros(int n) {
        BigDecimal[] t = new BigDecimal[n];
        java.util.Arrays.fill(t, BigDecimal.ZERO);
        return t;
    }

    public static String[] blanks(int n) {
        String[] t = new String[n];
        java.util.Arrays.fill(t, "");
        return t;
    }
}
`;

const SQL_RUNTIME = `// Sql.java — Mue runtime: the database boundary of the converted code.
// Provide an implementation (for example on top of JDBC) with Sql.install(...).
package mue.runtime;

import java.math.BigDecimal;

public abstract class Sql {
    private static Sql current;

    /** Installs the implementation used by converted programs. */
    public static void install(Sql implementation) {
        current = implementation;
    }

    public static Sql connect() {
        if (current == null) throw new IllegalStateException("No Sql implementation installed (see Sql.install)");
        return current;
    }

    /** SELECT ... INTO: one row or SQLCODE 100. */
    public abstract Row select(String sql, Object... params);

    /** INSERT, UPDATE, DELETE: returns the SQLCODE. */
    public abstract int execute(String sql, Object... params);

    /** Opens a cursor declared with DECLARE CURSOR. */
    public abstract Cursor open(String query);

    public interface Cursor {
        Row next();
        void close();
    }

    public interface Row {
        int sqlcode();
        boolean found();
        BigDecimal decimal(int column, Pic pic);
        String text(int column, int length);
    }
}
`;

const EXTERNAL_RUNTIME = `// ExternalPrograms.java — Mue runtime: programs called but not part of the converted sources.
package mue.runtime;

public interface ExternalPrograms {
    void call(String program, Object... args);

    /** Default implementation: fails loudly, so a missing program is never silently skipped. */
    static ExternalPrograms defaults() {
        return (program, args) -> {
            throw new UnsupportedOperationException("External program not provided: " + program);
        };
    }
}
`;

const EXIT_RUNTIME = `// ProgramExit.java — Mue runtime: GOBACK / STOP RUN from inside a paragraph.
package mue.runtime;

public final class ProgramExit extends RuntimeException {
    public ProgramExit() {
        super(null, null, false, false);
    }
}
`;

const ENV_RUNTIME = `// Environment.java — Mue runtime: ACCEPT ... FROM DATE / TIME / CONSOLE.
package mue.runtime;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

public final class Environment {
    private Environment() {}

    public static String accept(String source) {
        LocalDateTime now = LocalDateTime.now();
        switch (source) {
            case "DATE": return now.format(DateTimeFormatter.ofPattern("yyMMdd"));
            case "DATE YYYYMMDD": return now.format(DateTimeFormatter.ofPattern("yyyyMMdd"));
            case "TIME": return now.format(DateTimeFormatter.ofPattern("HHmmssSS"));
            default: return "";
        }
    }
}
`;
