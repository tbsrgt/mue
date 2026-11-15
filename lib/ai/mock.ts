// SPDX-License-Identifier: AGPL-3.0-only
/**
 * "mock" AI provider: deterministic, offline, and still genuinely useful.
 * It writes the explanations from the AST and the system analysis, produces the Java with
 * the transpiler, and explains mismatches from the divergence trace of the harness.
 */
import { walkStmts } from "../cobol/analyze";
import type { CobolProgram, Cond, DataItem, Expr, Literal, Stmt } from "../cobol/types";
import { renderJava } from "../java/render";
import { transpile } from "../java/transpile";
import { fmtInt, sentence } from "../text";
import type { AiProvider, ConvertInput, DiscrepancyExplanation, DiscrepancyInput, ExplainInput, ProgramExplanation, Rule } from "./types";

const ABBREV: Record<string, string> = {
  ACCT: "account", AMT: "amount", BAL: "balance", AVG: "average", CUST: "customer", XFER: "transfer", TXN: "transaction",
  INS: "insurance", LEN: "length", NO: "number", NUM: "number", NB: "number of", SEG: "segment", CALC: "calculation",
  // French data names, common in European shops
  CPT: "account", MT: "amount", MNT: "amount", TX: "rate", CLI: "customer", VIR: "transfer", ECH: "installment",
};
const TECH = new Set(["WS", "LK", "LS", "W", "L", "WK"]);

function nameWords(name: string): string {
  let ws = name.toUpperCase().split("-");
  while (ws.length > 1 && TECH.has(ws[0])) ws = ws.slice(1);
  return ws.map((w) => (ABBREV[w] ? ABBREV[w] : w.toLowerCase())).join(" ");
}

