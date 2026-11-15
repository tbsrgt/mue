// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";
import SystemGraph from "@/components/app/SystemGraph";
import { Empty, fmtN } from "@/components/app/ui";
import { getProgramStates, getSystem, ready, STAGE_LABEL } from "@/lib/services";

export const dynamic = "force-dynamic";
export const metadata = { title: "System" };

export default async function SystemPage({ params }: { params: Promise<{ id: string }> }) {
  await ready();
  const id = Number((await params).id);
  const sys = getSystem(id);
  const states = getProgramStates(id);
  const stages = Object.fromEntries([...states].map(([k, v]) => [k, STAGE_LABEL[v.stage].toLowerCase()]));
  const base = `/projects/${id}`;
  if (!sys.programs.length) return <Empty glyph="EMPTY MAP" title="Nothing to map yet" action={<Link className="btn" href={`${base}/files`}>Import files</Link>}>The system map appears as soon as programs are imported.</Empty>;
  return (
    <div className="stack">
      <section className="panel tight">
        <div className="hd">
          <h2>System map</h2>
          <span className="sp" />
          <small>jobs → programs → calls, copybooks and tables · click a program to open it</small>
        </div>
        <div className="bd" style={{ padding: 12 }}>
          <SystemGraph graph={sys.graph} projectId={id} stages={stages} />
          <div className="legend" style={{ marginTop: 12 }}>
            <span><i style={{ background: "#7cc9d8" }} /> job runs program</span>
            <span><i style={{ background: "#e9b14c" }} /> CALL</span>
            <span><i style={{ background: "#5f786d" }} /> COPY</span>
            <span><i style={{ background: "#41c79d" }} /> reads a table</span>
            <span><i style={{ background: "#ff7d70" }} /> writes a table</span>
          </div>
        </div>
      </section>

      <section className="panel tight">
        <div className="hd"><h2>Inventory</h2><span className="sp" /><small>{fmtN(sys.totals.lines)} lines · cumulative complexity {sys.totals.complexity}</small></div>
        <div className="tw">
          <table className="t">
            <thead>
              <tr>
                <th>Program</th>
                <th className="num">Lines</th>
                <th className="num">Code</th>
                <th className="num">Comments</th>
                <th className="num">Statements</th>
                <th className="num">Complexity</th>
                <th>Calls</th>
                <th>Called by</th>
                <th>Tables</th>
                <th>Dead code</th>
                <th>Manual work</th>
              </tr>
            </thead>
            <tbody>
              {sys.programs.map((p) => (
                <tr key={p.id}>
                  <td><Link className="pg" href={`${base}/programs/${p.id}`}>{p.id}</Link><span className="sub">{p.file}</span></td>
                  <td className="num">{p.lines.total}</td>
                  <td className="num">{p.lines.code}</td>
                  <td className="num">{p.lines.comment}</td>
                  <td className="num">{p.stmtCount}</td>
                  <td className="num">{p.complexity}</td>
                  <td className="mono" style={{ fontSize: 12.5 }}>{[...new Set(p.calls.map((c) => c.program))].join(", ") || <span className="dimtxt">—</span>}</td>
                  <td className="mono" style={{ fontSize: 12.5 }}>{[...p.calledBy, ...p.jobs.map((j) => `job ${j}`)].join(", ") || <span className="dimtxt">—</span>}</td>
                  <td className="mono" style={{ fontSize: 12.5 }}>{p.tables.map((t) => `${t.name} ${t.read && t.write ? "R/W" : t.write ? "W" : "R"}`).join(", ") || <span className="dimtxt">—</span>}</td>
                  <td className="mono" style={{ fontSize: 12.5 }}>{p.deadParagraphs.length ? <span className="chip warn plain">{p.deadParagraphs.join(", ")}</span> : <span className="dimtxt">—</span>}</td>
                  <td>{p.manual.length ? <span className="chip warn plain">{[...new Set(p.manual.map((m) => m.construct))].join(", ")}</span> : <span className="dimtxt">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid3">
        <section className="panel tight">
          <div className="hd"><h2>DB2 tables</h2></div>
          <div className="tw">
            <table className="t">
              <thead><tr><th>Table</th><th>Read by</th><th>Written by</th></tr></thead>
              <tbody>
                {sys.tables.map((t) => (
                  <tr key={t.name}><td className="mono">{t.name}</td><td className="mono" style={{ fontSize: 12.5 }}>{t.readers.join(", ") || "—"}</td><td className="mono" style={{ fontSize: 12.5 }}>{t.writers.join(", ") || "—"}</td></tr>
                ))}
                {!sys.tables.length && <tr><td colSpan={3} className="dimtxt">No EXEC SQL found.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
        <section className="panel tight">
          <div className="hd"><h2>Copybooks</h2></div>
          <div className="tw">
            <table className="t">
              <thead><tr><th>Copybook</th><th className="num">Lines</th><th>Used by</th></tr></thead>
              <tbody>
                {sys.copybooks.map((c) => (
                  <tr key={c.name}><td className="mono">{c.name}</td><td className="num">{c.lines}</td><td className="mono" style={{ fontSize: 12.5 }}>{c.usedBy.join(", ") || <span className="chip warn plain">unused</span>}</td></tr>
                ))}
                {!sys.copybooks.length && <tr><td colSpan={3} className="dimtxt">No copybook imported.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
        <section className="panel tight">
          <div className="hd"><h2>Jobs and missing programs</h2></div>
          <div className="bd stack" style={{ gap: 10, fontSize: 13.5 }}>
            {sys.jobs.map((j) => (
              <div key={j.name}>
                <b className="mono">{j.name}</b> <span className="muted">{j.comment?.toLowerCase()}</span>
                <div className="mono dim" style={{ fontSize: 12 }}>{j.steps.map((s) => `${s.name} → ${s.program}`).join(" · ")}</div>
              </div>
            ))}
            {sys.missingPrograms.length > 0 && (
              <div className="flash info" style={{ margin: 0 }}>
                <span>!</span>
                <span>Not in the sources: {sys.missingPrograms.map((m) => `${m.name} (called by ${m.calledBy.join(", ")})`).join("; ")}. Import them to complete the map.</span>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
