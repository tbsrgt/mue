// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";
import { Empty, fmtN, fmtWhen } from "@/components/app/ui";
import { getProgramStates, getReport, isReportCurrent, listReports, ready } from "@/lib/services";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reports" };

export default async function ReportsPage({ params }: { params: Promise<{ id: string }> }) {
  await ready();
  const id = Number((await params).id);
  const reports = listReports(id);
  const states = getProgramStates(id);
  if (!reports.length) return <Empty glyph="NO REPORT" title="No equivalence report yet">Convert a program, then run the verification: every replay produces a timestamped report you can export for audit.</Empty>;
  return (
    <section className="panel tight">
      <div className="hd"><h2>Equivalence reports</h2><span className="sp" /><small>{reports.length} report{reports.length === 1 ? "" : "s"}, newest first</small></div>
      <div className="tw">
        <table className="t">
          <thead><tr><th>#</th><th>Program</th><th>Date</th><th className="num">Replayed</th><th className="num">Identical</th><th className="num">Mismatches</th><th>Status</th><th /></tr></thead>
          <tbody>
            {reports.map((r) => {
              const full = getReport(r.id)!;
              const current = isReportCurrent(id, full, states);
              return (
                <tr key={r.id}>
                  <td className="mono">#{r.id}</td>
                  <td><Link className="pg" href={`/projects/${id}/programs/${r.program}?view=verify`}>{r.program}</Link>{full.data.appliedFix && <span className="sub">after fix: {full.data.appliedFix}</span>}</td>
                  <td className="mono dimtxt" style={{ fontSize: 12.5 }}>{fmtWhen(r.createdAt)}</td>
                  <td className="num">{fmtN(r.total)}</td>
                  <td className="num ok">{fmtN(r.identical)}</td>
                  <td className={`num ${r.mismatches ? "bad" : ""}`}>{r.mismatches}</td>
                  <td>{r.mismatches ? <span className="chip bad">Mismatches</span> : <span className="chip ok">Equivalent</span>} {!current && <span className="chip warn plain">outdated</span>}</td>
                  <td style={{ textAlign: "right" }}><Link className="btn ghost sm" href={`/reports/${r.id}`}>Open</Link></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
