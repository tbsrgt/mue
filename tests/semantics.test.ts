/**
 * Edge cases of the supported COBOL subset. Every case runs through BOTH engines (the COBOL
 * interpreter and the Java model generated from the transpiler IR) with COBOL-exact
 * conventions, and checks the expected value and that both sides agree.
 */
import { describe, expect, it } from "vitest";
import { runCobol } from "../lib/cobol/interpreter";
import { parseProgram } from "../lib/cobol/parser";
import { runJava } from "../lib/java/executor";
import { DEFAULT_CONVENTIONS, type Conventions } from "../lib/java/ir";
import { renderJava } from "../lib/java/render";
import { transpile } from "../lib/java/transpile";
import type { TestCase } from "../lib/verify/runtime";

/** Wraps data items and statements into a fixed-format program. */
function program(data: string, procedure: string): string {
  const indent = (s: string, n: number) =>
    s
      .trim()
      .split("\n")
      .map((l) => " ".repeat(n) + l.trim())
      .join("\n");
  return [
    "       IDENTIFICATION DIVISION.",
    "       PROGRAM-ID. EDGE.",
    "       DATA DIVISION.",
    "       WORKING-STORAGE SECTION.",
    indent(data, 7),
    "       PROCEDURE DIVISION.",
    "       0000-MAIN.",
    indent(procedure, 11),
    "           GOBACK.",
    "",
  ].join("\n");
}

