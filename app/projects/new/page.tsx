// SPDX-License-Identifier: AGPL-3.0-only
import { Crumbs, Flash } from "@/components/app/ui";
import { SubmitButton } from "@/components/app/SubmitButton";
import { createProjectAction } from "../../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "New project" };

export default async function NewProject({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const sp = await searchParams;
  return (
    <>
      <Crumbs items={[{ href: "/", label: "Projects" }, { label: "New project" }]} />
      <div className="ph">
        <div>
          <h1>New project</h1>
          <p>One project = one coherent set of programs (a business domain, a nightly batch). A small set that is proven beats a large set that is half understood.</p>
        </div>
      </div>
      <Flash error={sp.error} />
      <form action={createProjectAction} className="cols">
        <div className="stack">
          <section className="panel">
            <div className="hd"><h2>Project</h2></div>
            <div className="bd form">
              <label className="field">Project name
                <input name="name" required maxLength={120} placeholder="Savings accounts" />
              </label>
              <label className="field">Description (optional)
                <input name="description" maxLength={300} placeholder="Interest, fees and nightly batch of the savings domain" />
              </label>
            </div>
          </section>
          <section className="panel">
            <div className="hd"><h2>Source code</h2><span className="sp" /><small>.cbl · .cob · .cpy · .jcl</small></div>
            <div className="bd form">
              <div className="drop">
                <label className="field">Upload files (several at once)
                  <input type="file" name="files" multiple accept=".cbl,.cob,.cobol,.cpy,.copy,.jcl" />
                </label>
              </div>
              <label className="field">Or paste a program
                <textarea name="pasted" spellCheck={false} placeholder={"       IDENTIFICATION DIVISION.\n       PROGRAM-ID. MYPROG.\n       ..."} />
              </label>
              <label className="field">Name of the pasted file (optional)
                <input name="pastedName" placeholder="MYPROG.cbl" />
                <span className="help">Otherwise the name comes from the PROGRAM-ID.</span>
              </label>
              <label className="row" style={{ fontSize: 14, color: "var(--fg-2)" }}>
                <input type="checkbox" name="withSample" /> Also add the example banking system (fictional)
              </label>
            </div>
          </section>
        </div>
        <div className="stack">
          <section className="panel">
            <div className="hd"><h2>Java conventions of the team</h2></div>
            <div className="bd form">
              <label className="field">Rounding of ROUNDED computations
                <select name="rounding" defaultValue="HALF_UP">
                  <option value="HALF_UP">HALF_UP (same as COBOL)</option>
                  <option value="HALF_EVEN">HALF_EVEN (banker&apos;s rounding)</option>
                </select>
                <span className="help">Many Java teams mandate HALF_EVEN. COBOL ROUNDED sends halves up: the verification shows exactly which cases change.</span>
              </label>
              <label className="field">Size overflow
                <select name="overflow" defaultValue="reproduce">
                  <option value="reproduce">Reproduce the COBOL truncation</option>
                  <option value="ignore">Natural Java (no limit)</option>
                </select>
              </label>
              <label className="field">Java package
                <input name="package" defaultValue="com.example.migration" pattern="[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*" />
              </label>
              <SubmitButton className="btn lg" pending="Creating and analyzing…">Create the project</SubmitButton>
            </div>
          </section>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>Everything stays on this machine: files and results are stored in a local SQLite database.</p>
        </div>
      </form>
    </>
  );
}
