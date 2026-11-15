// SPDX-License-Identifier: AGPL-3.0-only
/** Mue Studio: renders a stored report with the same standalone HTML as the CLI. */
import { DEFAULT_CONVENTIONS } from "./java/ir";
import { verificationHtml } from "./report/html";
import type { ReportRow } from "./services";
import { VERSION } from "./version";

export function reportHtml(r: ReportRow, opts: { isExample: boolean; printBar?: boolean }): string {
  const d = r.data;
  const main = d.javaPrograms.find((j) => j.id === r.program);
  return verificationHtml(
    {
      tool: { name: "mue-cobol", version: VERSION },
      createdAt: r.createdAt,
      conventions: { ...DEFAULT_CONVENTIONS, rounding: (main?.rounding as "HALF_UP" | "HALF_EVEN") ?? DEFAULT_CONVENTIONS.rounding, overflow: (main?.overflow as "reproduce" | "ignore") ?? DEFAULT_CONVENTIONS.overflow },
      overrides: {},
      programs: [{ program: r.program, className: main?.className, status: r.mismatches ? "mismatch" : "equivalent", report: d, explanations: d.explanations }],
      totals: { programs: 1, equivalent: r.mismatches ? 0 : 1, mismatch: r.mismatches ? 1 : 0, skipped: 0, cases: r.total, identical: r.identical, mismatches: r.mismatches },
    },
    { reportId: r.id, projectName: d.projectName, appliedFix: d.appliedFix, conversions: d.conversions, isExample: opts.isExample, printBar: opts.printBar ?? true },
  );
}
