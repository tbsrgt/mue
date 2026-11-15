// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";
import { Flash, fmtWhen } from "@/components/app/ui";
import { SubmitButton } from "@/components/app/SubmitButton";
import { highlightLine } from "@/components/app/highlight";
import { listFiles, ready } from "@/lib/services";
import { deleteFileAction, importFilesAction } from "../../../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Files" };

const KIND = { program: "Program", copybook: "Copybook", jcl: "JCL job" } as const;

export default async function FilesPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ f?: string; error?: string; ok?: string }> }) {
  await ready();
  const id = Number((await params).id);
  const sp = await searchParams;
  const files = listFiles(id);
  const open = sp.f ? files.find((f) => f.id === Number(sp.f)) : undefined;
  const base = `/projects/${id}/files`;
  return (
    <>
      <Flash error={sp.error} ok={sp.ok} />
      <div className="cols">
        <div className="stack">
          <section className="panel tight">
            <div className="hd"><h2>Source files</h2><span className="sp" /><small>{files.length} file{files.length === 1 ? "" : "s"}</small></div>
            <div className="tw">
              <table className="t">
                <thead><tr><th>File</th><th>Type</th><th className="num">Lines</th><th>Imported</th><th /></tr></thead>
                <tbody>
                  {files.map((f) => (
                    <tr key={f.id}>
                      <td><Link className="pg" href={`${base}?f=${f.id}#source`}>{f.name}</Link></td>
                      <td><span className={`chip plain ${f.kind === "program" ? "warn" : "mut"}`}>{KIND[f.kind]}</span></td>
                      <td className="num">{f.lines}</td>
                      <td className="mono dimtxt" style={{ fontSize: 12 }}>{fmtWhen(f.createdAt)}</td>
                      <td style={{ textAlign: "right" }}>
                        <form action={deleteFileAction.bind(null, id, f.id)}>
                          <SubmitButton className="btn danger sm" pending="…" aria-label={`Delete ${f.name}`}>Delete</SubmitButton>
                        </form>
                      </td>
                    </tr>
                  ))}
                  {!files.length && <tr><td colSpan={5} className="dimtxt" style={{ padding: 24, textAlign: "center" }}>No file yet. Import your first set on the right.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
          {open && (
            <section className="codebox" id="source">
              <div className="cbh"><span>{open.name}</span><span className="sp" /><span>{open.lines} lines</span></div>
              <div className="scroller">
                <pre className={`code ${open.kind === "jcl" ? "java" : "cobol"}`}>
                  {open.source.replace(/\n$/, "").split("\n").map((l, i) => {
                    const cm = /^.{6}[*/]/.test(l) || l.startsWith("//*");
                    return (
                      <div key={i} className={`l${cm ? " cm" : ""}`} id={`L${i + 1}`}>
                        <i>{i + 1}</i>
                        <span>{cm || open.kind === "jcl" ? l : highlightLine(l, "cobol")}</span>
                      </div>
                    );
                  })}
                </pre>
              </div>
            </section>
          )}
        </div>
        <section className="panel">
          <div className="hd"><h2>Import</h2><span className="sp" /><small>.cbl · .cob · .cpy · .jcl</small></div>
          <form action={importFilesAction.bind(null, id)} className="bd form">
            <div className="drop">
              <label className="field">Files (several at once)
                <input type="file" name="files" multiple accept=".cbl,.cob,.cobol,.cpy,.copy,.jcl" />
              </label>
            </div>
            <label className="field">Or paste code
              <textarea name="pasted" spellCheck={false} placeholder={"       IDENTIFICATION DIVISION.\n       PROGRAM-ID. MYPROG."} />
            </label>
            <label className="field">Name of the pasted file (optional)
              <input name="pastedName" placeholder="MYPROG.cbl or MYCOPY.cpy" />
            </label>
            <SubmitButton pending="Importing and analyzing…">Import</SubmitButton>
            <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>A file with the same name is replaced; the programs concerned go back to &quot;not analyzed&quot;. EBCDIC files must be converted to text before import.</p>
          </form>
        </section>
      </div>
    </>
  );
}
