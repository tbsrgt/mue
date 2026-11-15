// SPDX-License-Identifier: AGPL-3.0-only
/**
 * System analysis: inventory, metrics, call graph (CALL / PERFORM / COPY / JCL),
 * DB2 tables read and written, dead code, inputs and outputs of every program.
 */
import { parseProgram } from "./parser";
import type { CobolProgram, Cond, DataItem, Expr, JclJob, ManualItem, Paragraph, Stmt } from "./types";

export interface SourceFile {
  name: string;
  source: string;
}

export type FileKind = "program" | "copybook" | "jcl";

export function fileKind(name: string, source = ""): FileKind {
  const n = name.toLowerCase();
  if (n.endsWith(".cpy") || n.endsWith(".copy")) return "copybook";
  if (n.endsWith(".jcl") || /^\/\/\S+\s+JOB\b/m.test(source)) return "jcl";
  if (!/PROCEDURE\s+DIVISION/i.test(source) && /^\s*0?1\s+[A-Z0-9-]+/im.test(source) && !/PROGRAM-ID/i.test(source)) return "copybook";
  return "program";
}

export interface ParagraphInfo {
  name: string;
  line: number;
  endLine: number;
  stmts: number;
  performedBy: string[];
  dead: boolean;
  comment?: string;
}

export interface ProgramAnalysis {
  id: string;
  file: string;
  title?: string;
  author?: string;
  dateWritten?: string;
  lines: CobolProgram["lines"];
  stmtCount: number;
  complexity: number;
  paragraphs: ParagraphInfo[];
  calls: { program: string; line: number; inProject: boolean }[];
  calledBy: string[];
  jobs: string[];
  copies: { name: string; resolved: boolean }[];
  tables: { name: string; read: boolean; write: boolean }[];
  gotos: { line: number; targets: string[] }[];
  manual: ManualItem[];
  diagnostics: CobolProgram["diagnostics"];
  inputs: string[];
  outputs: string[];
  computeCount: number;
  roundedCount: number;
  deadParagraphs: string[];
  isBatch: boolean;
  isSubprogram: boolean;
}

export interface SystemGraph {
  nodes: { id: string; type: "program" | "copybook" | "table" | "job" | "external"; label: string; detail?: string }[];
  edges: { id: string; source: string; target: string; kind: "call" | "copy" | "read" | "write" | "exec" }[];
}

export interface SystemAnalysis {
  programs: ProgramAnalysis[];
  asts: Map<string, CobolProgram>;
  copybooks: { name: string; file: string; usedBy: string[]; lines: number }[];
  jobs: JclJob[];
  tables: { name: string; readers: string[]; writers: string[] }[];
  missingPrograms: { name: string; calledBy: string[] }[];
  graph: SystemGraph;
  totals: { lines: number; codeLines: number; programs: number; copybooks: number; jobs: number; deadParagraphs: number; manualItems: number; complexity: number; tables: number };
}

// ---------------- traversal ----------------

export function walkStmts(stmts: Stmt[] | undefined, fn: (s: Stmt) => void) {
  if (!stmts) return;
  for (const s of stmts) {
    fn(s);
    switch (s.kind) {
      case "if":
        walkStmts(s.then, fn);
        walkStmts(s.else, fn);
        break;
      case "evaluate":
        for (const w of s.whens) walkStmts(w.body, fn);
        walkStmts(s.other, fn);
        break;
      case "perform":
        walkStmts(s.body, fn);
        break;
      case "compute":
        walkStmts(s.onSize, fn);
        walkStmts(s.notOnSize, fn);
        break;
      case "call":
        walkStmts(s.onException, fn);
        break;
    }
  }
}

export function exprRefs(e: Expr | undefined, out: string[] = []): string[] {
  if (!e) return out;
  switch (e.k) {
    case "ref":
      out.push(e.name);
      if (e.sub) exprRefs(e.sub, out);
      break;
    case "bin":
      exprRefs(e.l, out);
      exprRefs(e.r, out);
      break;
    case "neg":
      exprRefs(e.e, out);
      break;
    case "func":
      e.args.forEach((a) => exprRefs(a, out));
      break;
  }
  return out;
}

