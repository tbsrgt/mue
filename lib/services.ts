// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Mue Studio services: projects, files, the Understand → Convert → Verify pipeline,
 * equivalence reports and the activity log. Everything is stored in a local SQLite file.
 */
import fs from "node:fs";
import path from "node:path";
import { getAi } from "./ai";
import type { ConversionResult, DiscrepancyExplanation, ProgramExplanation } from "./ai/types";
import { analyzeSystem, fileKind, type SystemAnalysis } from "./cobol/analyze";
import { db, now } from "./db";
import { DEFAULT_CONVENTIONS, type Conventions, type JProgram, type Overrides } from "./java/ir";
import { transpile } from "./java/transpile";
import { hashSeed, verifyProgram, type EquivalenceReport } from "./verify/harness";

export class UserError extends Error {}

export type Stage = "new" | "explained" | "converted" | "verified";
export const STAGES: Stage[] = ["new", "explained", "converted", "verified"];
export const STAGE_LABEL: Record<Stage, string> = { new: "Not analyzed", explained: "Explained", converted: "Converted", verified: "Verified" };

export interface Project {
  id: number;
  name: string;
  description: string | null;
  isExample: boolean;
  conventions: Conventions;
  createdAt: string;
}

export interface FileRow {
  id: number;
  name: string;
  source: string;
  createdAt: string;
  kind: ReturnType<typeof fileKind>;
  lines: number;
}

export interface ProgramState {
  program: string;
  stage: Stage;
  explanation?: ProgramExplanation;
  java?: ConversionResult;
  javaHash?: string;
  overrides: Overrides;
  updatedAt?: string;
}

export interface StoredReport extends EquivalenceReport {
  explanations: (DiscrepancyExplanation & { key: string })[];
  conversions: { program: string; javaHash: string }[];
  projectName: string;
  appliedFix?: string;
}

export interface ReportRow {
  id: number;
  projectId: number;
  program: string;
  javaHash: string;
  total: number;
  identical: number;
  mismatches: number;
  warnings: number;
  createdAt: string;
  data: StoredReport;
}

type Row = Record<string, unknown>;

const toProject = (r: Row): Project => ({
  id: Number(r.id),
  name: String(r.name),
  description: (r.description as string) ?? null,
  isExample: Number(r.is_example) === 1,
  conventions: { ...DEFAULT_CONVENTIONS, ...JSON.parse(String(r.conventions)) },
  createdAt: String(r.created_at),
});

// ---------------- projects ----------------
export function listProjects(): Project[] {
  ensureSeed();
  return db().prepare("SELECT * FROM projects ORDER BY is_example DESC, id DESC").all().map((r) => toProject(r as Row));
}

export function getProject(id: number): Project | null {
  ensureSeed();
  const r = db().prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
  return r ? toProject(r) : null;
}

export function createProject(input: { name: string; description?: string; conventions?: Partial<Conventions>; isExample?: boolean }): number {
  const name = input.name.trim();
  if (!name) throw new UserError("Give the project a name.");
  if (name.length > 120) throw new UserError("Name too long (120 characters at most).");
  const conv = { ...DEFAULT_CONVENTIONS, ...(input.conventions ?? {}) };
  const r = db()
    .prepare("INSERT INTO projects (name, description, is_example, conventions, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(name, input.description?.trim() || null, input.isExample ? 1 : 0, JSON.stringify(conv), now());
  const id = Number(r.lastInsertRowid);
  logEvent(id, null, "project", `Project "${name}" created.`);
  return id;
}

export function updateConventions(projectId: number, conv: Partial<Conventions>) {
  const p = getProject(projectId);
  if (!p) throw new UserError("Project not found.");
  const next = { ...p.conventions, ...conv };
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(next.package)) throw new UserError("Invalid Java package (e.g. com.example.accounts).");
  db().prepare("UPDATE projects SET conventions = ? WHERE id = ?").run(JSON.stringify(next), projectId);
  logEvent(projectId, null, "conventions", `Conventions changed: rounding ${next.rounding}, overflow "${next.overflow}", package ${next.package}. Converted programs need to be converted again.`);
}

