import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { analyzeSystem } from "../lib/cobol/analyze";
import { DEFAULT_CONVENTIONS, type Overrides } from "../lib/java/ir";
import { transpile } from "../lib/java/transpile";

/** The "team convention" used throughout the tests: banker's rounding, which differs from COBOL. */
export const TEAM_CONVENTIONS = { ...DEFAULT_CONVENTIONS, rounding: "HALF_EVEN" as const };

export const SAMPLES = path.join(import.meta.dirname, "..", "examples", "banking");

export function loadSystem() {
  const files = readdirSync(SAMPLES).map((name) => ({ name, source: readFileSync(path.join(SAMPLES, name), "utf8") }));
  return analyzeSystem(files);
}

export function transpileAll(sys: ReturnType<typeof loadSystem>, overrides: Record<string, Overrides> = {}) {
  const javas = new Map();
  for (const ast of sys.asts.values()) javas.set(ast.id, transpile(ast, { system: sys.asts, conventions: TEAM_CONVENTIONS, overrides: overrides[ast.id] }));
  return javas;
}