export function condRefs(c: Cond | undefined, prog: CobolProgram, out: string[] = []): string[] {
  if (!c) return out;
  switch (c.k) {
    case "rel":
      exprRefs(c.l, out);
      exprRefs(c.r, out);
      break;
    case "and":
    case "or":
      condRefs(c.a, prog, out);
      condRefs(c.b, prog, out);
      break;
    case "not":
      condRefs(c.c, prog, out);
      break;
    case "cname": {
      const parent = prog.fields.get(c.name)?.parent;
      if (parent) out.push(parent);
      break;
    }
    case "class":
    case "sign":
      exprRefs(c.e, out);
      break;
  }
  return out;
}

function condDecisions(c: Cond | undefined): number {
  if (!c) return 0;
  if (c.k === "and" || c.k === "or") return 1 + condDecisions(c.a) + condDecisions(c.b);
  if (c.k === "not") return condDecisions(c.c);
  return 0;
}

/** Elementary items under a name (the item itself when it is elementary). */
export function elementaryOf(prog: CobolProgram, name: string): DataItem[] {
  const it = prog.fields.get(name);
  if (!it) return [];
  const out: DataItem[] = [];
  const rec = (d: DataItem) => {
    if (d.children.length === 0) {
      if (d.level !== 88) out.push(d);
    } else d.children.forEach(rec);
  };
  rec(it);
  return out;
}

// ---------------- program ----------------

export function cyclomatic(prog: CobolProgram): number {
  let n = 1;
  for (const p of prog.paragraphs)
    walkStmts(p.stmts, (s) => {
      if (s.kind === "if") n += 1 + condDecisions(s.cond);
      if (s.kind === "evaluate") for (const w of s.whens) n += w.objs.length + w.objs.reduce((a, o) => a + (o.kind === "cond" ? condDecisions(o.c) : 0), 0);
      if (s.kind === "perform" && (s.until || s.times)) n += 1 + condDecisions(s.until);
      if (s.kind === "compute" && s.onSize) n += 1;
      if (s.kind === "goto" && s.depending) n += s.targets.length;
    });
  return n;
}

function endsWithStop(p: Paragraph): boolean {
  const last = p.stmts[p.stmts.length - 1];
  return !!last && (last.kind === "stop" || last.kind === "goto");
}

/** Reachable paragraphs (fall-through, PERFORM, GO TO). */
export function reachability(prog: CobolProgram) {
  const idx = new Map(prog.paragraphs.map((p, i) => [p.name, i]));
  const performedBy = new Map<string, Set<string>>();
  const flow = new Set<number>();
  const performed = new Set<number>();
  const queue: { i: number; viaFlow: boolean }[] = [];
  if (prog.paragraphs.length) queue.push({ i: 0, viaFlow: true });
  const visited = new Set<string>();
  while (queue.length) {
    const { i, viaFlow } = queue.shift()!;
    const key = `${i}:${viaFlow}`;
    if (visited.has(key) || i >= prog.paragraphs.length) continue;
    visited.add(key);
    (viaFlow ? flow : performed).add(i);
    const p = prog.paragraphs[i];
    walkStmts(p.stmts, (s) => {
      if (s.kind === "perform" && s.target) {
        const a = idx.get(s.target.from);
        const b = s.target.thru ? idx.get(s.target.thru) : a;
        if (a !== undefined) {
          for (let k = a; k <= (b ?? a); k++) {
            const name = prog.paragraphs[k].name;
            if (!performedBy.has(name)) performedBy.set(name, new Set());
            performedBy.get(name)!.add(p.name);
            queue.push({ i: k, viaFlow: false });
          }
        }
      }
      if (s.kind === "goto") for (const t of s.targets) {
        const k = idx.get(t);
        if (k !== undefined) queue.push({ i: k, viaFlow: true });
      }
    });
    if (viaFlow && !endsWithStop(p)) queue.push({ i: i + 1, viaFlow: true });
  }
  const reachable = new Set([...flow, ...performed]);
  return { reachable, performedBy };
}

