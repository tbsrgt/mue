// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Optional LLM adapter — NOT WIRED. Mue never calls a model unless you implement this file.
 *
 * Mue works out of the box with the deterministic "mock" provider, built on the parser,
 * the transpiler and the harness. To plug in a language model (hosted or local):
 *
 *  1. Install the SDK of your choice.
 *  2. Set AI_PROVIDER=llm (and whatever credentials your SDK needs) in .env.local.
 *     Air-gapped installations can point this adapter at a model hosted on premises.
 *  3. Implement the three methods below, keeping these rules:
 *
 *     explainProgram: send the model the summarized AST (paragraphs, the rules extracted by
 *       mockProvider.explainProgram, dependencies) plus the COBOL source, and ask for a
 *       plain-language rewrite. Keep the mock's rules and line numbers as the skeleton: the
 *       model rephrases, it never invents a rule.
 *
 *     convertToJava: keep the deterministic transpiler as the source of the semantics (it is
 *       what the equivalence harness executes) and only use the model for names, comments
 *       and formatting. If the model rewrites logic, you need a real JVM to replay the
 *       produced Java (javac + sandboxed execution) before the report means anything.
 *
 *     explainDiscrepancy: give the model the mismatch group (COBOL statement, exact values,
 *       Java rounding mode) and ask for an explanation aimed at an auditor. The proposed fix
 *       must stay one of the known fixes (rounding, overflow).
 *
 * Until then every method falls back to the mock, and no network call is ever made.
 */
import { mockProvider } from "./mock";
import type { AiProvider } from "./types";

export const llmProvider: AiProvider = {
  name: "llm (not wired: falling back to mock)",
  explainProgram: (input) => mockProvider.explainProgram(input),
  convertToJava: (input) => mockProvider.convertToJava(input),
  explainDiscrepancy: (input) => mockProvider.explainDiscrepancy(input),
};
