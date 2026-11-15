// SPDX-License-Identifier: AGPL-3.0-only
"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { addFiles, applyFix, convert, createExampleProject, createProject, deleteFile, deleteProject, explain, ready, sampleFiles, updateConventions, UserError, verify } from "@/lib/services";

const msg = (e: unknown) => (e instanceof UserError ? e.message : "Unexpected error: " + (e instanceof Error ? e.message : String(e)));
const back = (path: string, key: "error" | "ok", text: string) => `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(text)}`;

async function readUploads(formData: FormData) {
  const files: { name: string; source: string }[] = [];
  for (const f of formData.getAll("files")) {
    if (f instanceof File && f.size > 0) files.push({ name: f.name, source: await f.text() });
  }
  const pasted = String(formData.get("pasted") ?? "");
  const pastedName = String(formData.get("pastedName") ?? "").trim();
  if (pasted.trim()) {
    const id = /PROGRAM-ID\.\s*([A-Z0-9-]+)/i.exec(pasted)?.[1];
    files.push({ name: pastedName || (id ? `${id.toUpperCase()}.cbl` : "PASTED.cbl"), source: pasted });
  }
  return files;
}

function conventionsFrom(formData: FormData) {
  return {
    rounding: formData.get("rounding") === "HALF_EVEN" ? ("HALF_EVEN" as const) : ("HALF_UP" as const),
    overflow: formData.get("overflow") === "ignore" ? ("ignore" as const) : ("reproduce" as const),
    package: String(formData.get("package") ?? "").trim() || "com.example.migration",
  };
}

export async function createProjectAction(formData: FormData) {
  await ready();
  let id: number;
  try {
    id = createProject({ name: String(formData.get("name") ?? ""), description: String(formData.get("description") ?? ""), conventions: conventionsFrom(formData) });
    const files = await readUploads(formData);
    if (formData.get("withSample") === "on") files.push(...sampleFiles());
    if (files.length) addFiles(id, files);
  } catch (e) {
    redirect(back("/projects/new", "error", msg(e)));
  }
  revalidatePath("/");
  redirect(`/projects/${id}`);
}

export async function newExampleAction() {
  await ready();
  const id = createExampleProject();
  await ready();
  revalidatePath("/");
  redirect(`/projects/${id}`);
}

export async function importFilesAction(projectId: number, formData: FormData) {
  const path = `/projects/${projectId}/files`;
  let text = "";
  try {
    const files = await readUploads(formData);
    if (!files.length) throw new UserError("Choose files or paste COBOL code.");
    const r = addFiles(projectId, files);
    if (!r.added.length && !r.replaced.length) throw new UserError(r.rejected.map((x) => `${x.name}: ${x.reason}`).join(" · ") || "No file imported.");
    text = `${r.added.length + r.replaced.length} file(s) imported${r.replaced.length ? `, ${r.replaced.length} replaced` : ""}.${r.rejected.length ? ` Rejected: ${r.rejected.map((x) => `${x.name} (${x.reason})`).join(", ")}.` : ""}`;
  } catch (e) {
    redirect(back(path, "error", msg(e)));
  }
  revalidatePath(`/projects/${projectId}`, "layout");
  redirect(back(path, "ok", text));
}

export async function deleteFileAction(projectId: number, fileId: number) {
  deleteFile(projectId, fileId);
  revalidatePath(`/projects/${projectId}`, "layout");
  redirect(`/projects/${projectId}/files`);
}

function programPath(projectId: number, program: string, view: string) {
  return `/projects/${projectId}/programs/${program}?view=${view}`;
}

export async function explainAction(projectId: number, program: string) {
  try {
    await explain(projectId, program);
  } catch (e) {
    redirect(back(programPath(projectId, program, "understand"), "error", msg(e)));
  }
  revalidatePath(`/projects/${projectId}`, "layout");
  redirect(programPath(projectId, program, "understand"));
}

export async function convertAction(projectId: number, program: string) {
  try {
    await convert(projectId, program);
  } catch (e) {
    redirect(back(programPath(projectId, program, "convert"), "error", msg(e)));
  }
  revalidatePath(`/projects/${projectId}`, "layout");
  redirect(programPath(projectId, program, "convert"));
}

export async function verifyAction(projectId: number, program: string) {
  try {
    await verify(projectId, program);
  } catch (e) {
    redirect(back(programPath(projectId, program, "verify"), "error", msg(e)));
  }
  revalidatePath(`/projects/${projectId}`, "layout");
  redirect(programPath(projectId, program, "verify"));
}

export async function applyFixAction(projectId: number, program: string, reportId: number, groupIndex: number, scope: "program" | "project") {
  let text = "";
  try {
    await applyFix(projectId, reportId, groupIndex, scope);
    text = scope === "project" ? "Fix applied to the whole project; programs converted again and replayed." : "Fix applied; program converted again and replayed.";
  } catch (e) {
    redirect(back(programPath(projectId, program, "verify"), "error", msg(e)));
  }
  revalidatePath(`/projects/${projectId}`, "layout");
  redirect(back(programPath(projectId, program, "verify"), "ok", text));
}

export async function updateConventionsAction(projectId: number, formData: FormData) {
  const path = `/projects/${projectId}/settings`;
  try {
    updateConventions(projectId, conventionsFrom(formData));
  } catch (e) {
    redirect(back(path, "error", msg(e)));
  }
  revalidatePath(`/projects/${projectId}`, "layout");
  redirect(back(path, "ok", "Conventions saved. Convert the programs again to apply them."));
}

export async function deleteProjectAction(projectId: number) {
  deleteProject(projectId);
  revalidatePath("/");
  redirect("/");
}