export function deleteProject(projectId: number) {
  db().prepare("DELETE FROM projects WHERE id = ?").run(projectId);
  cache.delete(projectId);
}

// ---------------- files ----------------
const ALLOWED = /\.(cbl|cob|cobol|cpy|copy|jcl)$/i;

export function listFiles(projectId: number): FileRow[] {
  return db()
    .prepare("SELECT id, name, source, created_at FROM files WHERE project_id = ? ORDER BY name")
    .all(projectId)
    .map((r) => {
      const row = r as Row;
      const source = String(row.source);
      return { id: Number(row.id), name: String(row.name), source, createdAt: String(row.created_at), kind: fileKind(String(row.name), source), lines: source.split(/\r?\n/).filter((l, i, a) => i < a.length - 1 || l.trim()).length };
    });
}

export function getFile(projectId: number, fileId: number): FileRow | null {
  return listFiles(projectId).find((f) => f.id === fileId) ?? null;
}

export function addFiles(projectId: number, files: { name: string; source: string }[]) {
  const added: string[] = [];
  const replaced: string[] = [];
  const rejected: { name: string; reason: string }[] = [];
  const existing = new Map(listFiles(projectId).map((f) => [f.name.toUpperCase(), f]));
  const ins = db().prepare("INSERT INTO files (project_id, name, source, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, name) DO UPDATE SET source = excluded.source, created_at = excluded.created_at");
  for (const f of files) {
    const name = path.basename(f.name.trim()).replace(/[^A-Za-z0-9._-]/g, "_");
    if (!name) continue;
    if (!ALLOWED.test(name)) {
      rejected.push({ name, reason: "unsupported extension (.cbl, .cob, .cpy, .jcl)" });
      continue;
    }
    if (!f.source.trim()) {
      rejected.push({ name, reason: "empty file" });
      continue;
    }
    if (f.source.length > 2_000_000) {
      rejected.push({ name, reason: "file too large (2 MB at most)" });
      continue;
    }
    if (/\u0000/.test(f.source)) {
      rejected.push({ name, reason: "binary file (EBCDIC?): convert it to text before importing" });
      continue;
    }
    const prev = existing.get(name.toUpperCase());
    ins.run(projectId, prev?.name ?? name, f.source.replace(/\r\n/g, "\n"), now());
    (prev ? replaced : added).push(prev?.name ?? name);
  }
  cache.delete(projectId);
  if (replaced.length) {
    // Programs that were touched (or use a touched copybook) start over.
    const sys = getSystem(projectId);
    const names = new Set(replaced.map((n) => n.replace(/\.[^.]+$/, "").toUpperCase()));
    for (const p of sys.programs) if (names.has(p.file.replace(/\.[^.]+$/, "").toUpperCase()) || p.copies.some((c) => names.has(c.name))) resetProgram(projectId, p.id);
  }
  if (added.length || replaced.length) logEvent(projectId, null, "import", `${added.length + replaced.length} file${added.length + replaced.length > 1 ? "s" : ""} imported${replaced.length ? ` (${replaced.length} replaced)` : ""}: ${[...added, ...replaced].join(", ")}.`);
  return { added, replaced, rejected };
}

export function deleteFile(projectId: number, fileId: number) {
  const f = getFile(projectId, fileId);
  if (!f) return;
  db().prepare("DELETE FROM files WHERE id = ? AND project_id = ?").run(fileId, projectId);
  cache.delete(projectId);
  logEvent(projectId, null, "import", `File ${f.name} deleted.`);
}

function resetProgram(projectId: number, program: string) {
  db().prepare("UPDATE programs SET stage = 'new', explanation = NULL, java = NULL, java_hash = NULL, updated_at = ? WHERE project_id = ? AND program = ?").run(now(), projectId, program);
}

