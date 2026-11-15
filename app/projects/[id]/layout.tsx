// SPDX-License-Identifier: AGPL-3.0-only
import { notFound } from "next/navigation";
import { Crumbs } from "@/components/app/ui";
import { getProject, ready } from "@/lib/services";
import ProjectTabs from "./ProjectTabs";

export const dynamic = "force-dynamic";

export default async function ProjectLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  await ready();
  const { id } = await params;
  const project = getProject(Number(id));
  if (!project) notFound();
  return (
    <>
      <Crumbs items={[{ href: "/", label: "Projects" }, { href: `/projects/${project.id}`, label: project.name }]} />
      <div className="ph" style={{ marginBottom: 8 }}>
        <div>
          <div className="row" style={{ marginBottom: 6 }}>
            {project.isExample && <span className="chip warn plain">Fictional example</span>}
            <span className="chip mut plain">Rounding: {project.conventions.rounding}</span>
            <span className="chip mut plain">{project.conventions.package}</span>
          </div>
          <h1>{project.name}</h1>
          {project.description && <p>{project.description}</p>}
        </div>
      </div>
      <ProjectTabs id={project.id} />
      {children}
    </>
  );
}
