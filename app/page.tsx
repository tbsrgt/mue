// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";
import { Crumbs, Icon } from "@/components/app/ui";
import { SubmitButton } from "@/components/app/SubmitButton";
import { dashboard, listProjects, ready } from "@/lib/services";
import { newExampleAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Projects" };

export default async function ProjectsPage() {
  await ready();
  const projects = listProjects().map((p) => ({ p, d: dashboard(p.id) }));
  return (
    <>
      <Crumbs items={[{ label: "Projects" }]} />
      <div className="ph">
        <div>
          <h1>Migration projects</h1>
          <p>Each project groups a set of COBOL programs with their copybooks and jobs. Mue explains them, converts them to Java and proves equivalence, program by program.</p>
        </div>
        <span className="sp" />
        <div className="actions">
          <form action={newExampleAction}>
            <SubmitButton className="btn ghost" pending="Creating and analyzing…">Recreate the example</SubmitButton>
          </form>
          <Link href="/projects/new" className="btn">
            <Icon name="plus" /> New project
          </Link>
        </div>
      </div>
      <div className="projcards">
        {projects.map(({ p, d }) => (
          <Link key={p.id} href={`/projects/${p.id}`} className="projcard">
            <div className="row">
              {p.isExample && <span className="chip warn plain">Fictional example</span>}
              <span className="chip mut plain">{p.conventions.package}</span>
            </div>
            <h2>{p.name}</h2>
            {p.description && <p>{p.description}</p>}
            <div>
              <div className="pipe" aria-hidden="true">
                {(["verified", "converted", "explained"] as const).map((s) => (
                  <i key={s} className={`p-${s}`} style={{ width: `${d.rows.length ? (d.counts[s] / d.rows.length) * 100 : 0}%` }} />
                ))}
              </div>
            </div>
            <div className="meta">
              <span><b>{d.progress}%</b> migrated</span>
              <span><b>{d.rows.length}</b> programs</span>
              <span><b>{d.totals.lines.toLocaleString("en-US")}</b> lines</span>
              <span style={{ color: d.openDiscrepancies ? "var(--red)" : undefined }}>
                <b style={{ color: "inherit" }}>{d.openDiscrepancies}</b> open mismatches
              </span>
            </div>
          </Link>
        ))}
        {projects.length === 0 && (
          <div className="empty" style={{ gridColumn: "1 / -1" }}>
            <div className="glyph">NO PROJECT</div>
            <h3>Start with a set of programs</h3>
            <p>Create a project and import your .cbl, .cpy and .jcl files, or recreate the example banking system.</p>
            <Link href="/projects/new" className="btn">New project</Link>
          </div>
        )}
      </div>
    </>
  );
}