/** Human label of a field: its comment when there is one, otherwise its expanded name. */
function fieldLabel(prog: CobolProgram, name: string): string {
  const it = prog.fields.get(name);
  if (it?.comment) {
    const titled = it.children.length ? /^[A-Z0-9-]+\s*:\s*(.+)$/.exec(it.comment.trim()) : null;
    let c = (titled ? titled[1] : it.comment).split(/\s:\s|\s\(|\s-\s|,/)[0];
    if (c.length > 48) c = c.slice(0, 48);
    return sentence(c).toLowerCase().replace(/\s+/g, " ").trim();
  }
  return nameWords(name);
}

function numText(v: string): string {
  const neg = v.startsWith("-");
  const [i, f] = v.replace(/^-/, "").split(".");
  const int = fmtInt(Number(i));
  return (neg ? "−" : "") + (f ? `${int}.${f}` : int);
}

function litText(l: Literal): string {
  if (l.kind === "num") return numText(l.value);
  if (l.kind === "str") return `"${l.value.trim()}"`;
  return l.value === "ZERO" ? "zero" : l.value === "SPACE" ? "blank" : l.value.toLowerCase();
}

function isConstant(prog: CobolProgram, name: string, written: Set<string>) {
  const it = prog.fields.get(name);
  return !!it && !!it.value && it.section !== "LINKAGE" && !written.has(name) && it.pic?.kind === "numeric";
}

function exprText(prog: CobolProgram, e: Expr, written: Set<string>, prec = 0): string {
  switch (e.k) {
    case "num":
      return numText(e.v);
    case "str":
      return `"${e.v.trim()}"`;
    case "fig":
      return e.v === "ZERO" ? "zero" : e.v === "SPACE" ? "blank" : e.v.toLowerCase();
    case "ref": {
      const it = prog.fields.get(e.name);
      if (it && isConstant(prog, e.name, written) && it.value?.kind === "num") return `${fieldLabel(prog, e.name)} (${numText(it.value.value)})`;
      return fieldLabel(prog, e.name);
    }
    case "neg":
      return `−${exprText(prog, e.e, written, 3)}`;
    case "func":
      return `${e.name.toLowerCase()}(${e.args.map((a) => exprText(prog, a, written)).join(", ")})`;
    case "bin": {
      const p = e.op === "+" || e.op === "-" ? 1 : e.op === "**" ? 3 : 2;
      const sym = { "+": "+", "-": "−", "*": "×", "/": "÷", "**": "^" }[e.op];
      const s = e.op === "**" ? `${exprText(prog, e.l, written, 4)}^${exprText(prog, e.r, written, 4)}` : `${exprText(prog, e.l, written, p)} ${sym} ${exprText(prog, e.r, written, p + 1)}`;
      return p < prec ? `(${s})` : s;
    }
  }
}

function condText(prog: CobolProgram, c: Cond, written: Set<string>): string {
  switch (c.k) {
    case "and":
      return `${condText(prog, c.a, written)} and ${condText(prog, c.b, written)}`;
    case "or":
      return `${condText(prog, c.a, written)} or ${condText(prog, c.b, written)}`;
    case "not":
      return `not (${condText(prog, c.c, written)})`;
    case "cname":
      return condNameText(prog, c.name);
    case "sign":
      return `${exprText(prog, c.e, written)} ${c.neg ? "is not" : "is"} ${c.sign.toLowerCase()}`;
    case "class":
      return `${exprText(prog, c.e, written)} ${c.neg ? "is not" : "is"} ${c.cls === "NUMERIC" ? "numeric" : "alphabetic"}`;
    case "rel": {
      const ops: Record<string, string> = { "=": "is", "<>": "is not", ">": "is greater than", "<": "is less than", ">=": "is at least", "<=": "is at most" };
      let r = exprText(prog, c.r, written);
      // Value explained by a level 88 (e.g. 'B' = account blocked)
      if (c.l.k === "ref" && c.r.k === "str") {
        const it = prog.fields.get(c.l.name);
        const lit = (c.r as { v: string }).v;
        const cn = it?.conditions.find((x) => x.values.some((v) => v.kind === "str" && v.value === lit));
        if (cn) r += ` (${nameWords(cn.name)})`;
      }
      if (c.r.k === "fig" && c.r.v === "ZERO") {
        const z: Record<string, string> = { "=": "is zero", "<>": "is not zero", ">": "is positive", "<": "is negative", ">=": "is zero or positive", "<=": "is zero or negative" };
        return `${exprText(prog, c.l, written)} ${z[c.op]}`;
      }
      return `${exprText(prog, c.l, written)} ${ops[c.op]} ${r}`;
    }
  }
}

function condNameText(prog: CobolProgram, name: string): string {
  const cn = prog.fields.get(name);
  const parent = cn?.parent ? prog.fields.get(cn.parent) : undefined;
  const def = parent?.conditions.find((c) => c.name === name);
  const vals = def ? def.values.map(litText).join(" or ") : "";
  return `${nameWords(name)}${vals ? ` (${fieldLabel(prog, parent!.name)} = ${vals})` : ""}`;
}

function roundingText(it: DataItem | undefined, rounded: boolean): string {
  const scale = it?.pic?.scale ?? 0;
  const unit = scale === 2 ? "to the cent" : scale === 0 ? "to the unit" : `to ${scale} decimals`;
  return rounded ? `rounded ${unit}, half-cent up` : `truncated ${unit} (no rounding)`;
}

function actionText(prog: CobolProgram, s: Stmt, written: Set<string>): string | null {
  switch (s.kind) {
    case "move": {
      const tgt = s.to.map((t) => fieldLabel(prog, t.name)).join(", ");
      if (s.src.k === "ref") return `${tgt} receives ${fieldLabel(prog, s.src.name)}`;
      return `${tgt} is set to ${exprText(prog, s.src, written)}`;
    }
    case "compute": {
      const t = s.targets[0];
      if (s.verb === "ADD" && s.exprs[0].k === "bin" && s.exprs[0].l.k === "ref" && s.exprs[0].l.name === t.ref.name) return `${exprText(prog, s.exprs[0].r, written)} is added to ${fieldLabel(prog, t.ref.name)}`;
      if (s.verb === "SUBTRACT" && s.exprs[0].k === "bin" && s.exprs[0].l.k === "ref" && s.exprs[0].l.name === t.ref.name) return `${exprText(prog, s.exprs[0].r, written)} is subtracted from ${fieldLabel(prog, t.ref.name)}`;
      return `${fieldLabel(prog, t.ref.name)} = ${exprText(prog, s.exprs[0], written)}, ${roundingText(prog.fields.get(t.ref.name), t.rounded)}`;
    }
    case "set":
      if (s.mode === "true") return s.names.map((n) => condNameText(prog, n)).join(", ");
      return null;
    case "perform":
      if (s.target) return `runs ${s.target.from}`;
      return null;
    case "call":
      return `calls ${s.program ?? s.dynamic}`;
    case "sql":
      return sqlText(s.sql.op, s.sql.tables.map((t) => t.name));
    case "display":
      return "writes a line to the job log";
    case "stop":
      return "end of program";
    default:
      return null;
  }
}

function sqlText(op: string, tables: string[]) {
  const t = tables.join(", ");
  switch (op) {
    case "SELECT":
      return `reads table ${t}`;
    case "UPDATE":
      return `updates table ${t}`;
    case "INSERT":
      return `inserts a row into table ${t}`;
    case "DELETE":
      return `deletes rows from table ${t}`;
    case "FETCH":
      return "reads the next row of the cursor";
    case "OPEN":
      return "opens the cursor";
    case "CLOSE":
      return "closes the cursor";
    default:
      return `executes ${op}`;
  }
}

function summarize(prog: CobolProgram, stmts: Stmt[] | undefined, written: Set<string>): string {
  const parts = (stmts ?? [])
    .map((s) => (s.kind === "compute" && isFormula(s) ? `computes ${s.targets.map((t) => fieldLabel(prog, t.ref.name)).join(", ")} (next rule)` : s.kind === "if" ? "applies a nested test (next rule)" : actionText(prog, s, written)))
    .filter((x): x is string => !!x && x !== "end of program");
  if (!parts.length) return "nothing happens";
  return parts.slice(0, 3).join("; ") + (parts.length > 3 ? "; …" : "");
}

/** A real formula, as opposed to a simple running total or counter. */
function isFormula(s: Stmt): boolean {
  if (s.kind !== "compute") return false;
  if (s.targets.some((t) => t.rounded)) return true;
  if (s.verb === "COMPUTE" || s.verb === "MULTIPLY" || s.verb === "DIVIDE") return true;
  return false;
}

function writtenSet(prog: CobolProgram): Set<string> {
  const w = new Set<string>();
  for (const p of prog.paragraphs)
    walkStmts(p.stmts, (s) => {
      if (s.kind === "move") s.to.forEach((t) => w.add(t.name));
      if (s.kind === "compute") s.targets.forEach((t) => w.add(t.ref.name));
      if (s.kind === "sql") s.sql.into.forEach((x) => w.add(x));
      if (s.kind === "perform" && s.varying) w.add(s.varying.ref.name);
    });
  return w;
}

function extractRules(prog: CobolProgram, dead: Set<string>): Rule[] {
  const written = writtenSet(prog);
  const rules: Omit<Rule, "n">[] = [];
  const visit = (stmts: Stmt[], nested: boolean) => {
    for (const s of stmts) {
      switch (s.kind) {
        case "if":
          rules.push({
            stmtId: s.id,
            line: s.line,
            endLine: s.endLine,
            kind: "condition",
            text: `If ${condText(prog, s.cond, written)}: ${summarize(prog, s.then, written)}${s.else?.length ? `. Otherwise: ${summarize(prog, s.else, written)}` : ""}.`,
          });
          for (const x of [...s.then, ...(s.else ?? [])]) if ((x.kind === "compute" && isFormula(x)) || x.kind === "if" || x.kind === "evaluate") visit([x], true);
          break;
        case "evaluate": {
          const subj = s.subject === "TRUE" || s.subject === "FALSE" ? null : exprText(prog, s.subject, written);
          const cases = s.whens.map((w) => {
            const objs = w.objs.map((o) => (o.kind === "cond" ? condText(prog, o.c, written) : o.kind === "value" ? `${subj} ${o.not ? "≠" : "="} ${exprText(prog, o.v, written)}${o.thru ? ` to ${exprText(prog, o.thru, written)}` : ""}` : "any case"));
            return `${objs.join(" or ")} → ${summarize(prog, w.body, written)}`;
          });
          if (s.other) cases.push(`otherwise → ${summarize(prog, s.other, written)}`);
          rules.push({ stmtId: s.id, line: s.line, endLine: s.endLine, kind: "condition", text: `Depending on the case: ${cases.join("; ")}.` });
          for (const w of [...s.whens.map((x) => x.body), s.other ?? []]) for (const x of w) if ((x.kind === "compute" && isFormula(x)) || x.kind === "if") visit([x], true);
          break;
        }
        case "compute":
          if (!nested || isFormula(s)) rules.push({ stmtId: s.id, line: s.line, endLine: s.endLine, kind: "computation", text: capitalize(actionText(prog, s, written) ?? "") + "." });
          break;
        case "perform":
          if (s.varying || s.until || s.times) {
            const what = s.target ? `runs ${s.target.from}` : summarize(prog, s.body, written);
            const loop = s.varying
              ? `For ${fieldLabel(prog, s.varying.ref.name)} from ${exprText(prog, s.varying.from, written)} by ${exprText(prog, s.varying.by, written)} until ${condText(prog, s.until!, written)}`
              : s.until
                ? `While not (${condText(prog, s.until, written)})`
                : `${exprText(prog, s.times!, written)} times`;
            rules.push({ stmtId: s.id, line: s.line, endLine: s.endLine, kind: "loop", text: `${loop}: ${what}.` });
            if (s.body) visit(s.body.filter((x) => (x.kind === "compute" && isFormula(x)) || x.kind === "if" || x.kind === "evaluate"), true);
          }
          break;
        case "sql":
          if (["SELECT", "UPDATE", "INSERT", "DELETE"].includes(s.sql.op)) {
            const into = s.sql.into.length ? ` and stores the result in ${s.sql.into.map((x) => fieldLabel(prog, x)).join(", ")}` : "";
            rules.push({ stmtId: s.id, line: s.line, endLine: s.endLine, kind: "sql", text: `${capitalize(sqlText(s.sql.op, s.sql.tables.map((t) => t.name)))}${into}.` });
          }
          break;
        case "call":
          if (!nested) rules.push({ stmtId: s.id, line: s.line, endLine: s.endLine, kind: "call", text: `Calls ${s.program ?? s.dynamic} with ${s.using.map((u) => (u.ref.k === "ref" ? fieldLabel(prog, u.ref.name) : "a constant")).join(" and ")}.` });
          break;
      }
    }
  };
  prog.paragraphs.forEach((p) => {
    if (!dead.has(p.name)) visit(p.stmts, false);
  });
  rules.sort((a, b) => a.line - b.line);
  return rules.map((r, i) => ({ ...r, n: i + 1 }));
}

function capitalize(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

async function explainProgram({ ast, analysis }: ExplainInput): Promise<ProgramExplanation> {
  const dead = new Set(analysis.deadParagraphs);
  const rules = extractRules(ast, dead);
  const title = ast.title ? sentence(ast.title) : `Program ${ast.id}`;
  const parts: string[] = [title.endsWith(".") ? title : title + "."];
  let nature: string;
  if (analysis.isSubprogram) {
    nature = "Computation subprogram";
    parts.push(analysis.calledBy.length ? `Subprogram called by ${analysis.calledBy.join(", ")}.` : "Subprogram called by a program that is not part of the imported sources.");
    const params = ast.procedureUsing.map((p) => `${fieldLabel(ast, p)} (${p})`);
    if (params.length) parts.push(`It receives ${params.join(" and ")}.`);
    const w = writtenSet(ast);
    const outs = [...w].filter((o) => ast.fields.get(o)?.section === "LINKAGE" && !dead.has(o)).slice(0, 4);
    if (outs.length) parts.push(`It returns ${outs.map((o) => fieldLabel(ast, o)).join(", ")}.`);
  } else if (analysis.isBatch) {
    nature = "Batch job step";
    parts.push(analysis.jobs.length ? `Run by job ${analysis.jobs.join(", ")}.` : "Standalone batch (no job in the sources runs it).");
  } else nature = "Program";
  const reads = analysis.tables.filter((t) => t.read).map((t) => t.name);
  const writes = analysis.tables.filter((t) => t.write).map((t) => t.name);
  if (reads.length) parts.push(`It reads ${reads.length > 1 ? "tables" : "table"} ${reads.join(", ")}.`);
  if (writes.length) parts.push(`It updates ${writes.length > 1 ? "tables" : "table"} ${writes.join(", ")}.`);
  if (analysis.calls.length) parts.push(`It calls ${[...new Set(analysis.calls.map((c) => c.program))].join(", ")}.`);

  const attention: ProgramExplanation["attention"] = [];
  for (const d of analysis.paragraphs.filter((p) => p.dead)) attention.push({ level: "info", text: `Dead code: paragraph ${d.name} is never called${d.comment ? ` (${sentence(d.comment).toLowerCase()})` : ""}. It will not be converted.`, line: d.line });
  for (const g of analysis.gotos) attention.push({ level: "warn", text: `GO TO ${g.targets.join(", ")}: unstructured jump, must be rewritten before automatic conversion.`, line: g.line });
  for (const m of analysis.manual.filter((m) => m.construct !== "GO TO")) attention.push({ level: "warn", text: `${m.construct}: ${m.detail}`, line: m.line });
  const written = writtenSet(ast);
  for (const p of ast.paragraphs) {
    if (dead.has(p.name)) continue;
    // Business constants hard-coded in computations
    walkStmts(p.stmts, (s) => {
      if (s.kind !== "compute") return;
      const lits: string[] = [];
      const visit = (e: Expr) => {
        if (e.k === "num" && !["0", "1", "100"].includes(e.v)) lits.push(numText(e.v));
        if (e.k === "bin") {
          visit(e.l);
          visit(e.r);
        }
        if (e.k === "neg") visit(e.e);
      };
      s.exprs.forEach(visit);
      if (lits.length) attention.push({ level: "info", text: `Business constant hard-coded in a computation: ${[...new Set(lits)].join(", ")}. Worth turning into a parameter during modernization.`, line: s.line });
    });
    // VARYING loop on a counter that is too short
    walkStmts(p.stmts, (s) => {
      if (s.kind !== "perform" || !s.varying || !s.until || s.until.k !== "rel") return;
      const ctr = ast.fields.get(s.varying.ref.name)?.pic;
      const lim = s.until.r.k === "ref" ? ast.fields.get(s.until.r.name)?.pic : undefined;
      if (ctr && lim && ctr.intDigits <= lim.intDigits)
        attention.push({ level: "warn", text: `Loop on ${s.varying.ref.name} (PIC ${ctr.raw}): if the limit is ${"9".repeat(lim.intDigits)}, the counter wraps around to zero and the loop never ends.`, line: s.line });
    });
  }
  let rounded = 0;
  for (const p of ast.paragraphs)
    if (!dead.has(p.name))
      walkStmts(p.stmts, (s) => {
        if (s.kind === "compute") rounded += s.targets.filter((t) => t.rounded).length;
      });
  if (rounded) attention.push({ level: "info", text: `${rounded} computation${rounded > 1 ? "s" : ""} with ROUNDED (nearest, half up): Java needs RoundingMode.HALF_UP to stay identical.` });
  void written;

  const dependencies: ProgramExplanation["dependencies"] = [
    { label: "Reads", items: reads.map((t) => `Table ${t} (DB2)`) },
    { label: "Updates", items: writes.map((t) => `Table ${t} (DB2)`) },
    { label: "Called by", items: [...analysis.calledBy, ...analysis.jobs.map((j) => `Job ${j}`)] },
    { label: "Calls", items: [...new Set(analysis.calls.map((c) => c.program + (c.inProject ? "" : " (not in the sources)")))] },
    { label: "Copybooks", items: analysis.copies.map((c) => c.name + (c.resolved ? "" : " (not found)")) },
  ];

  const glossary: ProgramExplanation["glossary"] = [];
  for (const it of ast.fields.values()) {
    if (it.level === 88 || it.children.length || it.name === "SQLCODE" || !it.pic) continue;
    glossary.push({ cobol: it.name, label: capitalize(fieldLabel(ast, it.name)), pic: it.pic.raw + (it.usage !== "DISPLAY" ? ` ${it.usage}` : "") });
  }

  const changes = ast.headerComments.filter((c) => /^(MODIF|CHANGE)/i.test(c)).map((c) => sentence(c));
  const history = [ast.author ? `Written by ${ast.author}${ast.dateWritten ? ` (${ast.dateWritten})` : ""}.` : ast.dateWritten ? `Written in ${ast.dateWritten}.` : "", ...changes.map((m) => m + ".")].filter(Boolean).join(" ");

  return { role: parts.join(" "), nature, rules, dependencies: dependencies.filter((d) => d.items.length), attention, glossary, history, provider: "mock" };
}

async function convertToJava({ ast, system, conventions, overrides, explanation, others }: ConvertInput) {
  const jp = transpile(ast, { system: system.asts, conventions, overrides });
  const all = new Map(others);
  all.set(ast.id, jp);
  const rules = new Map<number, string>();
  for (const r of explanation?.rules ?? []) rules.set(r.stmtId, `Rule ${r.n}: ${r.text.length > 110 ? r.text.slice(0, 107) + "…" : r.text}`);
  const rendered = renderJava(jp, ast, all, { summary: explanation?.role.split(". ").slice(1).join(". "), rules });
  return { className: jp.className, files: rendered.files, mapping: rendered.mapping, decisions: jp.decisions, todos: jp.todos, conventions: jp.conventions, provider: "mock" };
}

async function explainDiscrepancy({ group, report }: DiscrepancyInput): Promise<DiscrepancyExplanation> {
  const ex = group.examples[0];
  const share = `${fmtInt(group.count)} of ${fmtInt(report.total)} cases`;
  switch (group.kind) {
    case "rounding-tie":
      return {
        title: "Half-cent rounding",
        explanation: `COBOL rounds to the nearest value and sends half-cents up (ROUNDED keyword, line ${group.line} of ${group.program}). The converted Java used ${group.javaMode === "HALF_EVEN" ? "banker's rounding (HALF_EVEN), which goes to the even digit" : group.javaMode}, as required by the team's coding convention. The two only differ when a computation lands exactly on a half-cent: ${share}${ex?.raw ? `. For example ${ex.raw} gives ${ex.cobol} in COBOL and ${ex.java} in Java` : ""}.`,
        confidence: "certain",
        fix: { kind: "rounding", value: "HALF_UP", program: group.program, label: `Use RoundingMode.HALF_UP in ${group.program}` },
      };
    case "overflow":
      return {
        title: "Size overflow",
        explanation: `The result does not fit field ${group.field} (PIC ${group.pic ?? "?"}). COBOL then drops the high-order digits without any error, while the converted Java kept the full value. ${capitalize(share)}.`,
        confidence: "certain",
        fix: { kind: "overflow", value: "reproduce", program: group.program, label: `Reproduce the COBOL truncation in ${group.program}` },
      };
    case "precision":
      return {
        title: "Intermediate precision",
        explanation: `Both versions compute ${group.field} with different intermediate precision (31 truncated digits in COBOL, 34 rounded digits in Java). ${capitalize(share)}. The fix needs a business decision: reorder the computation or pin the precision.`,
        confidence: "likely",
      };
    case "unsupported":
      return {
        title: "Construct not converted",
        explanation: `The Java stops at line ${group.line} of ${group.program} on a construct Mue does not convert automatically (${group.field || "see the conversion step"}), while COBOL keeps running. ${capitalize(share)}. Rewrite that part by hand, then run the check again.`,
        confidence: "certain",
      };
    default:
      return {
        title: "Different execution path",
        explanation: `From line ${group.line} of ${group.program} on, the two versions no longer execute the same statements (${share}). Analyze by hand using the cases below.`,
        confidence: "needs review",
      };
  }
}

export const mockProvider: AiProvider = { name: "mock", explainProgram, convertToJava, explainDiscrepancy };