// ---------------- system analysis (memoized) ----------------
const cache = new Map<number, { sig: string; sys: SystemAnalysis }>();

export function getSystem(projectId: number): SystemAnalysis {
  const files = listFiles(projectId);
  const sig = files.map((f) => `${f.id}:${f.name}:${f.source.length}:${f.createdAt}`).join("|");
  const c = cache.get(projectId);
  if (c && c.sig === sig) return c.sys;
  const sys = analyzeSystem(files.map((f) => ({ name: f.name, source: f.source })));
  cache.set(projectId, { sig, sys });
  return sys;
}

// ---------------- program state ----------------
export function getProgramStates(projectId: number): Map<string, ProgramState> {
  const sys = getSystem(projectId);
  const rows = db().prepare("SELECT * FROM programs WHERE project_id = ?").all(projectId) as Row[];
  const byName = new Map(rows.map((r) => [String(r.program), r]));
  const out = new Map<string, ProgramState>();
  for (const p of sys.programs) {
    const r = byName.get(p.id);
    out.set(p.id, {
      program: p.id,
      stage: (r?.stage as Stage) ?? "new",
      explanation: r?.explanation ? JSON.parse(String(r.explanation)) : undefined,
      java: r?.java ? JSON.parse(String(r.java)) : undefined,
      javaHash: (r?.java_hash as string) ?? undefined,
      overrides: r?.overrides ? JSON.parse(String(r.overrides)) : {},
      updatedAt: (r?.updated_at as string) ?? undefined,
    });
  }
  return out;
}

function saveState(projectId: number, s: ProgramState) {
  db()
    .prepare(
      `INSERT INTO programs (project_id, program, stage, explanation, java, java_hash, overrides, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, program) DO UPDATE SET stage = excluded.stage, explanation = excluded.explanation, java = excluded.java, java_hash = excluded.java_hash, overrides = excluded.overrides, updated_at = excluded.updated_at`,
    )
    .run(projectId, s.program, s.stage, s.explanation ? JSON.stringify(s.explanation) : null, s.java ? JSON.stringify(s.java) : null, s.javaHash ?? null, JSON.stringify(s.overrides ?? {}), now());
}

function stateOf(projectId: number, program: string): { sys: SystemAnalysis; state: ProgramState; project: Project } {
  const project = getProject(projectId);
  if (!project) throw new UserError("Project not found.");
  const sys = getSystem(projectId);
  const state = getProgramStates(projectId).get(program);
  if (!state || !sys.asts.has(program)) throw new UserError(`Program ${program} not found in this project.`);
  return { sys, state, project };
}

const hashOf = (s: string) => hashSeed(s).toString(16).padStart(8, "0");

// ---------------- Understand ----------------
export async function explain(projectId: number, program: string) {
  const { sys, state } = stateOf(projectId, program);
  const analysis = sys.programs.find((p) => p.id === program)!;
  const explanation = await getAi().explainProgram({ ast: sys.asts.get(program)!, analysis, system: sys });
  const next: ProgramState = { ...state, explanation, stage: state.stage === "new" ? "explained" : state.stage };
  saveState(projectId, next);
  logEvent(projectId, program, "understand", `${program} analyzed: ${explanation.rules.length} business rule${explanation.rules.length === 1 ? "" : "s"} found, ${analysis.lines.total} lines read.`);
  return explanation;
}

// ---------------- Convert ----------------
function othersIr(projectId: number, sys: SystemAnalysis, conventions: Conventions, except?: string): Map<string, JProgram> {
  const states = getProgramStates(projectId);
  const m = new Map<string, JProgram>();
  for (const ast of sys.asts.values()) {
    if (ast.id === except) continue;
    m.set(ast.id, transpile(ast, { system: sys.asts, conventions, overrides: states.get(ast.id)?.overrides }));
  }
  return m;
}

