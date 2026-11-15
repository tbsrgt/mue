// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Public API of Mue: analyze COBOL, transpile it to Java, verify equivalence.
 *
 *   import { loadSources, analyze, transpile, verify } from "mue-cobol";
 *   const system = analyze(loadSources("examples/banking"));
 *   const java = transpile(system);
 *   const run = await verify(system, { cases: 2400 });
 */
import fs from "node:fs";
import path from "node:path";
import { mockProvider } from "./ai/mock";
import type { DiscrepancyExplanation, ProgramExplanation } from "./ai/types";
import { analyzeSystem, fileKind, type SourceFile, type SystemAnalysis } from "./cobol/analyze";
import { DEFAULT_CONVENTIONS, type Conventions, type JProgram, type Overrides } from "./java/ir";
import { renderJava, type JavaFile, type LineMap } from "./java/render";
import { transpile as transpileProgram } from "./java/transpile";
import { verifyProgram, type EquivalenceReport, type RecordedCase } from "./verify/harness";
import { VERSION } from "./version";

export { VERSION };
export type { SourceFile, SystemAnalysis, ProgramAnalysis } from "./cobol/analyze";
export type { Conventions, Overrides, JProgram, Decision } from "./java/ir";
export type { JavaFile, LineMap } from "./java/render";
export type { EquivalenceReport, CauseGroup, RecordedCase, Warning } from "./verify/harness";
export type { ProgramExplanation, DiscrepancyExplanation, Rule } from "./ai/types";
export { DEFAULT_CONVENTIONS } from "./java/ir";
export { analysisMarkdown, verificationMarkdown } from "./report/markdown";
export { verificationHtml } from "./report/html";

const SOURCE_EXT = /\.(cbl|cob|cobol|cpy|copy|jcl)$/i;

/** Reads every COBOL program, copybook and JCL file under a directory (recursively). */
export function loadSources(dir: string): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith(".") && e.name !== "node_modules") walk(p);
      } else if (SOURCE_EXT.test(e.name)) out.push({ name: e.name, source: fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n") });
    }
  };
  walk(dir);
  return out;
}

/** Parses and analyzes a set of sources: inventory, call graph, tables, dead code, data flow. */
export function analyze(sources: SourceFile[] | string): SystemAnalysis {
  return analyzeSystem(typeof sources === "string" ? loadSources(sources) : sources);
}

/** Plain-language explanation and business rules of a program (deterministic, offline). */
export function explain(system: SystemAnalysis, programId: string): Promise<ProgramExplanation> {
  const ast = system.asts.get(programId);
  const analysis = system.programs.find((p) => p.id === programId);
  if (!ast || !analysis) throw new Error(`Program ${programId} not found`);
  return mockProvider.explainProgram({ ast, analysis, system });
}

export interface TranspileOptions {
  /** Project-wide conventions (default: COBOL-exact HALF_UP rounding, overflow reproduced). */
  conventions?: Partial<Conventions>;
  /** Per-program overrides, e.g. { CALCINT: { rounding: "HALF_UP" } }. */
  overrides?: Record<string, Overrides>;
}

export interface ConvertedProgram {
  id: string;
  className: string;
  ir: JProgram;
  /** Main class, shared records (copybooks) and the runtime files it needs. */
  files: JavaFile[];
  /** COBOL line ↔ Java line mapping of the main class. */
  mapping: LineMap[];
  /** Statements that need manual work; `blocking` ones prevent verification. */
  todos: JProgram["todos"];
}

function buildIrs(system: SystemAnalysis, opts: TranspileOptions): Map<string, JProgram> {
  const conventions: Conventions = { ...DEFAULT_CONVENTIONS, ...(opts.conventions ?? {}) };
  const irs = new Map<string, JProgram>();
  for (const ast of system.asts.values()) irs.set(ast.id, transpileProgram(ast, { system: system.asts, conventions, overrides: opts.overrides?.[ast.id] }));
  return irs;
}

/** Converts every program of the system to Java. */
export function transpile(system: SystemAnalysis, opts: TranspileOptions = {}): Map<string, ConvertedProgram> {
  const irs = buildIrs(system, opts);
  const out = new Map<string, ConvertedProgram>();
  for (const [id, ir] of irs) {
    const r = renderJava(ir, system.asts.get(id)!, irs);
    out.set(id, { id, className: ir.className, ir, files: r.files, mapping: r.mapping, todos: ir.todos });
  }
  return out;
}