/** Inputs (read before being written) and outputs (written) of a program. */
export function dataFlow(prog: CobolProgram) {
  const first = new Map<string, "R" | "W">();
  const written = new Set<string>();
  const touchR = (names: string[]) => {
    for (const n of names) for (const el of elementaryOf(prog, n)) if (!first.has(el.name)) first.set(el.name, "R");
  };
  const touchW = (names: string[]) => {
    for (const n of names)
      for (const el of elementaryOf(prog, n)) {
        if (!first.has(el.name)) first.set(el.name, "W");
        written.add(el.name);
      }
  };
  const idx = new Map(prog.paragraphs.map((p, i) => [p.name, i]));
  const visiting = new Set<number>();
  const runPara = (i: number) => {
    if (visiting.has(i) || i < 0 || i >= prog.paragraphs.length) return;
    visiting.add(i);
    runStmts(prog.paragraphs[i].stmts);
  };
  const runStmts = (stmts: Stmt[] | undefined) => {
    if (!stmts) return;
    for (const s of stmts) {
      switch (s.kind) {
        case "move":
          touchR(exprRefs(s.src));
          touchW(s.to.map((r) => r.name));
          break;
        case "compute":
          s.exprs.forEach((e) => touchR(exprRefs(e)));
          touchW(s.targets.map((t) => t.ref.name));
          if (s.remainder) touchW([s.remainder.ref.name]);
          runStmts(s.onSize);
          runStmts(s.notOnSize);
          break;
        case "if":
          touchR(condRefs(s.cond, prog));
          runStmts(s.then);
          runStmts(s.else);
          break;
        case "evaluate":
          if (s.subject !== "TRUE" && s.subject !== "FALSE") touchR(exprRefs(s.subject));
          for (const w of s.whens) {
            for (const o of w.objs) if (o.kind === "cond") touchR(condRefs(o.c, prog));
            runStmts(w.body);
          }
          runStmts(s.other);
          break;
        case "perform":
          if (s.varying) {
            touchR(exprRefs(s.varying.from));
            touchW([s.varying.ref.name]);
          }
          if (s.times) touchR(exprRefs(s.times));
          if (s.until && !s.testAfter && !s.varying) touchR(condRefs(s.until, prog));
          if (s.until && s.varying) touchR(condRefs(s.until, prog));
          if (s.target) {
            const a = idx.get(s.target.from) ?? -1;
            const b = s.target.thru ? idx.get(s.target.thru) ?? a : a;
            for (let k = a; k <= b; k++) runPara(k);
          }
          runStmts(s.body);
          if (s.until && s.testAfter) touchR(condRefs(s.until, prog));
          break;
        case "call":
          for (const u of s.using) if (u.ref.k === "ref") touchR([u.ref.name]);
          for (const u of s.using) if (u.ref.k === "ref" && u.mode === "REFERENCE") touchW([u.ref.name]);
          break;
        case "display":
          s.items.forEach((e) => touchR(exprRefs(e)));
          break;
        case "accept":
          touchW([s.ref.name]);
          break;
        case "initialize":
          touchW(s.refs.map((r) => r.name));
          break;
        case "set":
          if (s.mode === "true") touchW(s.names.map((n) => prog.fields.get(n)?.parent ?? n));
          else touchW(s.refs.map((r) => r.name));
          break;
        case "sql": {
          const into = new Set(s.sql.into);
          touchR(s.sql.hostVars.filter((h) => !into.has(h)));
          touchW(s.sql.into);
          touchW(["SQLCODE"]);
          break;
        }
        case "goto":
          for (const t of s.targets) runPara(idx.get(t) ?? -1);
          break;
      }
    }
  };
  // Fall-through from the first paragraph
  for (let i = 0; i < prog.paragraphs.length; i++) {
    runPara(i);
    if (endsWithStop(prog.paragraphs[i])) break;
  }
  const inputs: string[] = [];
  for (const [name, kind] of first) {
    if (kind !== "R") continue;
    const it = prog.fields.get(name);
    if (!it) continue;
    if (it.section !== "LINKAGE" && it.value) continue; // initialized constant
    if (name === "SQLCODE") continue;
    inputs.push(name);
  }
  const linkage = [...prog.fields.values()].filter((f) => f.section === "LINKAGE" && f.children.length === 0 && f.level !== 88).map((f) => f.name);
  const outputs = [...new Set([...written, ...linkage])].filter((n) => n !== "SQLCODE");
  return { inputs, outputs };
}