export async function convert(projectId: number, program: string) {
  const { sys, state, project } = stateOf(projectId, program);
  let explanation = state.explanation;
  if (!explanation) explanation = await explain(projectId, program);
  const java = await getAi().convertToJava({
    ast: sys.asts.get(program)!,
    system: sys,
    conventions: project.conventions,
    overrides: state.overrides,
    explanation,
    others: othersIr(projectId, sys, project.conventions, program),
  });
  const javaHash = hashOf(java.files[0].content + JSON.stringify(java.decisions));
  saveState(projectId, { ...stateOf(projectId, program).state, explanation, java, javaHash, stage: "converted" });
  const manual = java.todos.filter((t) => t.blocking).length;
  logEvent(projectId, program, "convert", `${program} converted to ${java.className}.java (${java.files[0].content.split("\n").length} lines)${java.decisions.length ? `, ${java.decisions.length} conversion decision${java.decisions.length === 1 ? "" : "s"}` : ""}${manual ? `, ${manual} construct${manual === 1 ? "" : "s"} to migrate by hand` : ""}.`);
  return java;
}

// ---------------- Verify ----------------
export async function verify(projectId: number, program: string, opts: { appliedFix?: string } = {}): Promise<number> {
  const { sys, state, project } = stateOf(projectId, program);
  if (!state.java) throw new UserError("Convert the program first so it can be compared with the original.");
  const blocking = state.java.todos.filter((t) => t.blocking);
  if (blocking.length) throw new UserError(`Cannot verify: ${blocking.length} construct${blocking.length === 1 ? "" : "s"} to migrate by hand (${[...new Set(blocking.map((b) => b.construct))].join(", ")}).`);
  const irs = othersIr(projectId, sys, project.conventions);
  const report = verifyProgram(sys.asts, irs, program);
  const states = getProgramStates(projectId);
  const conversions = report.javaPrograms.map((j) => ({ program: j.id, javaHash: states.get(j.id)?.javaHash ?? "(not converted)" }));
  const explanations: StoredReport["explanations"] = [];
  for (const g of report.groups) {
    const e = await getAi().explainDiscrepancy({ group: g, report, ast: sys.asts.get(g.program)! });
    explanations.push({ ...e, key: `${g.kind}:${g.program}:${g.stmtId}:${g.field}` });
  }
  const data: StoredReport = { ...report, explanations, conversions, projectName: project.name, appliedFix: opts.appliedFix };
  const r = db()
    .prepare("INSERT INTO reports (project_id, program, java_hash, total, identical, mismatches, warnings, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(projectId, program, state.javaHash ?? "", report.total, report.identical, report.mismatches, report.warnings.length, JSON.stringify(data), now());
  const id = Number(r.lastInsertRowid);
  saveState(projectId, { ...stateOf(projectId, program).state, stage: report.mismatches === 0 ? "verified" : "converted" });
  logEvent(
    projectId,
    program,
    "verify",
    report.mismatches === 0
      ? `${program} verified: ${report.total.toLocaleString("en-US")} cases replayed, all identical.`
      : `${program}: ${report.mismatches} mismatch${report.mismatches === 1 ? "" : "es"} out of ${report.total.toLocaleString("en-US")} replayed cases.`,
  );
  return id;
}

/** Applies the fix proposed for a mismatch group, converts again and replays. */
export async function applyFix(projectId: number, reportId: number, groupIndex: number, scope: "program" | "project" = "program"): Promise<number> {
  const rep = getReport(reportId);
  if (!rep || rep.projectId !== projectId) throw new UserError("Report not found.");
  const expl = rep.data.explanations[groupIndex];
  if (!expl?.fix) throw new UserError("No automatic fix for this mismatch.");
  const fix = expl.fix;
  const ov: Overrides = fix.kind === "rounding" ? { rounding: fix.value as Overrides["rounding"] } : { overflow: fix.value as Overrides["overflow"] };
  if (scope === "project") {
    updateConventions(projectId, ov);
    for (const [name, st] of getProgramStates(projectId)) if (st.java) await convert(projectId, name);
  } else {
    const { state } = stateOf(projectId, fix.program);
    saveState(projectId, { ...state, overrides: { ...state.overrides, ...ov } });
    logEvent(projectId, fix.program, "fix", `Fix applied to ${fix.program}: ${fix.label}.`);
    if (state.java) await convert(projectId, fix.program);
  }
  return verify(projectId, rep.program, { appliedFix: fix.label });
}

export function resetOverrides(projectId: number, program: string) {
  const { state } = stateOf(projectId, program);
  saveState(projectId, { ...state, overrides: {} });
}

// ---------------- reports ----------------
const toReport = (r: Row): ReportRow => ({
  id: Number(r.id),
  projectId: Number(r.project_id),
  program: String(r.program),
  javaHash: String(r.java_hash ?? ""),
  total: Number(r.total),
  identical: Number(r.identical),
  mismatches: Number(r.mismatches),
  warnings: Number(r.warnings),
  createdAt: String(r.created_at),
  data: JSON.parse(String(r.data)),
});

export function getReport(id: number): ReportRow | null {
  const r = db().prepare("SELECT * FROM reports WHERE id = ?").get(id) as Row | undefined;
  return r ? toReport(r) : null;
}

export function listReports(projectId: number, program?: string): Omit<ReportRow, "data">[] {
  const rows = (program
    ? db().prepare("SELECT id, project_id, program, java_hash, total, identical, mismatches, warnings, created_at FROM reports WHERE project_id = ? AND program = ? ORDER BY id DESC").all(projectId, program)
    : db().prepare("SELECT id, project_id, program, java_hash, total, identical, mismatches, warnings, created_at FROM reports WHERE project_id = ? ORDER BY id DESC").all(projectId)) as Row[];
  return rows.map((r) => ({ id: Number(r.id), projectId: Number(r.project_id), program: String(r.program), javaHash: String(r.java_hash ?? ""), total: Number(r.total), identical: Number(r.identical), mismatches: Number(r.mismatches), warnings: Number(r.warnings), createdAt: String(r.created_at) }));
}

export function latestReport(projectId: number, program: string): ReportRow | null {
  const r = db().prepare("SELECT * FROM reports WHERE project_id = ? AND program = ? ORDER BY id DESC LIMIT 1").get(projectId, program) as Row | undefined;
  return r ? toReport(r) : null;
}

/** A report is current when the conversions it replayed have not changed since. */
export function isReportCurrent(projectId: number, rep: ReportRow, states = getProgramStates(projectId)): boolean {
  return rep.data.conversions.every((c) => states.get(c.program)?.javaHash === c.javaHash || c.javaHash === "(not converted)");
}

// ---------------- dashboard ----------------
export interface DashboardRow {
  program: string;
  title?: string;
  stage: Stage;
  lines: number;
  complexity: number;
  manual: number;
  blocking: number;
  dead: number;
  openDiscrepancies: number;
  lastReport?: { id: number; total: number; mismatches: number; createdAt: string; current: boolean };
  nature: string;
}

export function dashboard(projectId: number) {
  const sys = getSystem(projectId);
  const states = getProgramStates(projectId);
  const rows: DashboardRow[] = sys.programs.map((p) => {
    const st = states.get(p.id)!;
    const rep = latestReport(projectId, p.id);
    const current = rep ? isReportCurrent(projectId, rep, states) : false;
    return {
      program: p.id,
      title: p.title,
      stage: st.stage,
      lines: p.lines.total,
      complexity: p.complexity,
      manual: p.manual.length,
      blocking: st.java ? st.java.todos.filter((t) => t.blocking).length : p.manual.filter((m) => m.construct !== "Edited PIC").length,
      dead: p.deadParagraphs.length,
      openDiscrepancies: rep && current && st.stage !== "verified" ? rep.mismatches : 0,
      lastReport: rep ? { id: rep.id, total: rep.total, mismatches: rep.mismatches, createdAt: rep.createdAt, current } : undefined,
      nature: p.isSubprogram ? "Subprogram" : p.isBatch ? "Batch" : "Program",
    };
  });
  const weight: Record<Stage, number> = { new: 0, explained: 1, converted: 2, verified: 3 };
  const progress = rows.length ? Math.round((rows.reduce((s, r) => s + weight[r.stage], 0) / (rows.length * 3)) * 100) : 0;
  const counts = Object.fromEntries(STAGES.map((s) => [s, rows.filter((r) => r.stage === s).length])) as Record<Stage, number>;
  const reports = listReports(projectId);
  return {
    rows,
    progress,
    counts,
    openDiscrepancies: rows.reduce((s, r) => s + r.openDiscrepancies, 0),
    operations: reports.reduce((s, r) => s + r.total, 0),
    reports: reports.length,
    fixed: reports.filter((r) => r.mismatches > 0).length,
    totals: sys.totals,
  };
}

// ---------------- activity log ----------------
export function logEvent(projectId: number | null, program: string | null, kind: string, message: string) {
  db().prepare("INSERT INTO events (project_id, program, kind, message, created_at) VALUES (?, ?, ?, ?, ?)").run(projectId, program, kind, message, now());
}

export function listEvents(projectId: number, limit = 30) {
  return (db().prepare("SELECT * FROM events WHERE project_id = ? ORDER BY id DESC LIMIT ?").all(projectId, limit) as Row[]).map((r) => ({ id: Number(r.id), program: (r.program as string) ?? null, kind: String(r.kind), message: String(r.message), createdAt: String(r.created_at) }));
}

// ---------------- example project ----------------
const SAMPLE_DIR = path.join(process.cwd(), "examples", "banking");
let seeding = false;

export function sampleFiles(): { name: string; source: string }[] {
  return fs
    .readdirSync(SAMPLE_DIR)
    .filter((f) => ALLOWED.test(f))
    .sort()
    .map((name) => ({ name, source: fs.readFileSync(path.join(SAMPLE_DIR, name), "utf8") }));
}

export function ensureSeed() {
  if (seeding) return;
  const n = Number((db().prepare("SELECT COUNT(*) AS n FROM projects").get() as Row).n);
  if (n > 0) return;
  seeding = true;
  try {
    createExampleProject();
  } finally {
    seeding = false;
  }
}

/** Creates the example project and moves it forward, so the demo shows a real history. */
export function createExampleProject(): number {
  const id = createProject({
    name: "Example Bank · core banking (example)",
    description: "Fictional banking system written for the demo: interest, loans, late fees, SEPA transfers, nightly batch. No real data.",
    conventions: { rounding: "HALF_EVEN", overflow: "reproduce", package: "com.examplebank.core" },
    isExample: true,
  });
  addFiles(id, sampleFiles());
  // The pipeline is async (AI interface) but the mock answers immediately.
  pendingSeed = (async () => {
    for (const p of ["CALCINT", "LOANPMT", "LATEFEE", "IBANCHK", "ACCTFEES", "NIGHTINT"]) await explain(id, p);
    for (const p of ["CALCINT", "LOANPMT", "LATEFEE", "IBANCHK"]) await convert(id, p);
    await verify(id, "IBANCHK");
    const r1 = await verify(id, "LOANPMT");
    const rep = getReport(r1);
    if (rep && rep.data.explanations.length) await applyFix(id, r1, 0, "program");
    await verify(id, "CALCINT");
  })();
  return id;
}

export let pendingSeed: Promise<void> | null = null;

/** Call before reading state: waits for the seeding to finish if needed. */
export async function ready() {
  ensureSeed();
  if (pendingSeed) await pendingSeed;
}
