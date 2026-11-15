import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analysisMarkdown, analyze, explain, loadSources, transpile, verificationHtml, verificationMarkdown, verify } from "../lib/index";
import { SAMPLES } from "./helpers";

const ROOT = path.join(import.meta.dirname, "..");

describe("public API", () => {
  const system = analyze(loadSources(SAMPLES));

  it("loads and analyzes a directory", () => {
    expect(system.programs.map((p) => p.id)).toEqual(["ACCTFEES", "CALCINT", "IBANCHK", "LATEFEE", "LOANPMT", "NIGHTINT", "SEPAXFER", "STMTPRT"]);
    expect(system.copybooks.map((c) => c.name).sort()).toEqual(["ACCTREC", "LOANREC", "XFERREC"]);
  });

  it("explains a program with business rules tied to source lines", async () => {
    const e = await explain(system, "CALCINT");
    expect(e.role).toMatch(/^Savings interest calculation for one account\./);
    expect(e.rules.some((r) => r.kind === "computation" && r.line === 46)).toBe(true);
    expect(analysisMarkdown(system, new Map([["CALCINT", e]]))).toContain("```mermaid");
  });

  it("transpiles every program", () => {
    const java = transpile(system, { conventions: { package: "org.acme.core" } });
    expect(java.get("CALCINT")!.files[0].content).toContain("package org.acme.core;");
    expect(java.get("SEPAXFER")!.todos.some((t) => t.blocking)).toBe(true);
  });

  it("verifies, skips what was not converted, and renders the reports", async () => {
    const run = await verify(system, { programs: ["IBANCHK", "SEPAXFER", "LATEFEE"], cases: 300, conventions: { rounding: "HALF_EVEN" } });
    const by = Object.fromEntries(run.programs.map((p) => [p.program, p]));
    expect(by.IBANCHK.status).toBe("equivalent");
    expect(by.SEPAXFER.status).toBe("skipped");
    expect(by.SEPAXFER.reason).toContain("GO TO");
    expect(by.LATEFEE.report!.total).toBe(300);
    expect(run.totals).toMatchObject({ programs: 3, skipped: 1 });
    expect(verificationMarkdown(run)).toContain("# Mue equivalence report");
    expect(verificationHtml(run)).toContain("<!doctype html>");
  });
});

describe("CLI", () => {
  const cli = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", path.join(ROOT, "cli/mue.ts"), ...args], { cwd: ROOT, encoding: "utf8" });

  it("exits 1 on mismatches and 0 once fixed, and writes the reports", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mue-"));
    const bad = cli("verify", "examples/banking", "--program", "CALCINT", "--cases", "600", "--rounding", "HALF_EVEN", "--report-dir", dir);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("--fix CALCINT=HALF_UP");
    const good = cli("verify", "examples/banking", "--program", "CALCINT", "--cases", "600", "--rounding", "HALF_EVEN", "--fix", "CALCINT=HALF_UP", "--report-dir", dir);
    expect(good.status).toBe(0);
    expect(good.stdout).toContain("600 / 600");
    for (const f of ["report.md", "report.html", "report.json"]) expect(fs.existsSync(path.join(dir, f))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("exits 2 on usage errors", () => {
    expect(cli("verify").status).toBe(2);
    expect(cli("verify", "examples/banking", "--rounding", "UP").status).toBe(2);
  });
});
