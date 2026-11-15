// SPDX-License-Identifier: AGPL-3.0-only
import { llmProvider } from "./llm";
import { mockProvider } from "./mock";
import type { AiProvider } from "./types";

/** Provider selected by AI_PROVIDER (mock by default, no key required). */
export function getAi(): AiProvider {
  const p = (process.env.AI_PROVIDER ?? "mock").toLowerCase();
  if (p === "llm") return llmProvider;
  return mockProvider;
}

export type { AiProvider, ProgramExplanation, ConversionResult, DiscrepancyExplanation, Rule } from "./types";
