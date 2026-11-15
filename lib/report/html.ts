// SPDX-License-Identifier: AGPL-3.0-only
/** Standalone HTML equivalence report (printable, no external resource). */
import type { VerificationRun } from "../index";
import { CATEGORY_LABEL } from "../verify/runtime";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const n = (x: number) => x.toLocaleString("en-US");

export interface HtmlReportMeta {
  /** Report number shown in the header (Mue Studio). */
  reportId?: number;
  projectName?: string;
  /** Fix applied before this run, if any. */
  appliedFix?: string;
  /** Fingerprints of the conversions that were replayed. */
  conversions?: { program: string; javaHash: string }[];
  /** Shows the "fictional example" banner. */
  isExample?: boolean;
  /** Adds a print button bar at the top. */
  printBar?: boolean;
}

export function verificationHtml(run: VerificationRun, meta: HtmlReportMeta = {}): string {
  const t = run.totals;
  const date = new Date(run.createdAt).toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" });
  const ok = t.mismatch === 0 && t.equivalent > 0;
  const single = run.programs.length === 1 ? run.programs[0] : null;
  const title = single ? `Equivalence report · ${single.program}` : "Equivalence report";

  const sections = run.programs
    .map((p) => {
      if (p.status === "skipped") return `<section class="prog"><h2>${esc(p.program)} · skipped</h2><p class="dim">${esc(p.reason)}</p></section>`;
      const r = p.report!;
      const groups = r.groups
        .map((g, i) => {
          const ex = p.explanations[i];
          return `<section class="grp">
  <h3>${esc(ex?.title ?? g.kind)} <span class="tag bad">${g.count} mismatch${g.count > 1 ? "es" : ""}</span></h3>
  <p class="where">First divergence: ${esc(g.program)}, line ${g.line}, field ${esc(g.field)}${g.pic ? ` (PIC ${esc(g.pic)})` : ""}${g.javaMode ? ` · Java: RoundingMode.${esc(g.javaMode)}` : ""}</p>
  <p>${esc(ex?.explanation ?? "")}</p>
  ${g.examples.length ? `<table><thead><tr><th>Case</th><th class="r">Exact value</th><th class="r">COBOL</th><th class="r">Java</th></tr></thead><tbody>
  ${g.examples.map((x) => `<tr><td>#${x.caseId}</td><td class="r">${esc(x.raw ?? "—")}</td><td class="r">${esc(x.cobol)}</td><td class="r">${esc(x.java)}</td></tr>`).join("")}
  </tbody></table>` : ""}
  ${ex?.fix ? `<p class="fix">Suggested fix: ${esc(ex.fix.label)}.</p>` : `<p class="fix">No automatic fix (${esc(ex?.confidence ?? "")}).</p>`}
</section>`;
        })
        .join("\n");
      const warnings = r.warnings.length
        ? `<h4>Legacy behaviors reproduced exactly</h4><ul class="warn">${r.warnings
            .map((w) => `<li><b>${esc(w.title)}</b> (${w.count} cases${w.line ? `, ${esc(w.program)} line ${w.line}` : ""}). ${esc(w.detail)} <span class="dim">${esc(w.examples.join(" · "))}</span></li>`)
            .join("")}</ul>`
        : "";
      return `<section class="prog">
<h2>${esc(p.program)} <span class="tag ${p.status === "equivalent" ? "ok" : "bad"}">${p.status === "equivalent" ? "equivalent" : `${n(r.mismatches)} mismatches`}</span></h2>
<p class="dim">Java class ${esc(p.className ?? "")} · ${n(r.total)} cases · ${n(r.identical)} identical · seed ${r.seed} · ${r.durationMs} ms</p>
<table><thead><tr><th>Case category</th><th class="r">Cases</th><th class="r">Mismatches</th></tr></thead><tbody>
${r.byCategory.map((c) => `<tr><td>${esc(CATEGORY_LABEL[c.category])}</td><td class="r">${n(c.total)}</td><td class="r">${c.mismatches}</td></tr>`).join("")}
</tbody></table>
${groups}
${warnings}
<dl>
<dt>Generated inputs</dt><dd>${esc(r.inputs.join(", ") || "—")}</dd>
${r.selects.length ? `<dt>Stubbed SQL reads</dt><dd>${esc(r.selects.join(", "))}</dd>` : ""}
${r.cursors.length ? `<dt>Stubbed cursors</dt><dd>${esc(r.cursors.join(", "))}</dd>` : ""}
<dt>Compared outputs</dt><dd>${esc(r.outputs.join(", "))}</dd>
<dt>Also compared</dt><dd>SQL writes, external program calls, DISPLAY lines, abnormal ends</dd>
<dt>Java programs replayed</dt><dd>${esc(r.javaPrograms.map((j) => `${j.className} (rounding ${j.rounding}, overflow ${j.overflow})`).join("; "))}</dd>
</dl>
</section>`;
    })
    .join("\n");

  const model = run.programs.find((p) => p.report)?.report?.model;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Mue</title>
<style>
:root{--ink:#11201b;--mut:#5b6f66;--line:#d6e0db;--green:#178a64;--red:#c2412f;--bar:#eef6f1}
*{box-sizing:border-box}
body{margin:0;background:#e9eeeb;color:var(--ink);font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
.page{max-width:920px;margin:24px auto;background:#fff;padding:48px 56px;box-shadow:0 2px 24px rgba(0,0,0,.08)}
.top{display:flex;align-items:center;gap:12px;border-bottom:2px solid var(--ink);padding-bottom:14px}
.mk{width:30px;height:30px;border-radius:6px;background:#41c79d;color:#06120e;display:grid;place-items:center;font-weight:700}
.top b{font-size:22px}.top .sp{flex:1}.top small{color:var(--mut);font:12px ui-monospace,Menlo,monospace}
h1{font-size:28px;line-height:1.15;margin:26px 0 4px}
h2{font-size:18px;margin:34px 0 6px;display:flex;gap:10px;align-items:center;border-bottom:1px solid var(--line);padding-bottom:6px}
h3{font-size:15px;margin:0 0 6px;display:flex;gap:10px;align-items:center}
h4{font:600 12px ui-monospace,Menlo,monospace;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);margin:18px 0 6px}
.meta{color:var(--mut);margin:0}
.verdict{margin:22px 0;border:2px solid ${ok ? "var(--green)" : "var(--red)"};border-radius:8px;padding:16px 18px;display:flex;gap:18px;align-items:center}
.verdict .v{font-weight:700;font-size:18px;color:${ok ? "var(--green)" : "var(--red)"}}
.nums{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.nums div{padding:12px 16px;border-right:1px solid var(--line)}.nums div:last-child{border-right:0}
.nums span{display:block;font:11px ui-monospace,Menlo,monospace;text-transform:uppercase;letter-spacing:.08em;color:var(--mut)}
.nums b{font-size:26px}
table{width:100%;border-collapse:collapse;font-size:13px;margin:8px 0}
th{text-align:left;font:500 11px ui-monospace,Menlo,monospace;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);border-bottom:1px solid var(--ink);padding:6px 8px}
td{padding:6px 8px;border-bottom:1px solid var(--line)}
tbody tr:nth-child(even) td{background:var(--bar)}
.r{text-align:right;font-family:ui-monospace,Menlo,monospace}
.tag{font:500 11px ui-monospace,Menlo,monospace;border-radius:99px;padding:2px 8px;border:1px solid}
.tag.bad{color:var(--red);border-color:var(--red)}.tag.ok{color:var(--green);border-color:var(--green)}
.grp{border:1px solid var(--line);border-left:4px solid var(--red);border-radius:6px;padding:14px 16px;margin:12px 0;break-inside:avoid}
.where,.dim{color:var(--mut);font-size:12.5px}
.fix{font-weight:600;color:var(--green);margin:10px 0 0}
ul.warn{padding-left:18px}ul.warn li{margin-bottom:6px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 18px;margin:12px 0 0}dt{color:var(--mut)}dd{margin:0;font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
.sign{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:34px}
.sign div{border-top:1px solid var(--ink);padding-top:6px;color:var(--mut);font-size:12.5px;height:70px}
.foot{margin-top:30px;color:var(--mut);font-size:11.5px;border-top:1px solid var(--line);padding-top:10px}
.ex{background:#fff6dc;border:1px solid #f0d58f;color:#6b4d00;border-radius:6px;padding:8px 12px;font-size:12.5px;margin-top:14px}
.bar{position:sticky;top:0;display:flex;gap:8px;justify-content:center;padding:10px;background:#11201b}
.bar button{font:600 13px system-ui,sans-serif;background:#41c79d;color:#06120e;border:0;border-radius:6px;padding:8px 14px;cursor:pointer}
@media print{body{background:#fff}.page{box-shadow:none;margin:0;max-width:none;padding:0}.bar{display:none}@page{margin:16mm}}
@media (max-width:700px){.page{padding:24px 18px;margin:0}.nums{grid-template-columns:1fr}.nums div{border-right:0;border-bottom:1px solid var(--line)}.sign{grid-template-columns:1fr}}
</style></head><body>
${meta.printBar ? `<div class="bar"><button onclick="window.print()">Print or save as PDF</button></div>` : ""}
<main class="page">
<div class="top"><span class="mk">M</span><b>Mue</b><span class="sp"></span><small>${meta.reportId ? `Report #${meta.reportId} · ` : ""}${esc(date)}</small></div>
<h1>${esc(title)}</h1>
<p class="meta">${meta.projectName ? `Project "${esc(meta.projectName)}" · ` : ""}${esc(run.tool.name)} ${esc(run.tool.version)} · rounding ${esc(run.conventions.rounding)}, overflow ${esc(run.conventions.overflow)}</p>
${meta.isExample ? `<div class="ex">Demo example: fictional banking system, generated data. No real customer data.</div>` : ""}
<div class="verdict"><div class="v">${ok ? "EQUIVALENT" : t.mismatch ? "MISMATCHES TO FIX" : "NOT VERIFIED"}</div><div>${
    ok
      ? `The Java code gives exactly the same results as the original COBOL on all ${n(t.cases)} replayed cases, edge cases included.`
      : t.mismatch
        ? `${n(t.mismatches)} of ${n(t.cases)} replayed cases give a different result. Causes and fixes below.`
        : "No program could be verified."
  }${t.skipped ? ` ${t.skipped} program${t.skipped > 1 ? "s were" : " was"} skipped (constructs not converted automatically).` : ""}${meta.appliedFix ? ` Replayed after applying: ${esc(meta.appliedFix)}.` : ""}</div></div>
<div class="nums"><div><span>Replayed cases</span><b>${n(t.cases)}</b></div><div><span>Identical</span><b style="color:var(--green)">${n(t.identical)}</b></div><div><span>Mismatches</span><b style="color:${t.mismatches ? "var(--red)" : "var(--ink)"}">${n(t.mismatches)}</b></div></div>
${sections}
${meta.conversions?.length ? `<h4>Conversion fingerprints</h4><p class="dim">${esc(meta.conversions.map((c) => `${c.program} ${c.javaHash}`).join(" ; "))}</p>` : ""}
${model ? `<h4>Method</h4><p><b>COBOL reference.</b> ${esc(model.cobol)}</p><p><b>Java.</b> ${esc(model.java)}</p><p class="dim">Case generation is deterministic (seeded): the same report can be reproduced exactly. Database reads and programs missing from the sources are stubbed identically on both sides; only the converted code is compared.</p>` : ""}
<div class="sign"><div>Prepared by (migration team)</div><div>Approved by (internal control / audit)</div></div>
<p class="foot">Generated locally by Mue, without any network call. ${esc(date)}.</p>
</main></body></html>`;
}