export interface VerifyApiOptions extends TranspileOptions {
  /** Programs to verify (default: all programs of the system). */
  programs?: string[];
  /** Total number of cases per program (default: about 2,000 plus edge cases; 400 for cursor batches). */
  cases?: number;
  /** PRNG seed (default: derived from the program name, so runs are reproducible). */
  seed?: number;
  /** Recorded inputs replayed after the generated cases, by program. */
  extraCases?: Record<string, RecordedCase[]>;
}

export interface ProgramVerification {
  program: string;
  className?: string;
  status: "equivalent" | "mismatch" | "skipped";
  /** Why the program was not verified (constructs that were not converted). */
  reason?: string;
  report?: EquivalenceReport;
  /** One explanation per mismatch group, in the same order as `report.groups`. */
  explanations: DiscrepancyExplanation[];
}

export interface VerificationRun {
  tool: { name: "mue-cobol"; version: string };
  createdAt: string;
  conventions: Conventions;
  overrides: Record<string, Overrides>;
  programs: ProgramVerification[];
  totals: { programs: number; equivalent: number; mismatch: number; skipped: number; cases: number; identical: number; mismatches: number };
}

/**
 * Replays the same generated (and recorded) cases through the COBOL interpreter and the Java
 * model of every program, and compares every output field, SQL write, external call and
 * DISPLAY line. Programs that contain constructs Mue does not convert are skipped, never
 * reported as equivalent.
 */
export async function verify(system: SystemAnalysis, opts: VerifyApiOptions = {}): Promise<VerificationRun> {
  const conventions: Conventions = { ...DEFAULT_CONVENTIONS, ...(opts.conventions ?? {}) };
  const irs = buildIrs(system, opts);
  const ids = opts.programs ?? system.programs.map((p) => p.id);
  const programs: ProgramVerification[] = [];
  for (const id of ids) {
    const ir = irs.get(id);
    const ast = system.asts.get(id);
    if (!ir || !ast) throw new Error(`Program ${id} not found`);
    // A program is only as verifiable as everything it calls.
    const blocking = reachableIrs(id, irs).flatMap((p) => p.todos.filter((t) => t.blocking).map((t) => ({ ...t, program: p.id })));
    if (blocking.length) {
      programs.push({
        program: id,
        className: ir.className,
        status: "skipped",
        reason: `Not converted automatically: ${[...new Set(blocking.map((b) => `${b.construct} (${b.program} line ${b.line})`))].join(", ")}`,
        explanations: [],
      });
      continue;
    }
    const report = verifyProgram(system.asts, irs, id, { total: opts.cases, seed: opts.seed, extraCases: opts.extraCases?.[id] });
    const explanations: DiscrepancyExplanation[] = [];
    for (const g of report.groups) explanations.push(await mockProvider.explainDiscrepancy({ group: g, report, ast: system.asts.get(g.program) ?? ast }));
    programs.push({ program: id, className: ir.className, status: report.mismatches ? "mismatch" : "equivalent", report, explanations });
  }
  const verified = programs.filter((p) => p.report);
  return {
    tool: { name: "mue-cobol", version: VERSION },
    createdAt: new Date().toISOString(),
    conventions,
    overrides: opts.overrides ?? {},
    programs,
    totals: {
      programs: programs.length,
      equivalent: programs.filter((p) => p.status === "equivalent").length,
      mismatch: programs.filter((p) => p.status === "mismatch").length,
      skipped: programs.filter((p) => p.status === "skipped").length,
      cases: verified.reduce((s, p) => s + p.report!.total, 0),
      identical: verified.reduce((s, p) => s + p.report!.identical, 0),
      mismatches: verified.reduce((s, p) => s + p.report!.mismatches, 0),
    },
  };
}

function reachableIrs(root: string, irs: Map<string, JProgram>): JProgram[] {
  const out: JProgram[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const p = irs.get(id);
    if (!p) return;
    out.push(p);
    const walk = (stmts: JProgram["paragraphs"][number]["body"]) => {
      for (const s of stmts) {
        if (s.k === "call" && !s.external) visit(s.program);
        const kids: JProgram["paragraphs"][number]["body"][] = [];
        if (s.k === "if") kids.push(s.then, s.else ?? []);
        if (s.k === "switchStr" || s.k === "chain") kids.push(...s.cases.map((c) => c.body), s.other ?? []);
        if (s.k === "block" || s.k === "while" || s.k === "repeat" || s.k === "varying") kids.push(s.body);
        if (s.k === "setNum" && s.sizeError) kids.push(s.sizeError.on ?? [], s.sizeError.not ?? []);
        kids.forEach(walk);
      }
    };
    p.paragraphs.forEach((para) => walk(para.body));
  };
  visit(root);
  return out;
}

export { fileKind };
