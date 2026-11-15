import { describe, expect, it } from "vitest";
import { DEFAULT_CONVENTIONS } from "../lib/java/ir";
import { renderJava } from "../lib/java/render";
import { transpile } from "../lib/java/transpile";
import { loadSystem, transpileAll } from "./helpers";

describe("COBOL → Java transpiler", () => {
  const sys = loadSystem();
  const javas = transpileAll(sys);

  it("produces readable Java with business names and BigDecimal", () => {
    const r = renderJava(javas.get("CALCINT"), sys.asts.get("CALCINT")!, javas);
    const main = r.files[0].content;
    expect(r.files[0].name).toBe("SavingsInterestCalculation.java");
    expect(main).toContain("public class SavingsInterestCalculation");
    expect(main).toContain("private static final BigDecimal ANNUAL_BASIS");
    expect(main).toMatch(/account\.status\.equals\("B"\) \|\| account\.balance\.signum\(\) <= 0/);
    expect(main).toContain("RoundingMode.HALF_EVEN");
    expect(main).toContain("never called, not converted (dead code)");
    expect(r.files.map((f) => f.name)).toEqual(expect.arrayContaining(["Account.java", "Pic.java"]));
  });

  it("maps COBOL lines to Java lines", () => {
    const r = renderJava(javas.get("CALCINT"), sys.asts.get("CALCINT")!, javas);
    const lines = r.files[0].content.split("\n");
    const compute = r.mapping.find((m) => m.cobolStart === 46);
    expect(compute).toBeTruthy();
    const javaText = lines.slice(compute!.javaStart - 1, compute!.javaEnd).join("\n");
    expect(javaText).toContain("Pic.store(");
  });

  it("records the rounding decision and lists unsupported constructs", () => {
    const d = javas.get("CALCINT").decisions;
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ kind: "rounding", choice: "HALF_EVEN", matchesCobol: false });
    expect(javas.get("SEPAXFER").todos.some((t: { construct: string }) => t.construct === "GO TO")).toBe(true);
    expect(javas.get("STMTPRT").todos.filter((t: { blocking: boolean }) => t.blocking).length).toBeGreaterThan(3);
  });

  it("applies a fix program by program", () => {
    const fixed = transpileAll(sys, { CALCINT: { rounding: "HALF_UP" } });
    expect(fixed.get("CALCINT").decisions[0]).toMatchObject({ choice: "HALF_UP", matchesCobol: true, source: "correction" });
    const r = renderJava(fixed.get("CALCINT"), sys.asts.get("CALCINT")!, fixed);
    expect(r.files[0].content).toContain("RoundingMode.HALF_UP");
  });

  it("defaults to COBOL-exact conventions", () => {
    const ir = transpile(sys.asts.get("CALCINT")!, { system: sys.asts, conventions: DEFAULT_CONVENTIONS });
    expect(ir.decisions[0]).toMatchObject({ choice: "HALF_UP", matchesCobol: true, source: "convention" });
  });

  it("ships the runtime files the converted code needs", () => {
    const names = (id: string) => renderJava(javas.get(id), sys.asts.get(id)!, javas).files.map((f) => f.name);
    expect(names("LATEFEE")).toEqual(expect.arrayContaining(["Pic.java", "Sql.java"]));
    expect(names("SEPAXFER")).toEqual(expect.arrayContaining(["ExternalPrograms.java"]));
    expect(names("IBANCHK")).not.toContain("Sql.java");
  });
});
