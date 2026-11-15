// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";
import { notFound } from "next/navigation";
import { Crumbs } from "@/components/app/ui";
import { reportHtml } from "@/lib/report-html";
import { getProject, getReport, ready } from "@/lib/services";

export const dynamic = "force-dynamic";
export const metadata = { title: "Equivalence report" };

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  await ready();
  const r = getReport(Number((await params).id));
  if (!r) notFound();
  const p = getProject(r.projectId);
  const html = reportHtml(r, { isExample: !!p?.isExample, printBar: false });
  return (
    <>
      <Crumbs items={[{ href: "/", label: "Projects" }, { href: `/projects/${r.projectId}`, label: p?.name ?? "Project" }, { href: `/projects/${r.projectId}/programs/${r.program}?view=verify`, label: r.program }, { label: `Report #${r.id}` }]} />
      <div className="ph">
        <div>
          <h1>Equivalence report #{r.id}</h1>
          <p>Standalone document, printable and exportable, ready for an audit file.</p>
        </div>
        <span className="sp" />
        <div className="actions">
          <Link className="btn ghost" href={`/projects/${r.projectId}/programs/${r.program}?view=verify`}>Back to the program</Link>
          <a className="btn ghost" href={`/reports/${r.id}/html?download=1`}>Download (HTML)</a>
          <a className="btn" href={`/reports/${r.id}/html`} target="_blank" rel="noopener">Open to print</a>
        </div>
      </div>
      <iframe title={`Equivalence report ${r.program}`} srcDoc={html} style={{ width: "100%", height: "calc(100vh - 210px)", minHeight: 640, border: "1px solid var(--line)", borderRadius: 0, background: "#f6f6f6" }} />
    </>
  );
}
