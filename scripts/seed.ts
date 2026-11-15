// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Resets the local Mue Studio database and recreates the example project.
 * Usage: npm run seed
 */
import fs from "node:fs";
import { DB_PATH } from "../lib/db";
import { dashboard, listProjects, ready } from "../lib/services";

async function main() {
  for (const f of [DB_PATH, DB_PATH + "-wal", DB_PATH + "-shm"]) if (fs.existsSync(f)) fs.rmSync(f);
  const t0 = Date.now();
  await ready();
  const p = listProjects()[0];
  const d = dashboard(p.id);
  console.log(`Database recreated: ${DB_PATH}`);
  console.log(`Project "${p.name}": ${d.rows.length} programs, ${d.progress}% migrated, ${d.openDiscrepancies} open mismatches (${Date.now() - t0} ms).`);
  for (const r of d.rows) console.log(`  ${r.program.padEnd(9)} ${r.stage.padEnd(11)} ${r.lastReport ? `${r.lastReport.total} cases, ${r.lastReport.mismatches} mismatches` : ""}`);
}

main();