function run(data: string, procedure: string, outputs: string[], inputs: Record<string, string> = {}, conventions: Partial<Conventions> = {}) {
  const ast = parseProgram(program(data, procedure), { file: "EDGE.cbl" });
  expect(ast.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
  const system = new Map([[ast.id, ast]]);
  const ir = transpile(ast, { system, conventions: { ...DEFAULT_CONVENTIONS, ...conventions } });
  const tc: TestCase = { id: 1, category: "random", inputs, sqlSelect: {}, sqlNotFound: false, cursors: {} };
  const cobol = runCobol(system, ast.id, tc, outputs);
  const java = runJava(new Map([[ast.id, ir]]), ast.id, tc, outputs);
  return { cobol, java, ir };
}

/**
 * Runs both engines, asserts they agree, and returns the COBOL result. When both stop
 * abnormally the same way (endless loop, abend), only the status is compared: the state at
 * the moment of the stop is not meaningful, and the harness ignores it too.
 */
function both(data: string, procedure: string, outputs: string[], inputs: Record<string, string> = {}) {
  const { cobol, java } = run(data, procedure, outputs, inputs);
  expect(java.status).toBe(cobol.status);
  if (cobol.status !== "ok") return cobol;
  expect(java.fields).toEqual(cobol.fields);
  expect(java.displays).toEqual(cobol.displays);
  return cobol;
}

/** Java source rendered from the same IR. */
function javaText(data: string, procedure: string): string {
  const ast = parseProgram(program(data, procedure), { file: "EDGE.cbl" });
  const system = new Map([[ast.id, ast]]);
  const ir = transpile(ast, { system, conventions: DEFAULT_CONVENTIONS });
  return renderJava(ir, ast, new Map([[ast.id, ir]])).files[0].content;
}

describe("rounding", () => {
  it("ROUNDED rounds half away from zero, for positive and negative results", () => {
    const r = both("77 A PIC S9(3)V999.\n77 P PIC S9(3)V99.\n77 N PIC S9(3)V99.", "COMPUTE P ROUNDED = A\nCOMPUTE N ROUNDED = 0 - A", ["P", "N"], { A: "2.345" });
    expect(r.fields).toEqual({ P: "2.35", N: "-2.35" });
  });

  it("without ROUNDED, decimals are truncated toward zero", () => {
    const r = both("77 A PIC S9(3)V999.\n77 P PIC S9(3)V99.\n77 N PIC S9(3)V99.", "COMPUTE P = A\nCOMPUTE N = 0 - A", ["P", "N"], { A: "2.349" });
    expect(r.fields).toEqual({ P: "2.34", N: "-2.34" });
  });

  it("a team convention of HALF_EVEN only differs on exact ties with an even digit", () => {
    const data = "77 A PIC 9(3)V999.\n77 P PIC 9(3)V99.";
    const at = (a: string) => run(data, "COMPUTE P ROUNDED = A", ["P"], { A: a }, { rounding: "HALF_EVEN" });
    expect(at("2.345").java.fields.P).toBe("2.34");
    expect(at("2.345").cobol.fields.P).toBe("2.35");
    expect(at("2.355").java.fields.P).toBe(at("2.355").cobol.fields.P); // 2.36 on both sides
    expect(at("2.346").java.fields.P).toBe(at("2.346").cobol.fields.P); // not a tie
  });

  it("divisions keep enough intermediate precision before the final rounding", () => {
    const r = both("77 Q PIC 9V9(4).\n77 T PIC 9V9(4).\n77 U PIC 9(3)V99.", "COMPUTE Q ROUNDED = 2 / 3\nCOMPUTE T = 2 / 3\nCOMPUTE U ROUNDED = 100 / 3 * 3", ["Q", "T", "U"]);
    expect(r.fields).toEqual({ Q: "0.6667", T: "0.6666", U: "100.00" });
  });

  it("DIVIDE ... GIVING ... REMAINDER uses the stored quotient", () => {
    const r = both("77 Q PIC 9(3).\n77 R PIC 9(3).", "DIVIDE 17 BY 5 GIVING Q REMAINDER R", ["Q", "R"]);
    expect(r.fields).toEqual({ Q: "3", R: "2" });
    expect(javaText("77 Q PIC 9(3).\n77 R PIC 9(3).", "DIVIDE 17 BY 5 GIVING Q REMAINDER R")).toMatch(/q = [^;]+;\n\s+r = [^;]*q\.multiply/);
  });
});

describe("statements with several targets", () => {
  it("COMPUTE A B = A + 1 evaluates the expression once, before storing", () => {
    const r = both("77 A PIC 9(3).\n77 B PIC 9(3).", "COMPUTE A B = A + 1", ["A", "B"], { A: "41" });
    expect(r.fields).toEqual({ A: "42", B: "42" });
    // The rendered Java must not read the new value of A when computing B.
    expect(javaText("77 A PIC 9(3).\n77 B PIC 9(3).", "COMPUTE A B = A + 1")).toMatch(/BigDecimal value = [^;]+;\n\s+BigDecimal value2 = [^;]+;\n\s+a = Pic\.store\(value, PIC_A\);\n\s+b = Pic\.store\(value2, PIC_B\);/);
  });

  it("ADD A TO A B adds the original value of A to B", () => {
    const r = both("77 A PIC 9(3).\n77 B PIC 9(3).", "ADD A TO A B", ["A", "B"], { A: "5", B: "10" });
    expect(r.fields).toEqual({ A: "10", B: "15" });
  });

  it("ON SIZE ERROR with several targets stores the ones that fit and keeps the others", () => {
    const data = "77 A PIC 9(3).\n77 B PIC 9.\n77 C PIC 9(3) VALUE 1.\n77 F PIC X VALUE 'N'.";
    const proc = "COMPUTE B C = A * 2\n  ON SIZE ERROR MOVE 'Y' TO F\nEND-COMPUTE";
    const r = both(data, proc, ["B", "C", "F"], { A: "40" });
    expect(r.fields).toEqual({ B: "0", C: "80", F: "Y" });
    expect(javaText(data, proc)).toContain("boolean sizeError = false;");
  });
});

describe("PIC truncation", () => {
  it("drops high-order digits silently without ON SIZE ERROR", () => {
    const r = both("77 A PIC 9(5).\n77 B PIC 9(3).", "COMPUTE B = A + 1", ["B"], { A: "1233" });
    expect(r.fields.B).toBe("234");
    expect(r.overflows).toHaveLength(1);
  });

  it("ON SIZE ERROR leaves the target unchanged and runs the handler", () => {
    const r = both("77 A PIC 9(5).\n77 B PIC 9(3) VALUE 7.\n77 F PIC X VALUE 'N'.", "COMPUTE B = A * 10\n  ON SIZE ERROR MOVE 'Y' TO F\nEND-COMPUTE", ["B", "F"], { A: "500" });
    expect(r.fields).toEqual({ B: "7", F: "Y" });
  });

  it("NOT ON SIZE ERROR runs when the value fits", () => {
    const r = both("77 A PIC 9(5).\n77 B PIC 9(3).\n77 F PIC X VALUE 'N'.", "ADD 1 TO A GIVING B\n  ON SIZE ERROR MOVE 'Y' TO F\n  NOT ON SIZE ERROR MOVE 'K' TO F\nEND-ADD", ["B", "F"], { A: "41" });
    expect(r.fields).toEqual({ B: "42", F: "K" });
  });

  it("MOVE truncates alphanumeric fields on the right and pads with spaces", () => {
    const r = both("77 S PIC X(3).\n77 L PIC X(6).", "MOVE 'ABCDEF' TO S\nMOVE 'AB' TO L\nDISPLAY '[' L ']'", ["S", "L"]);
    expect(r.fields).toEqual({ S: "ABC", L: "AB" });
    expect(r.displays).toEqual(["[AB    ]"]);
  });

  it("a numeric MOVE to an alphanumeric field keeps the digits, without sign or point", () => {
    const r = both("77 N PIC S9(3)V99.\n77 S PIC X(5).", "MOVE N TO S", ["S"], { N: "-12.34" });
    expect(r.fields.S).toBe("01234");
  });
});

describe("signs", () => {
  it("an unsigned PIC loses the sign, a signed PIC keeps it", () => {
    const r = both("77 U PIC 9(3).\n77 S PIC S9(3).", "COMPUTE U = 3 - 8\nCOMPUTE S = 3 - 8", ["U", "S"]);
    expect(r.fields).toEqual({ U: "5", S: "-5" });
  });

  it("sign conditions: POSITIVE, NEGATIVE, ZERO", () => {
    const r = both("77 A PIC S9(3).\n77 R PIC X(3).", "EVALUATE TRUE\n  WHEN A IS POSITIVE MOVE 'POS' TO R\n  WHEN A IS NEGATIVE MOVE 'NEG' TO R\n  WHEN OTHER MOVE 'ZER' TO R\nEND-EVALUATE", ["R"], { A: "-4" });
    expect(r.fields.R).toBe("NEG");
  });
});

describe("COMP-3 (packed decimal)", () => {
  it("is parsed as COMP-3 and behaves like the same PIC in DISPLAY usage", () => {
    const data = "77 P PIC S9(5)V99 COMP-3.\n77 D PIC S9(5)V99.\n77 B PIC S9(5)V99 PACKED-DECIMAL.";
    const ast = parseProgram(program(data, "CONTINUE"), { file: "EDGE.cbl" });
    expect(ast.fields.get("P")?.usage).toBe("COMP-3");
    expect(ast.fields.get("B")?.usage).toBe("PACKED-DECIMAL");
    const r = both(data, "COMPUTE P ROUNDED = 123456.785\nCOMPUTE D ROUNDED = 123456.785\nCOMPUTE B = P * 2", ["P", "D", "B"]);
    // 123456.785 does not fit S9(5)V99: the high-order digit is dropped in both usages.
    expect(r.fields).toEqual({ P: "23456.79", D: "23456.79", B: "46913.58" });
  });
});

describe("PERFORM VARYING", () => {
  it("sums with a VARYING counter", () => {
    const r = both("77 I PIC 9(3).\n77 T PIC 9(5).", "PERFORM VARYING I FROM 1 BY 1 UNTIL I > 10\n  ADD I TO T\nEND-PERFORM", ["I", "T"]);
    expect(r.fields).toEqual({ I: "11", T: "55" });
  });

  it("steps by more than one", () => {
    const r = both("77 I PIC 9(3).\n77 T PIC 9(5).", "PERFORM VARYING I FROM 1 BY 2 UNTIL I > 9\n  ADD I TO T\nEND-PERFORM", ["I", "T"]);
    expect(r.fields).toEqual({ I: "11", T: "25" });
  });

  it("does not run the body when the condition is already true (TEST BEFORE)", () => {
    const r = both("77 I PIC 9(3).\n77 T PIC 9(5).", "PERFORM VARYING I FROM 5 BY 1 UNTIL I > 3\n  ADD 1 TO T\nEND-PERFORM", ["I", "T"]);
    expect(r.fields).toEqual({ I: "5", T: "0" });
  });

  it("PERFORM n TIMES and PERFORM UNTIL", () => {
    const r = both("77 N PIC 9(3).\n77 T PIC 9(5).", "PERFORM 4 TIMES\n  ADD 3 TO T\nEND-PERFORM\nPERFORM UNTIL N >= 7\n  ADD 2 TO N\nEND-PERFORM", ["N", "T"]);
    expect(r.fields).toEqual({ N: "8", T: "12" });
  });

  it("a counter too short for its limit wraps around: both sides report the endless loop", () => {
    const r = both("77 I PIC 9.\n77 T PIC 9(5).", "PERFORM VARYING I FROM 1 BY 1 UNTIL I > 9\n  ADD 1 TO T\nEND-PERFORM", ["T"]);
    expect(r.status).toBe("loop");
  });
});

describe("EVALUATE", () => {
  const data = "77 A PIC 9(3).\n77 R PIC X(4).";
  const proc = "EVALUATE A\n  WHEN 0 MOVE 'ZERO' TO R\n  WHEN 1 THRU 9 MOVE 'ONE' TO R\n  WHEN 10 WHEN 20 MOVE 'TENS' TO R\n  WHEN OTHER MOVE 'BIG' TO R\nEND-EVALUATE";

  it.each([
    ["0", "ZERO"],
    ["1", "ONE"],
    ["9", "ONE"],
    ["10", "TENS"],
    ["20", "TENS"],
    ["11", "BIG"],
  ])("subject %s → %s (THRU ranges, stacked WHEN, OTHER)", (a, expected) => {
    expect(both(data, proc, ["R"], { A: a }).fields.R).toBe(expected);
  });

  it("EVALUATE TRUE takes the first matching WHEN only", () => {
    const r = both("77 A PIC 9(3).\n77 R PIC X(4).", "EVALUATE TRUE\n  WHEN A > 5 MOVE 'GT5' TO R\n  WHEN A > 2 MOVE 'GT2' TO R\nEND-EVALUATE", ["R"], { A: "8" });
    expect(r.fields.R).toBe("GT5");
  });

  it("EVALUATE on a string subject", () => {
    const r = both("77 C PIC X(2).\n77 L PIC 9(2).", "EVALUATE C\n  WHEN 'FR' WHEN 'MC' MOVE 27 TO L\n  WHEN 'DE' MOVE 22 TO L\n  WHEN OTHER MOVE 0 TO L\nEND-EVALUATE", ["L"], { C: "MC" });
    expect(r.fields.L).toBe("27");
  });

  it("EVALUATE ... ALSO is reported as unsupported, never guessed", () => {
    const { cobol, ir } = run("77 A PIC 9.\n77 B PIC 9.\n77 R PIC X.", "EVALUATE A ALSO B\n  WHEN 1 ALSO 2 MOVE 'X' TO R\nEND-EVALUATE", ["R"]);
    expect(cobol.status).toBe("unsupported");
    expect(ir.todos.some((t) => t.blocking && t.construct === "EVALUATE")).toBe(true);
  });
});

describe("level-88 conditions and SET", () => {
  it("SET ... TO TRUE and condition names with several values", () => {
    const data = "77 S PIC X(3).\n   88 PREMIUM VALUE 'PRE' 'PRV'.\n   88 YOUTH VALUE 'YTH'.\n77 R PIC X.";
    const r = both(data, "SET YOUTH TO TRUE\nIF PREMIUM\n  MOVE 'P' TO R\nELSE\n  MOVE 'O' TO R\nEND-IF", ["S", "R"]);
    expect(r.fields).toEqual({ S: "YTH", R: "O" });
  });
});
