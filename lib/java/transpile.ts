// SPDX-License-Identifier: AGPL-3.0-only
/**
 * COBOL → Java IR transpiler. Semantic decisions (rounding mode of ROUNDED, handling of
 * overflows) come from the project conventions and from fixes applied program by
 * program.
 */
import { elementaryOf, reachability } from "../cobol/analyze";
import type { CobolProgram, Cond, DataItem, Expr, Pic, RelOp, Stmt } from "../cobol/types";
import type { Conventions, Decision, JCond, JExpr, JField, JGroup, JParagraph, JProgram, JStmt, Mode, NumTarget, Origin, Overrides } from "./ir";
import { className, commonPrefix, conditionMethod, constName, fieldName, methodName, programClassName, uniq } from "./naming";

interface Shape {
  known: boolean;
  int: number;
  scale: number;
  signed: boolean;
}

const UNKNOWN: Shape = { known: false, int: 0, scale: 0, signed: true };

function capFirst(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Builds the data part (groups → classes, elementary items → fields). */
export function buildData(prog: CobolProgram, written: Set<string>) {
  const groups: JGroup[] = [];
  const fields = new Map<string, JField>();
  const usedTop = new Set<string>(["sqlcode"]);
  const usedCls = new Set<string>([programClassName(prog.id, prog.title)]);

  const initOf = (it: DataItem): string => {
    if (it.pic?.kind === "numeric") {
      if (it.value?.kind === "num") return numLiteral(it.value.value);
      return "BigDecimal.ZERO";
    }
    if (it.value?.kind === "str") return JSON.stringify(it.value.value.replace(/\s+$/, ""));
    if (it.value?.kind === "fig" && it.value.value === "ZERO") return JSON.stringify("0".repeat(it.pic?.length ?? 1));
    return '""';
  };

  for (const root of prog.items) {
    if (root.name === "SQLCODE") {
      fields.set("SQLCODE", { cobol: "SQLCODE", name: "sqlcode", path: "sqlcode", pic: root.pic, isNum: true, length: 9, section: "WORKING-STORAGE", init: "0" });
      continue;
    }
    if (root.children.length === 0) {
      if (root.name === "FILLER") continue;
      const constant = root.section === "WORKING-STORAGE" && !!root.value && !written.has(root.name) && root.pic?.kind === "numeric";
      const name = constant ? constName(root.name) : uniq(fieldName(root.name), usedTop);
      fields.set(root.name, {
        cobol: root.name,
        name,
        path: name,
        pic: root.pic,
        isNum: root.pic?.kind === "numeric",
        length: root.pic?.length ?? 1,
        occurs: root.occurs,
        constant,
        section: root.section,
        comment: root.comment,
        init: initOf(root),
      });
      continue;
    }
    const cls = uniq(className(root.name), usedCls);
    const varName = uniq(cls[0].toLowerCase() + cls.slice(1), usedTop);
    const els = elementaryOf(prog, root.name).filter((e) => e.name !== "FILLER");
    const prefix = commonPrefix(els.map((e) => e.name));
    const used = new Set<string>();
    const g: JGroup = {
      cobol: root.name,
      cls,
      qualified: root.copybook ? cls : `${programClassName(prog.id, prog.title)}.${cls}`,
      varName,
      copybook: root.copybook,
      fields: [],
      conditions: [],
      isParam: prog.procedureUsing.includes(root.name),
      section: root.section,
      comment: root.comment,
    };
    for (const el of els) {
      const name = uniq(fieldName(el.name, prefix), used);
      const f: JField = {
        cobol: el.name,
        name,
        path: `${varName}.${name}`,
        owner: varName,
        pic: el.pic,
        isNum: el.pic?.kind === "numeric",
        length: el.pic?.length ?? 1,
        occurs: el.occurs,
        section: el.section,
        comment: el.comment,
        init: initOf(el),
      };
      g.fields.push(f);
      fields.set(el.name, f);
      for (const c of el.conditions) {
        const m = "is" + capFirst(fieldName(c.name, prefix));
        g.conditions.push({ name: c.name, method: m, field: el.name, values: c.values.map((v) => ({ v: v.kind === "fig" ? (v.value === "ZERO" ? "0" : "") : v.value, num: el.pic?.kind === "numeric" })) });
      }
    }
    groups.push(g);
  }
  return { groups, fields };
}

export function numLiteral(v: string): string {
  const n = Number(v);
  if (n === 0 && !/[1-9]/.test(v)) return "BigDecimal.ZERO";
  if (v === "1") return "BigDecimal.ONE";
  if (v === "10") return "BigDecimal.TEN";
  return `new BigDecimal("${v}")`;
}

export function writtenFields(prog: CobolProgram): Set<string> {
  const w = new Set<string>();
  const add = (n: string) => elementaryOf(prog, n).forEach((e) => w.add(e.name));
  const walk = (stmts: Stmt[] | undefined) => {
    if (!stmts) return;
    for (const s of stmts) {
      switch (s.kind) {
        case "move":
          s.to.forEach((r) => add(r.name));
          break;
        case "compute":
          s.targets.forEach((t) => add(t.ref.name));
          if (s.remainder) add(s.remainder.ref.name);
          walk(s.onSize);
          walk(s.notOnSize);
          break;
        case "if":
          walk(s.then);
          walk(s.else);
          break;
        case "evaluate":
          s.whens.forEach((x) => walk(x.body));
          walk(s.other);
          break;
        case "perform":
          if (s.varying) add(s.varying.ref.name);
          walk(s.body);
          break;
        case "call":
          s.using.forEach((u) => u.ref.k === "ref" && u.mode === "REFERENCE" && add(u.ref.name));
          walk(s.onException);
          break;
        case "accept":
          add(s.ref.name);
          break;
        case "initialize":
          s.refs.forEach((r) => add(r.name));
          break;
        case "set":
          if (s.mode === "true") s.names.forEach((n) => add(prog.fields.get(n)?.parent ?? n));
          else s.refs.forEach((r) => add(r.name));
          break;
        case "sql":
          s.sql.into.forEach(add);
          break;
      }
    }
  };
  prog.paragraphs.forEach((p) => walk(p.stmts));
  return w;
}

export interface TranspileContext {
  system: Map<string, CobolProgram>;
  conventions: Conventions;
  overrides?: Overrides;
}

export function transpile(prog: CobolProgram, ctx: TranspileContext): JProgram {
  const conv: Conventions = { ...ctx.conventions, ...(ctx.overrides ?? {}) };
  const written = writtenFields(prog);
  const { groups, fields } = buildData(prog, written);
  const decisions: Decision[] = [];
  const todos: JProgram["todos"] = [];
  const { reachable } = reachability(prog);
  const usedMethods = new Set<string>(["run"]);
  const methodOf = new Map<string, string>();
  prog.paragraphs.forEach((p) => methodOf.set(p.name, uniq(methodName(p.name), usedMethods)));
  const clsName = programClassName(prog.id, prog.title);
  const roundingSource: Decision["source"] = ctx.overrides?.rounding ? "correction" : "convention";
  const overflowSource: Decision["source"] = ctx.overrides?.overflow ? "correction" : "convention";

  const condCall = (name: string): { call: string; field: string; values: { v: string; num: boolean }[]; ranges: { lo: string; hi: string; num: boolean }[] } | null => {
    const cn = prog.fields.get(name);
    const parentName = cn?.parent;
    const parent = parentName ? prog.fields.get(parentName) : undefined;
    const def = parent?.conditions.find((c) => c.name === name);
    if (!parent || !def) return null;
    const num = parent.pic?.kind === "numeric";
    const values = def.values.map((v) => ({ v: v.kind === "fig" ? (v.value === "ZERO" ? "0" : "") : v.value, num }));
    const ranges = def.ranges.map(([lo, hi]) => ({ lo: lo.kind === "fig" ? "0" : lo.value, hi: hi.kind === "fig" ? "0" : hi.value, num }));
    const jf = fields.get(parent.name);
    const g = groups.find((x) => x.conditions.some((c) => c.name === name));
    const call = g ? `${g.varName}.${g.conditions.find((c) => c.name === name)!.method}()` : `is${capFirst(conditionMethod(name))}()`;
    return { call, field: jf?.cobol ?? parent.name, values, ranges };
  };

  const fieldPic = (name: string): Pic | undefined => prog.fields.get(name)?.pic;
  const isNumField = (name: string) => prog.fields.get(name)?.pic?.kind === "numeric";

  // ---------- expressions ----------
  const typeOf = (e: Expr): "num" | "str" | "any" => {
    switch (e.k) {
      case "num":
        return "num";
      case "str":
        return "str";
      case "fig":
        return "any";
      case "ref":
        return isNumField(e.name) ? "num" : "str";
      default:
        return "num";
    }
  };

  const shapeOf = (e: Expr): Shape => {
    switch (e.k) {
      case "num": {
        const v = e.v.replace(/^-/, "");
        const [i, f = ""] = v.split(".");
        return { known: true, int: i.replace(/^0+/, "").length, scale: f.length, signed: e.v.startsWith("-") };
      }
      case "fig":
        return { known: true, int: 0, scale: 0, signed: false };
      case "ref": {
        const p = fieldPic(e.name);
        if (!p || p.kind !== "numeric") return UNKNOWN;
        return { known: true, int: p.intDigits, scale: p.scale, signed: p.signed };
      }
      case "neg": {
        const s = shapeOf(e.e);
        return { ...s, signed: true };
      }
      case "bin": {
        const a = shapeOf(e.l);
        const b = shapeOf(e.r);
        if (!a.known || !b.known) return UNKNOWN;
        if (e.op === "+" || e.op === "-") return { known: true, int: Math.max(a.int, b.int) + 1, scale: Math.max(a.scale, b.scale), signed: e.op === "-" || a.signed || b.signed };
        if (e.op === "*") return { known: true, int: a.int + b.int, scale: a.scale + b.scale, signed: a.signed || b.signed };
        return UNKNOWN;
      }
      default:
        return UNKNOWN;
    }
  };

  const numExpr = (e: Expr): JExpr => {
    switch (e.k) {
      case "num":
        return { k: "num", v: e.v };
      case "fig":
        return { k: "num", v: "0" };
      case "str":
        return { k: "parse", e: { k: "str", v: e.v } };
      case "ref": {
        const sub = e.sub ? numExpr(e.sub) : undefined;
        if (isNumField(e.name)) return { k: "field", f: e.name, sub };
        return { k: "parse", e: { k: "field", f: e.name, sub } };
      }
      case "neg":
        return { k: "neg", e: numExpr(e.e) };
      case "bin": {
        const op = ({ "+": "add", "-": "sub", "*": "mul", "/": "div", "**": "pow" } as const)[e.op];
        return { k: "op", op, a: numExpr(e.l), b: numExpr(e.r) };
      }
      case "func":
        return { k: "func", name: e.name, args: e.args.map(numExpr) };
    }
  };

  const strExpr = (e: Expr, len: number): JExpr => {
    switch (e.k) {
      case "str":
        return { k: "str", v: e.v };
      case "fig":
        return e.v === "ZERO" ? { k: "fill", ch: "0", len } : e.v === "SPACE" ? { k: "str", v: "" } : { k: "fill", ch: e.v === "QUOTE" ? '"' : e.v === "HIGH-VALUE" ? "￿" : "\u0000", len };
      case "ref":
        if (isNumField(e.name)) return { k: "digits", e: { k: "field", f: e.name, sub: e.sub ? numExpr(e.sub) : undefined }, pic: fieldPic(e.name) };
        return { k: "field", f: e.name, sub: e.sub ? numExpr(e.sub) : undefined };
      case "num":
        return { k: "str", v: e.v.replace(/^-/, "") };
      default:
        return { k: "digits", e: numExpr(e) };
    }
  };

  // ---------- conditions ----------
  const negate = (c: JCond): JCond => {
    switch (c.k) {
      case "cmpNum":
      case "cmpStr":
        return { ...c, op: ({ "=": "<>", "<>": "=", ">": "<=", "<": ">=", ">=": "<", "<=": ">" } as const)[c.op] };
      case "and":
        return { k: "or", a: negate(c.a), b: negate(c.b) };
      case "or":
        return { k: "and", a: negate(c.a), b: negate(c.b) };
      case "not":
        return c.c;
      default:
        return { k: "not", c };
    }
  };

  const relation = (op: RelOp, l: Expr, r: Expr): JCond => {
    const tl = typeOf(l);
    const tr = typeOf(r);
    const numeric = tl === "num" || tr === "num" ? !(tl === "str" && r.k === "fig" && r.v !== "ZERO") : false;
    if (numeric || (tl === "any" && tr === "any")) return { k: "cmpNum", op, a: numExpr(l), b: numExpr(r) };
    const len = Math.max(l.k === "ref" ? fieldPic(l.name)?.length ?? 1 : 1, r.k === "ref" ? fieldPic(r.name)?.length ?? 1 : 1);
    return { k: "cmpStr", op, a: strExpr(l, len), b: strExpr(r, len) };
  };

  const cond = (c: Cond): JCond => {
    switch (c.k) {
      case "and":
        return { k: "and", a: cond(c.a), b: cond(c.b) };
      case "or":
        return { k: "or", a: cond(c.a), b: cond(c.b) };
      case "not":
        return negate(cond(c.c));
      case "rel":
        return relation(c.op, c.l, c.r);
      case "cname": {
        const cc = condCall(c.name);
        if (!cc) return { k: "cmpNum", op: "=", a: { k: "num", v: "0" }, b: { k: "num", v: "1" } };
        return { k: "cond88", cobol: c.name, ...cc };
      }
      case "sign": {
        const r: JCond = { k: "cmpNum", op: c.sign === "POSITIVE" ? ">" : c.sign === "NEGATIVE" ? "<" : "=", a: numExpr(c.e), b: { k: "num", v: "0" } };
        return c.neg ? negate(r) : r;
      }
      case "class":
        if (c.cls === "NUMERIC") return { k: "isNumeric", e: c.e.k === "ref" && !isNumField(c.e.name) ? { k: "field", f: c.e.name } : numExpr(c.e), neg: c.neg };
        return { k: "isNumeric", e: numExpr(c.e), neg: !c.neg };
    }
  };

  // ---------- assignments ----------
  const origin = (s: Stmt): Origin => ({ id: s.id, line: s.line, endLine: s.endLine, file: s.file, comment: s.comment, program: prog.id });

  const numTarget = (s: Stmt, ref: Expr & { k: "ref" }, e: Expr, rounded: boolean, verbText: string): NumTarget => {
    const pic = fieldPic(ref.name)!;
    const sh = shapeOf(e);
    const scaleIssue = !sh.known || sh.scale > pic.scale;
    const overflowIssue = !sh.known || sh.int > pic.intDigits || (sh.signed && !pic.signed);
    const sub = ref.sub ? numExpr(ref.sub) : undefined;
    if (!scaleIssue && !overflowIssue) return { f: ref.name, sub, e: numExpr(e), fit: null, rounded };
    let mode: Mode = "DOWN";
    let decision: string | undefined;
    if (rounded && scaleIssue) {
      mode = conv.rounding;
      decision = `rounding:${s.id}:${ref.name}`;
      decisions.push({
        id: decision,
        kind: "rounding",
        stmtId: s.id,
        line: s.line,
        cobol: `${verbText} ${ref.name} ROUNDED`,
        choice: mode,
        cobolSemantics: "HALF_UP",
        matchesCobol: mode === "HALF_UP",
        source: roundingSource,
      });
    }
    if (overflowIssue && conv.overflow === "ignore") {
      decisions.push({
        id: `overflow:${s.id}:${ref.name}`,
        kind: "overflow",
        stmtId: s.id,
        line: s.line,
        cobol: `${verbText} ${ref.name} (PIC ${pic.raw})`,
        choice: "ignore",
        cobolSemantics: "reproduce",
        matchesCobol: false,
        source: overflowSource,
      });
    }
    return { f: ref.name, sub, e: numExpr(e), fit: { mode, overflow: conv.overflow }, rounded, decision };
  };

  const moveTo = (s: Stmt, ref: Expr & { k: "ref" }, src: Expr, note?: string): JStmt[] => {
    const o = origin(s);
    const target = prog.fields.get(ref.name);
    if (target && target.children.length > 0) {
      const tEls = elementaryOf(prog, ref.name).filter((e) => e.name !== "FILLER");
      if (src.k === "ref" && prog.fields.get(src.name)?.children.length) {
        const sEls = elementaryOf(prog, src.name).filter((e) => e.name !== "FILLER");
        if (sEls.length !== tEls.length) return [{ o, k: "todo", construct: "Group MOVE", text: `MOVE ${src.name} TO ${ref.name}: different structures`, blocking: true }];
        return tEls.flatMap((el, k) => moveTo(s, { k: "ref", name: el.name }, { k: "ref", name: sEls[k].name }));
      }
      return tEls.flatMap((el) => moveTo(s, { k: "ref", name: el.name }, src));
    }
    if (!target) return [{ o, k: "todo", construct: "Unknown data item", text: `${ref.name} is not declared (missing copybook?)`, blocking: true }];
    const sub = ref.sub ? numExpr(ref.sub) : undefined;
    if (target.pic?.kind === "numeric") {
      if (src.k === "ref" && prog.fields.get(src.name)?.children.length) return [{ o, k: "todo", construct: "Group to numeric MOVE", text: `MOVE ${src.name} TO ${ref.name}`, blocking: true }];
      const t = numTarget(s, ref, src.k === "str" ? { k: "str", v: src.v } : src, false, "MOVE");
      return [{ o, k: "setNum", targets: [t], note }];
    }
    return [{ o, k: "setStr", f: ref.name, sub, e: strExpr(src, target.pic?.length ?? 1), note }];
  };

  const convertStmts = (stmts: Stmt[] | undefined): JStmt[] => (stmts ?? []).flatMap(convert);

  const performBody = (s: Stmt & { kind: "perform" }): JStmt[] => {
    if (s.target) {
      const a = prog.paragraphs.findIndex((p) => p.name === s.target!.from);
      const b = s.target.thru ? prog.paragraphs.findIndex((p) => p.name === s.target!.thru) : a;
      if (a < 0 || b < 0) return [{ o: origin(s), k: "todo", construct: "PERFORM", text: `Paragraph not found: ${s.target.from}`, blocking: true }];
      const paras = prog.paragraphs.slice(a, b + 1).map((p) => p.name);
      return [{ o: origin(s), k: "perform", methods: paras.map((p) => methodOf.get(p)!), paragraphs: paras }];
    }
    return convertStmts(s.body);
  };

  const convert = (s: Stmt): JStmt[] => {
    const o = origin(s);
    switch (s.kind) {
      case "move":
        return s.to.flatMap((t) => moveTo(s, t, s.src));
      case "compute": {
        const targets: NumTarget[] = [];
        const extra: JStmt[] = [];
        s.targets.forEach((t, i) => {
          const f = prog.fields.get(t.ref.name);
          if (!f || f.pic?.kind !== "numeric") {
            extra.push({ o, k: "todo", construct: s.verb, text: `${s.verb} into a non-numeric field ${t.ref.name}`, blocking: true });
            return;
          }
          targets.push(numTarget(s, t.ref, s.exprs[i], t.rounded, s.verb));
        });
        if (s.remainder) {
          const rem: Expr = { k: "bin", op: "-", l: s.remainder.dividend, r: { k: "bin", op: "*", l: s.targets[0].ref, r: s.remainder.divisor } };
          targets.push({ ...numTarget(s, s.remainder.ref, rem, false, "DIVIDE REMAINDER"), afterStore: true });
        }
        const sizeError = s.onSize || s.notOnSize ? { on: s.onSize ? convertStmts(s.onSize) : undefined, not: s.notOnSize ? convertStmts(s.notOnSize) : undefined } : undefined;
        if (sizeError) for (const t of targets) if (!t.fit) t.fit = { mode: "DOWN", overflow: "reproduce" };
        return [{ o, k: "setNum", targets, sizeError }, ...extra];
      }
      case "if":
        return [{ o, k: "if", c: cond(s.cond), then: convertStmts(s.then), else: s.else ? convertStmts(s.else) : undefined }];
      case "evaluate": {
        if (s.subject === "TRUE" || s.subject === "FALSE") {
          const neg = s.subject === "FALSE";
          return [
            {
              o,
              k: "chain",
              cases: s.whens.map((w) => {
                const cs = w.objs.map((ob): JCond => (ob.kind === "cond" ? (neg ? negate(cond(ob.c)) : cond(ob.c)) : { k: "cmpNum", op: "=", a: { k: "num", v: "0" }, b: { k: "num", v: "0" } }));
                return { c: cs.reduce((a, b) => ({ k: "or", a, b })), body: convertStmts(w.body) };
              }),
              other: s.other ? convertStmts(s.other) : undefined,
            },
          ];
        }
        const subj = s.subject;
        const simpleStr = typeOf(subj) === "str" && s.whens.every((w) => w.objs.every((ob) => ob.kind === "value" && ob.v.k === "str" && !ob.thru && !ob.not));
        if (simpleStr) {
          return [
            {
              o,
              k: "switchStr",
              subject: strExpr(subj, 1),
              cases: s.whens.map((w) => ({ values: w.objs.map((ob) => (ob.kind === "value" && ob.v.k === "str" ? ob.v.v.replace(/\s+$/, "") : "")), body: convertStmts(w.body) })),
              other: s.other ? convertStmts(s.other) : undefined,
            },
          ];
        }
        return [
          {
            o,
            k: "chain",
            cases: s.whens.map((w) => {
              const cs = w.objs.map((ob): JCond => {
                if (ob.kind === "any") return { k: "cmpNum", op: "=", a: { k: "num", v: "0" }, b: { k: "num", v: "0" } };
                if (ob.kind === "cond") return cond(ob.c);
                const r: JCond = ob.thru ? { k: "and", a: relation(">=", subj, ob.v), b: relation("<=", subj, ob.thru) } : relation("=", subj, ob.v);
                return ob.not ? negate(r) : r;
              });
              return { c: cs.reduce((a, b) => ({ k: "or", a, b })), body: convertStmts(w.body) };
            }),
            other: s.other ? convertStmts(s.other) : undefined,
          },
        ];
      }
      case "perform": {
        const body = performBody(s);
        if (s.varying) {
          const init = numTarget(s, s.varying.ref, s.varying.from, false, "PERFORM VARYING");
          const step = numTarget(s, s.varying.ref, { k: "bin", op: "+", l: s.varying.ref, r: s.varying.by }, false, "PERFORM VARYING");
          return [{ o, k: "varying", init: { o, k: "setNum", targets: [init] }, c: negate(cond(s.until!)), body, step: { o, k: "setNum", targets: [step] } }];
        }
        if (s.until) return [{ o, k: "while", c: negate(cond(s.until)), body, doWhile: s.testAfter }];
        if (s.times) return [{ o, k: "repeat", n: numExpr(s.times), body }];
        return s.target ? body : [{ o, k: "block", body }];
      }
      case "call": {
        if (!s.program) return [{ o, k: "todo", construct: "Dynamic CALL", text: `CALL ${s.dynamic}`, blocking: true }];
        const callee = ctx.system.get(s.program);
        return [
          {
            o,
            k: "call",
            program: s.program,
            external: !callee,
            args: s.using.map((u, i) => ({
              cobol: u.ref.k === "ref" ? u.ref.name : "",
              param: callee?.procedureUsing[i],
              mode: u.mode,
              literal: u.ref.k !== "ref" ? strExpr(u.ref, 1) : undefined,
            })),
          },
        ];
      }
      case "goto":
        return [{ o, k: "todo", construct: "GO TO", text: `GO TO ${s.targets.join(", ")}: replace with structured code (if / return)`, blocking: true }];
      case "stop":
        return [{ o, k: "exit", how: s.how }];
      case "noop":
        return [{ o, k: "noop", text: s.how }];
      case "display":
        return [
          {
            o,
            k: "print",
            parts: s.items.map((e): JExpr => {
              if (e.k === "ref") return { k: "field", f: e.name, sub: e.sub ? numExpr(e.sub) : undefined };
              if (e.k === "str") return { k: "str", v: e.v };
              if (e.k === "fig") return strExpr(e, 1);
              return numExpr(e);
            }),
          },
        ];
      case "accept":
        return [{ o, k: "setStr", f: s.ref.name, e: { k: "func", name: "ACCEPT", args: [{ k: "str", v: s.ref.name }, { k: "str", v: s.from ?? "" }] } }];
      case "initialize":
        return s.refs.flatMap((r) =>
          elementaryOf(prog, r.name)
            .filter((e) => e.name !== "FILLER")
            .map((el): JStmt => (el.pic?.kind === "numeric" ? { o, k: "setNum", targets: [{ f: el.name, e: { k: "num", v: "0" }, fit: null, rounded: false }] } : { o, k: "setStr", f: el.name, e: { k: "str", v: "" } })),
        );
      case "set":
        if (s.mode === "true") {
          return s.names.flatMap((n) => {
            const cn = prog.fields.get(n);
            const parent = cn?.parent ? prog.fields.get(cn.parent) : undefined;
            const def = parent?.conditions.find((c) => c.name === n);
            const lit = def?.values[0] ?? def?.ranges[0]?.[0];
            if (!parent || !lit) return [{ o, k: "todo", construct: "SET", text: `SET ${n} TO TRUE`, blocking: true } as JStmt];
            const src: Expr = lit.kind === "num" ? { k: "num", v: lit.value } : lit.kind === "str" ? { k: "str", v: lit.value } : { k: "fig", v: lit.value };
            return moveTo(s, { k: "ref", name: parent.name }, src, n);
          });
        }
        return s.refs.flatMap((r) => moveTo(s, r, s.value));
      case "sql":
        return [{ o, k: "sql", sql: s.sql }];
      case "unsupported":
        return [{ o, k: "todo", construct: s.verb, text: `${s.reason}: ${s.text}`, blocking: true }];
    }
  };

  const paragraphs: JParagraph[] = prog.paragraphs.map((p, i) => {
    const dead = !reachable.has(i);
    return { cobol: p.name, method: methodOf.get(p.name)!, body: dead ? [] : convertStmts(p.stmts), dead, line: p.line, comment: p.comment };
  });

  // Fall-through sequence called by run()
  const entry: string[] = [];
  for (let i = 0; i < prog.paragraphs.length; i++) {
    entry.push(paragraphs[i].method);
    const last = prog.paragraphs[i].stmts[prog.paragraphs[i].stmts.length - 1];
    if (last && (last.kind === "stop" || last.kind === "goto")) break;
  }

  const walkTodos = (stmts: JStmt[]) => {
    for (const s of stmts) {
      if (s.k === "todo") todos.push({ line: s.o.line, construct: s.construct, text: s.text, blocking: s.blocking, file: s.o.file });
      const kids: JStmt[][] = [];
      if (s.k === "if") kids.push(s.then, s.else ?? []);
      if (s.k === "switchStr") kids.push(...s.cases.map((c) => c.body), s.other ?? []);
      if (s.k === "chain") kids.push(...s.cases.map((c) => c.body), s.other ?? []);
      if (s.k === "block" || s.k === "while" || s.k === "repeat") kids.push(s.body);
      if (s.k === "varying") kids.push(s.body);
      if (s.k === "setNum" && s.sizeError) kids.push(s.sizeError.on ?? [], s.sizeError.not ?? []);
      kids.forEach(walkTodos);
    }
  };
  paragraphs.forEach((p) => walkTodos(p.body));
  // Data constructs that must be migrated by hand
  for (const m of prog.manual) {
    if (["REDEFINES", "OCCURS on a group", "RENAMES", "PIC P scaling"].includes(m.construct)) todos.push({ line: m.line, construct: m.construct, text: m.detail, blocking: true, file: m.file });
    if (m.construct === "Edited PIC") todos.push({ line: m.line, construct: m.construct, text: m.detail, blocking: false, file: m.file });
    if (m.construct === "File I/O") todos.push({ line: m.line, construct: m.construct, text: m.detail, blocking: true, file: m.file });
  }
  todos.sort((a, b) => a.line - b.line);

  return { id: prog.id, className: clsName, groups, fields, paragraphs, entry, params: prog.procedureUsing, decisions, todos, conventions: conv };
}
