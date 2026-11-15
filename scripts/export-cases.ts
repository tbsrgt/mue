// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Exports the generated test cases of one program, with the outputs of the COBOL interpreter,
 * as a tab-separated file. CI replays it through the compiled Java (scripts/java-replay) to
 * check the real javac output, not only the Java execution model.
 *
 *   tsx scripts/export-cases.ts <dir> <PROGRAM> <out.tsv>
 *
 * Header: input names, then output names prefixed with "=". One case per line.
 */
import fs from "node:fs";
import { analyze, loadSources } from "../lib/index";
import { runCobol } from "../lib/cobol/interpreter";
import { buildPlan, generateCases } from "../lib/verify/harness";

const [dir, program, out] = process.argv.slice(2);
if (!dir || !program || !out) {
  process.stderr.write("usage: tsx scripts/export-cases.ts <dir> <PROGRAM> <out.tsv>\n");
  process.exit(2);
}
const system = analyze(loadSources(dir));
if (!system.asts.has(program)) {
  process.stderr.write(`Program ${program} not found\n`);
  process.exit(2);
}
const plan = buildPlan(system.asts, program);
if (plan.cursors.length || plan.selectVars.length) {
  process.stderr.write(`${program} reads a database: only programs without SQL can be exported\n`);
  process.exit(2);
}
const inputs = plan.inputs.map((f) => f.name);
const outputs = plan.outputs;
const clean = (s: string) => s.replace(/[\t\r\n]/g, " ");
const lines = [[...inputs, ...outputs.map((o) => "=" + o)].join("\t")];
let skipped = 0;
for (const tc of generateCases(system.asts, program, plan)) {
  const r = runCobol(system.asts, program, tc, outputs);
  if (r.status !== "ok") {
    skipped++;
    continue;
  }
  lines.push([...inputs.map((n) => clean(tc.inputs[n] ?? "")), ...outputs.map((o) => clean(r.fields[o] ?? ""))].join("\t"));
}
fs.writeFileSync(out, lines.join("\n") + "\n");
process.stdout.write(`${lines.length - 1} cases of ${program} written to ${out}${skipped ? ` (${skipped} abnormal ends skipped)` : ""}\n`);
