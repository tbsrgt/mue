// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";
import { Empty, fmtN, fmtWhen, StageChip } from "@/components/app/ui";
import { dashboard, listEvents, ready, STAGE_LABEL, STAGES } from "@/lib/services";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboard" };

const COLORS = { verified: "var(--green)", converted: "var(--amber)", explained: "var(--cyan)", new: "var(--line-2)" } as const;

export default async function Dashboard({ params }: { params: Promise<{ id: string }> }) {
  await ready();
  const id = Number((await params).id);
  const d = dashboard(id);
  const events = listEvents(id, 14);
  const base = `/projects/${id}`;
  if (!d.rows.length)
    return (
      <Empty glyph="EMPTY SET" title="No program in this project" action={<Link className="btn" href={`${base}/files`}>Import files</Link>}>
        Import your COBOL programs (.cbl, .cob), their copybooks (.cpy) and the jobs that run them (.jcl). Mue builds the inventory and the system map on import.
      </Empty>
    );

  const next = d.rows.find((r) => r.openDiscrepancies > 0) ?? d.rows.find((r) => r.stage === "converted" && !r.blocking) ?? d.rows.find((r) => r.stage === "explained") ?? d.rows.find((r) => r.stage === "new");
  const viewOf = (r: (typeof d.rows)[number]) => (r.openDiscrepancies || r.stage === "converted" ? "verify" : r.stage === "explained" ? "convert" : "understand");

  return (
    <>
      <div className="kpis">
        <div className="kpi">
          <span>Programs</span>
          <b>{d.rows.length}</b>
          <small>{d.totals.copybooks} copybooks · {d.totals.jobs} jobs</small>
        </div>
        <div className="kpi">
          <span>COBOL lines</span>
          <b>{fmtN(d.totals.lines)}</b>
          <small>{d.totals.tables} DB2 tables</small>
        </div>
        <div className="kpi ok">
          <span>Progress</span>
          <b>{d.progress}%</b>
          <small>{d.counts.verified} of {d.rows.length} verified</small>
        </div>
        <div className={`kpi ${d.openDiscrepancies ? "bad" : ""}`}>
          <span>Open mismatches</span>
          <b>{d.openDiscrepancies}</b>
          <small>{d.fixed} replay{d.fixed === 1 ? "" : "s"} with mismatches</small>
        </div>
        <div className="kpi">
          <span>Replayed cases</span>
          <b>{fmtN(d.operations)}</b>
          <small>{d.reports} report{d.reports === 1 ? "" : "s"}</small>
        </div>
      </div>

      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="bd">
          <div className="row" style={{ marginBottom: 10 }}>
            <b style={{ fontSize: 14 }}>Migration progress</b>
            <span className="sp" />
            {next && (
              <Link href={`${base}/programs/${next.program}?view=${viewOf(next)}`} className="btn sm">
                Next: {next.program} →
              </Link>
            )}
          </div>
          <div className="pipe" role="img" aria-label={STAGES.map((s) => `${STAGE_LABEL[s]}: ${d.counts[s]}`).join(", ")}>
            {(["verified", "converted", "explained"] as const).map((s) => (
              <i key={s} className={`p-${s}`} style={{ width: `${(d.counts[s] / d.rows.length) * 100}%` }} />
            ))}
          </div>
          <div className="legend">
            {STAGES.map((s) => (
              <span key={s}>
                <i style={{ background: COLORS[s] }} /> {STAGE_LABEL[s]} · {d.counts[s]}
              </span>
            ))}
          </div>
        </div>
      </section>

      <div className="cols">
        <section className="panel tight">
          <div className="hd">
            <h2>Programs</h2>
            <span className="sp" />
            <small>not analyzed → explained → converted → verified</small>
          </div>
          <div className="tw">
            <table className="t">
              <thead>
                <tr>
                  <th>Program</th>
                  <th>Stage</th>
                  <th className="num">Lines</th>
                  <th className="num">Complexity</th>
                  <th className="num">Manual</th>
                  <th className="num">Mismatches</th>
                  <th>Last verification</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.program}>
                    <td>
                      <Link className="pg" href={`${base}/programs/${r.program}`}>{r.program}</Link>
                      <span className="sub" title={r.title}>{r.nature}{r.title ? ` · ${r.title.toLowerCase()}` : ""}</span>
                    </td>
                    <td><StageChip stage={r.stage} /></td>
                    <td className="num">{fmtN(r.lines)}</td>
                    <td className="num">{r.complexity}</td>
                    <td className="num">{r.blocking ? <span className="chip warn plain">{r.blocking}</span> : <span className="dimtxt">0</span>}</td>
                    <td className="num">{r.openDiscrepancies ? <span className="bad">{r.openDiscrepancies}</span> : <span className="dimtxt">0</span>}</td>
                    <td>
                      {r.lastReport ? (
                        <Link href={`/reports/${r.lastReport.id}`} className="mono" style={{ fontSize: 12.5, textDecoration: "none" }}>
                          <span className={r.lastReport.mismatches ? "bad" : "ok"}>{fmtN(r.lastReport.total - r.lastReport.mismatches)}/{fmtN(r.lastReport.total)}</span>
                          <span className="dimtxt"> · {fmtWhen(r.lastReport.createdAt)}</span>
                          {!r.lastReport.current && <span className="chip warn plain" style={{ marginLeft: 6 }}>outdated</span>}
                        </Link>
                      ) : (
                        <span className="dimtxt">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="panel">
          <div className="hd">
            <h2>Activity</h2>
            <span className="sp" />
            <small>audit trail</small>
          </div>
          <div className="bd" style={{ paddingTop: 4, paddingBottom: 4 }}>
            <ul className="journal">
              {events.map((e) => (
                <li key={e.id}>
                  <time dateTime={e.createdAt}>{fmtWhen(e.createdAt)}</time>
                  <span>
                    <span className="k">{e.kind}</span>
                    {e.message}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </>
  );
}
