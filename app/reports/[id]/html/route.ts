// SPDX-License-Identifier: AGPL-3.0-only
import { getProject, getReport, ready } from "@/lib/services";
import { reportHtml } from "@/lib/report-html";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await ready();
  const r = getReport(Number((await params).id));
  if (!r) return new Response("Report not found", { status: 404 });
  const html = reportHtml(r, { isExample: !!getProject(r.projectId)?.isExample });
  const download = new URL(req.url).searchParams.has("download");
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...(download ? { "content-disposition": `attachment; filename="mue-report-${r.program}-${r.id}.html"` } : {}),
    },
  });
}
