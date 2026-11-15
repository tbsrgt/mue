// SPDX-License-Identifier: AGPL-3.0-only
import { Flash } from "@/components/app/ui";
import { SubmitButton } from "@/components/app/SubmitButton";
import { getProject, ready } from "@/lib/services";
import { deleteProjectAction, updateConventionsAction } from "../../../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default async function SettingsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  await ready();
  const id = Number((await params).id);
  const sp = await searchParams;
  const p = getProject(id)!;
  return (
    <>
      <Flash error={sp.error} ok={sp.ok} />
      <div className="grid2">
        <section className="panel">
          <div className="hd"><h2>Conversion conventions</h2></div>
          <form action={updateConventionsAction.bind(null, id)} className="bd form">
            <label className="field">Rounding of ROUNDED computations
              <select name="rounding" defaultValue={p.conventions.rounding}>
                <option value="HALF_UP">HALF_UP (same as COBOL)</option>
                <option value="HALF_EVEN">HALF_EVEN (banker&apos;s rounding)</option>
              </select>
              <span className="help">A fix applied to a single program takes precedence over this convention.</span>
            </label>
            <label className="field">Size overflow without ON SIZE ERROR
              <select name="overflow" defaultValue={p.conventions.overflow}>
                <option value="reproduce">Reproduce the COBOL truncation (Pic.store)</option>
                <option value="ignore">Natural Java (setScale only)</option>
              </select>
            </label>
            <label className="field">Java package
              <input name="package" defaultValue={p.conventions.package} required />
            </label>
            <SubmitButton pending="Saving…">Save</SubmitButton>
          </form>
        </section>
        <section className="panel">
          <div className="hd"><h2>Danger zone</h2></div>
          <div className="bd form">
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>Deleting the project removes its files, conversions, reports and activity log from the local database. This cannot be undone.</p>
            <form action={deleteProjectAction.bind(null, id)}>
              <SubmitButton className="btn danger" pending="Deleting…">Delete the project</SubmitButton>
            </form>
          </div>
        </section>
      </div>
    </>
  );
}
