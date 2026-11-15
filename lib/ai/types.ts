// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Contract of the Mue AI layer. Two implementations:
 *  - mock: deterministic, built on the parser, the transpiler and the harness (default);
 *  - llm: optional adapter for a language model, not wired (see llm.ts).
 * Selected with the AI_PROVIDER environment variable (mock | llm).
 *
 * Whatever the provider, the semantics of the Java code always come from the deterministic
 * transpiler, because that is what the equivalence harness executes. A model may only
 * rephrase explanations, names and comments.
 */
import type { ProgramAnalysis, SystemAnalysis } from "../cobol/analyze";
import type { CobolProgram } from "../cobol/types";
import type { Conventions, Decision, JProgram, Overrides } from "../java/ir";
import type { LineMap, JavaFile } from "../java/render";
import type { CauseGroup, EquivalenceReport } from "../verify/harness";

export interface Rule {
  n: number;
  stmtId: number;
  line: number;
  endLine: number;
  kind: "condition" | "computation" | "data" | "sql" | "call" | "loop";
  text: string;
}

export interface ProgramExplanation {
  role: string;
  nature: string;
  rules: Rule[];
  dependencies: { label: string; items: string[] }[];
  attention: { level: "info" | "warn"; text: string; line?: number }[];
  glossary: { cobol: string; label: string; pic: string }[];
  history: string;
  provider: string;
}

export interface ConversionResult {
  className: string;
  files: JavaFile[];
  mapping: LineMap[];
  decisions: Decision[];
  todos: JProgram["todos"];
  conventions: Conventions;
  provider: string;
}

export interface DiscrepancyExplanation {
  title: string;
  explanation: string;
  confidence: "certain" | "likely" | "needs review";
  fix?: { kind: "rounding" | "overflow"; value: string; program: string; label: string };
}

export interface ExplainInput {
  ast: CobolProgram;
  analysis: ProgramAnalysis;
  system: SystemAnalysis;
}

export interface ConvertInput {
  ast: CobolProgram;
  system: SystemAnalysis;
  conventions: Conventions;
  overrides?: Overrides;
  explanation?: ProgramExplanation;
  /** IR of the other programs in the project (for calls). */
  others: Map<string, JProgram>;
}

export interface DiscrepancyInput {
  group: CauseGroup;
  report: EquivalenceReport;
  ast: CobolProgram;
}

export interface AiProvider {
  name: string;
  explainProgram(input: ExplainInput): Promise<ProgramExplanation>;
  convertToJava(input: ConvertInput): Promise<ConversionResult>;
  explainDiscrepancy(input: DiscrepancyInput): Promise<DiscrepancyExplanation>;
}