export function parseJcl(source: string, file: string): JclJob {
  const lines = source.split(/\r?\n/);
  let name = file.replace(/\.[^.]+$/, "").toUpperCase();
  const steps: JclJob["steps"] = [];
  const datasets: string[] = [];
  const comments: string[] = [];
  lines.forEach((l, i) => {
    if (l.startsWith("//*")) {
      const c = l.slice(3).trim();
      if (c && !/EXEMPLE MUE|MUE EXAMPLE/i.test(c)) comments.push(c);
      return;
    }
    const job = /^\/\/(\S+)\s+JOB\b/.exec(l);
    if (job) name = job[1].toUpperCase();
    const ex = /^\/\/(\S*)\s+EXEC\s+(?:PGM=)?([A-Z0-9#@$]+)/i.exec(l);
    if (ex) steps.push({ name: ex[1] || `STEP${steps.length + 1}`, program: ex[2].toUpperCase(), line: i + 1 });
    for (const m of l.matchAll(/DSN=([A-Z0-9.#@$()+-]+)/gi)) datasets.push(m[1].toUpperCase());
  });
  return { name, file, steps, datasets, comment: comments[0] };
}

// ---------------- system ----------------

export function analyzeSystem(files: SourceFile[]): SystemAnalysis {
  const copyMap = new Map<string, SourceFile>();
  for (const f of files) if (fileKind(f.name, f.source) === "copybook") copyMap.set(f.name.replace(/\.[^.]+$/, "").toUpperCase(), f);
  const resolveCopy = (n: string) => copyMap.get(n.toUpperCase())?.source ?? null;

  const asts = new Map<string, CobolProgram>();
  const jobs: JclJob[] = [];
  for (const f of files) {
    const kind = fileKind(f.name, f.source);
    if (kind === "program") {
      const ast = parseProgram(f.source, { file: f.name, resolveCopy });
      asts.set(ast.id, ast);
    } else if (kind === "jcl") jobs.push(parseJcl(f.source, f.name));
  }

  const programs: ProgramAnalysis[] = [];
  const tableMap = new Map<string, { readers: Set<string>; writers: Set<string> }>();
  const copyUse = new Map<string, Set<string>>();
  const calledBy = new Map<string, Set<string>>();
  const missing = new Map<string, Set<string>>();

  for (const ast of asts.values()) {
    const calls: ProgramAnalysis["calls"] = [];
    const gotos: ProgramAnalysis["gotos"] = [];
    const tables = new Map<string, { read: boolean; write: boolean }>();
    let computeCount = 0;
    let roundedCount = 0;
    const addTable = (name: string, mode: "R" | "W") => {
      const t = tables.get(name) ?? { read: false, write: false };
      if (mode === "R") t.read = true;
      else t.write = true;
      tables.set(name, t);
    };
    for (const d of ast.sqlDeclarations) for (const t of d.tables) addTable(t.name, t.mode);
    for (const p of ast.paragraphs)
      walkStmts(p.stmts, (s) => {
        if (s.kind === "call" && s.program) calls.push({ program: s.program, line: s.line, inProject: asts.has(s.program) });
        if (s.kind === "goto") gotos.push({ line: s.line, targets: s.targets });
        if (s.kind === "sql") for (const t of s.sql.tables) addTable(t.name, t.mode);
        if (s.kind === "compute") {
          computeCount++;
          roundedCount += s.targets.filter((t) => t.rounded).length;
        }
      });
    for (const c of calls) {
      if (!calledBy.has(c.program)) calledBy.set(c.program, new Set());
      calledBy.get(c.program)!.add(ast.id);
      if (!c.inProject) {
        if (!missing.has(c.program)) missing.set(c.program, new Set());
        missing.get(c.program)!.add(ast.id);
      }
    }
    for (const [name, m] of tables) {
      const e = tableMap.get(name) ?? { readers: new Set(), writers: new Set() };
      if (m.read) e.readers.add(ast.id);
      if (m.write) e.writers.add(ast.id);
      tableMap.set(name, e);
    }
    for (const c of ast.copies) {
      if (!copyUse.has(c.name)) copyUse.set(c.name, new Set());
      copyUse.get(c.name)!.add(ast.id);
    }
    const { reachable, performedBy } = reachability(ast);
    const paragraphs: ParagraphInfo[] = ast.paragraphs.map((p, i) => ({
      name: p.name,
      line: p.line,
      endLine: p.endLine,
      stmts: countStmts(p.stmts),
      performedBy: [...(performedBy.get(p.name) ?? [])],
      dead: !reachable.has(i),
      comment: p.comment,
    }));
    const { inputs, outputs } = dataFlow(ast);
    const usesSql = ast.sqlDeclarations.length > 0 || ast.paragraphs.some((p) => p.stmts.some((s) => s.kind === "sql"));
    programs.push({
      id: ast.id,
      file: ast.file,
      title: ast.title,
      author: ast.author,
      dateWritten: ast.dateWritten,
      lines: ast.lines,
      stmtCount: ast.stmtCount,
      complexity: cyclomatic(ast),
      paragraphs,
      calls,
      calledBy: [],
      jobs: [],
      copies: ast.copies.map((c) => ({ name: c.name, resolved: c.resolved })),
      tables: [...tables].map(([name, m]) => ({ name, ...m })),
      gotos,
      manual: ast.manual,
      diagnostics: ast.diagnostics,
      inputs,
      outputs,
      computeCount,
      roundedCount,
      deadParagraphs: paragraphs.filter((p) => p.dead).map((p) => p.name),
      isBatch: ast.paragraphs.some((p) => p.stmts.some((s) => s.kind === "stop" && s.how === "STOP RUN")) || (usesSql && ast.procedureUsing.length === 0),
      isSubprogram: ast.procedureUsing.length > 0,
    });
  }
  for (const p of programs) {
    p.calledBy = [...(calledBy.get(p.id) ?? [])];
    p.jobs = jobs.filter((j) => j.steps.some((s) => s.program === p.id)).map((j) => j.name);
  }
  for (const j of jobs)
    for (const s of j.steps)
      if (!asts.has(s.program)) {
        if (!missing.has(s.program)) missing.set(s.program, new Set());
        missing.get(s.program)!.add(`JCL ${j.name}`);
      }

  const copybooks = [...copyMap.entries()].map(([name, f]) => ({
    name,
    file: f.name,
    usedBy: [...(copyUse.get(name) ?? [])],
    lines: f.source.split(/\r?\n/).filter((l) => l.trim()).length,
  }));

  // Graph
  const nodes: SystemGraph["nodes"] = [];
  const edges: SystemGraph["edges"] = [];
  const seen = new Set<string>();
  const node = (n: SystemGraph["nodes"][number]) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    nodes.push(n);
  };
  for (const j of jobs) node({ id: `job:${j.name}`, type: "job", label: j.name, detail: j.comment });
  for (const p of programs) node({ id: `pgm:${p.id}`, type: "program", label: p.id, detail: p.title });
  for (const [name] of missing) node({ id: `pgm:${name}`, type: "external", label: name, detail: "Not in the imported sources" });
  for (const c of copybooks) node({ id: `cpy:${c.name}`, type: "copybook", label: c.name });
  for (const [name] of tableMap) node({ id: `tbl:${name}`, type: "table", label: name });
  let e = 0;
  for (const j of jobs) for (const s of j.steps) edges.push({ id: `e${e++}`, source: `job:${j.name}`, target: `pgm:${s.program}`, kind: "exec" });
  for (const p of programs) {
    for (const c of new Set(p.calls.map((c) => c.program))) edges.push({ id: `e${e++}`, source: `pgm:${p.id}`, target: `pgm:${c}`, kind: "call" });
    for (const c of new Set(p.copies.map((c) => c.name))) if (seen.has(`cpy:${c}`)) edges.push({ id: `e${e++}`, source: `pgm:${p.id}`, target: `cpy:${c}`, kind: "copy" });
    for (const t of p.tables) {
      if (t.read) edges.push({ id: `e${e++}`, source: `pgm:${p.id}`, target: `tbl:${t.name}`, kind: "read" });
      if (t.write) edges.push({ id: `e${e++}`, source: `pgm:${p.id}`, target: `tbl:${t.name}`, kind: "write" });
    }
  }

  const totals = {
    lines: [...asts.values()].reduce((a, p) => a + p.lines.total, 0) + copybooks.reduce((a, c) => a + c.lines, 0),
    codeLines: [...asts.values()].reduce((a, p) => a + p.lines.code, 0),
    programs: programs.length,
    copybooks: copybooks.length,
    jobs: jobs.length,
    deadParagraphs: programs.reduce((a, p) => a + p.deadParagraphs.length, 0),
    manualItems: programs.reduce((a, p) => a + p.manual.length, 0),
    complexity: programs.reduce((a, p) => a + p.complexity, 0),
    tables: tableMap.size,
  };

  programs.sort((a, b) => a.id.localeCompare(b.id));
  return {
    programs,
    asts,
    copybooks,
    jobs,
    tables: [...tableMap].map(([name, v]) => ({ name, readers: [...v.readers], writers: [...v.writers] })).sort((a, b) => a.name.localeCompare(b.name)),
    missingPrograms: [...missing].map(([name, v]) => ({ name, calledBy: [...v] })),
    graph: { nodes, edges },
    totals,
  };
}

function countStmts(stmts: Stmt[]): number {
  let n = 0;
  walkStmts(stmts, () => n++);
  return n;
}
