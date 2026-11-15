import { describe, expect, it } from "vitest";
import { runCobol } from "../lib/cobol/interpreter";
import { runJava } from "../lib/java/executor";
import { verifyProgram } from "../lib/verify/harness";
import type { TestCase } from "../lib/verify/runtime";
import { loadSystem, transpileAll } from "./helpers";

const tc = (inputs: Record<string, string>): TestCase => ({ id: 1, category: "random", inputs, sqlSelect: {}, sqlNotFound: false, cursors: {} });

describe("COBOL interpreter and Java model", () => {
  const sys = loadSystem();
  const javas = transpileAll(sys);
  const out = ["LK-INTEREST", "LK-RETURN-CODE"];
  const tie = { "ACCT-STATUS": "A", "ACCT-BALANCE": "1234.50", "ACCT-RATE": "1.0000", "LK-DAYS": "365" };

  it("ROUNDED sends the half-cent up on the COBOL side", () => {
    // 1,234.50 × 1% × 365 days ÷ 36,500 = 12.345 → 12.35
    const r = runCobol(sys.asts, "CALCINT", tc(tie), out);
    expect(r.fields["LK-INTEREST"]).toBe("12.35");
    expect(r.fields["LK-RETURN-CODE"]).toBe("00");
  });

  it("Java HALF_EVEN gives 12.34 on the same case", () => {
    const r = runJava(javas, "CALCINT", tc(tie), out);
    expect(r.fields["LK-INTEREST"]).toBe("12.34");
  });

  it("truncates without ROUNDED", () => {
    const r = runCobol(sys.asts, "ACCTFEES", tc({ "LK-AVG-BALANCE": "100.00", "LK-MONTHS": "3", "LK-SEGMENT": "PRE" }), ["LK-TOTAL-FEES"]);
    // 3 × 4.20 = 12.60; 15 % discount = 1.89; total 10.71
    expect(r.fields["LK-TOTAL-FEES"]).toBe("10.71");
  });

  it("detects the infinite loop when a PIC 9(2) counter wraps around to zero", () => {
    const r = runCobol(sys.asts, "ACCTFEES", tc({ "LK-AVG-BALANCE": "100.00", "LK-MONTHS": "99", "LK-SEGMENT": "STD" }), ["LK-TOTAL-FEES"]);
    expect(r.status).toBe("loop");
    expect(runJava(javas, "ACCTFEES", tc({ "LK-AVG-BALANCE": "100.00", "LK-MONTHS": "99", "LK-SEGMENT": "STD" }), ["LK-TOTAL-FEES"]).status).toBe("loop");
  });
});

describe("equivalence harness", () => {
  const sys = loadSystem();

  it("CALCINT: finds the HALF_EVEN mismatches, then 2,400 / 2,400 identical after the fix", () => {
    const before = verifyProgram(sys.asts, transpileAll(sys), "CALCINT", { total: 2400 });
    expect(before.total).toBe(2400);
    expect(before.mismatches).toBeGreaterThan(0);
    expect(before.groups[0]).toMatchObject({ kind: "rounding-tie", program: "CALCINT", field: "LK-INTEREST", javaMode: "HALF_EVEN" });
    expect(before.groups[0].examples[0].raw).toMatch(/5$/);
    expect(before.byCategory.find((c) => c.category === "half-cent")!.mismatches).toBeGreaterThan(0);

    const after = verifyProgram(sys.asts, transpileAll(sys, { CALCINT: { rounding: "HALF_UP" } }), "CALCINT", { total: 2400 });
    expect(after.total).toBe(2400);
    expect(after.identical).toBe(2400);
    expect(after.mismatches).toBe(0);
  });

  it("NIGHTINT: a mismatch is traced back to the CALCINT statement it calls", () => {
    // Balance × rate = 547.5 and 91 days give exactly 1.365: HALF_UP 1.37, HALF_EVEN 1.36.
    const recorded = [{ inputs: {}, cursors: { "C-ACCOUNTS": [{ "ACCT-NUMBER": "00000000042", "ACCT-STATUS": "A", "ACCT-BALANCE": "547.50", "ACCT-RATE": "1.0000" }] } }];
    const rep = verifyProgram(sys.asts, transpileAll(sys), "NIGHTINT", { count: 50, extraCases: recorded });
    const last = rep.byCategory.find((c) => c.category === "recorded")!;
    expect(last).toMatchObject({ total: 1, mismatches: 1 });
    expect(rep.groups[0]).toMatchObject({ program: "CALCINT", kind: "rounding-tie", line: 46 });
    const fixed = verifyProgram(sys.asts, transpileAll(sys, { CALCINT: { rounding: "HALF_UP" } }), "NIGHTINT", { count: 50, extraCases: recorded });
    expect(fixed.mismatches).toBe(0);
  });

  it("IBANCHK (no arithmetic) is equivalent from the first conversion", () => {
    const rep = verifyProgram(sys.asts, transpileAll(sys), "IBANCHK");
    expect(rep.mismatches).toBe(0);
    expect(rep.byCategory.find((c) => c.category === "boundary")!.total).toBeGreaterThan(5);
  });

  it("reports constructs that were not converted as their own cause", () => {
    const rep = verifyProgram(sys.asts, transpileAll(sys), "SEPAXFER", { count: 100 });
    expect(rep.mismatches).toBeGreaterThan(0);
    expect(rep.groups[0]).toMatchObject({ kind: "unsupported", program: "SEPAXFER", line: 28 });
  });

  it("is deterministic: same seed, same cases, same results", () => {
    const a = verifyProgram(sys.asts, transpileAll(sys), "LATEFEE");
    const b = verifyProgram(sys.asts, transpileAll(sys), "LATEFEE");
    expect(a.total).toBe(b.total);
    expect(a.mismatches).toBe(b.mismatches);
    expect(a.examples.map((e) => e.inputs)).toEqual(b.examples.map((e) => e.inputs));
  });
});
