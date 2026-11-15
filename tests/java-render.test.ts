/**
 * The rendered Java must compile and must behave like the Java model the harness runs.
 * These cases pin down constructs where the two used to drift apart, or where the rendered
 * Java did not compile. CI also compiles the converted example with javac and replays
 * CALCINT through it (see .github/workflows/ci.yml).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeSystem } from "../lib/cobol/analyze";
import { runCobol } from "../lib/cobol/interpreter";
import { parseProgram } from "../lib/cobol/parser";
import { runJava } from "../lib/java/executor";
import { DEFAULT_CONVENTIONS, type JProgram } from "../lib/java/ir";
import { programClassName } from "../lib/java/naming";
import { renderJava } from "../lib/java/render";
import { transpile } from "../lib/java/transpile";
import type { TestCase } from "../lib/verify/runtime";
import { loadSystem, transpileAll } from "./helpers";

const ROOT = path.join(import.meta.dirname, "..");
const tc = (inputs: Record<string, string> = {}): TestCase => ({ id: 1, category: "random", inputs, sqlSelect: {}, sqlNotFound: false, cursors: {} });

function source(id: string, data: string, procedure: string, linkage = "", using = ""): string {
  const indent = (s: string, n: number) =>
    s
      .trim()
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => " ".repeat(n) + l.trim())
      .join("\n");
  return [
    "       IDENTIFICATION DIVISION.",
    `       PROGRAM-ID. ${id}.`,
    "       DATA DIVISION.",
    "       WORKING-STORAGE SECTION.",
    data.trim() ? indent(data, 7) : "",
    linkage ? "       LINKAGE SECTION.\n" + indent(linkage, 7) : "",
    `       PROCEDURE DIVISION${using ? " USING " + using : ""}.`,
    indent(procedure, 7),
    "",
  ]
    .filter((l) => l !== "")
    .join("\n")
    .replace(/^ {7}\*/gm, "      *"); // comment lines: indicator in column 7
}

/** One program: its IR, its rendered main class, and both engines on one case. */
function one(data: string, procedure: string, outputs: string[] = [], inputs: Record<string, string> = {}) {
  const ast = parseProgram(source("EDGE", data, procedure), { file: "EDGE.cbl" });
  const system = new Map([[ast.id, ast]]);
  const ir = transpile(ast, { system, conventions: DEFAULT_CONVENTIONS });
  const java = renderJava(ir, ast, new Map([[ast.id, ir]])).files[0].content;
  const cobolRun = runCobol(system, ast.id, tc(inputs), outputs);
  const javaRun = runJava(new Map([[ast.id, ir]]), ast.id, tc(inputs), outputs);
  return { ast, ir, java, cobolRun, javaRun };
}

describe("rendered Java", () => {
  it("keeps the code after a construct that was not converted reachable", () => {
    const sys = loadSystem();
    const javas = transpileAll(sys);
    const main = renderJava(javas.get("STMTPRT"), sys.asts.get("STMTPRT")!, javas).files[0].content;
    // A bare `throw` followed by more statements is a javac "unreachable statement" error.
    expect(main).not.toContain("throw new UnsupportedOperationException");
    expect(main).toContain('Pic.notConverted("WRITE, line 42");');
  });

  it("drops statements after GOBACK instead of emitting unreachable code", () => {
    const { java } = one("01 WS-A PIC 9(3).", "0000-MAIN.\n    PERFORM 1000-STOP\n    GOBACK.\n1000-STOP.\n    GOBACK\n    MOVE 1 TO WS-A.");
    expect(java).toMatch(/throw new ProgramExit\(\);.*\n\s*\/\/ \(1 unreachable statement after GOBACK not converted\)/);
  });

  it("ends the program on a final GOBACK reached through a PERFORM", () => {
    // 9000-END is the last paragraph run() falls into, but 0000-MAIN also PERFORMs it: a plain
    // `return` there would let 0000-MAIN go on and set WS-A.
    const { java, cobolRun, javaRun } = one("01 WS-A PIC 9.", "0000-MAIN.\n    PERFORM 9000-END\n    MOVE 1 TO WS-A.\n9000-END.\n    GOBACK.", ["WS-A"]);
    expect(java).toMatch(/private void end\(\) \{\n\s*throw new ProgramExit\(\);/);
    expect(cobolRun.fields["WS-A"]).toBe("0");
    expect(javaRun.fields).toEqual(cobolRun.fields);
  });

  it("gives nested PERFORM ... TIMES loops their own counters, without shadowing fields", () => {
    const { java, cobolRun, javaRun } = one(
      "01 WS-I PIC 9(3).\n01 WS-N PIC 9(3).",
      "0000-MAIN.\n    PERFORM 2 TIMES\n        PERFORM 3 TIMES\n            ADD 1 TO WS-I\n        END-PERFORM\n    END-PERFORM\n    GOBACK.",
      ["WS-I"],
    );
    expect(java).not.toMatch(/for \(int i = 0/); // WS-I is the field `i`
    expect(java).toMatch(/for \(int i2 = 0, times = .*\.intValue\(\); i2 < times; i2\+\+\)/);
    expect(java).toMatch(/for \(int i3 = 0, times2 = /);
    expect(cobolRun.fields["WS-I"]).toBe("6");
    expect(javaRun.fields).toEqual(cobolRun.fields);
  });

  it("renders level-88 THRU ranges, like the Java model evaluates them", () => {
    const { java, cobolRun, javaRun } = one(
      "01 WS-AREA.\n    05 WS-CODE PIC 9(2).\n        88 WS-LOW VALUE 1 THRU 9.\n01 WS-R PIC X.",
      "0000-MAIN.\n    MOVE 5 TO WS-CODE\n    IF WS-LOW MOVE 'Y' TO WS-R ELSE MOVE 'N' TO WS-R END-IF\n    GOBACK.",
      ["WS-R"],
    );
    expect(java).toContain('(code.compareTo(BigDecimal.ONE) >= 0 && code.compareTo(new BigDecimal("9")) <= 0)');
    expect(cobolRun.fields["WS-R"]).toBe("Y");
    expect(javaRun.fields).toEqual(cobolRun.fields);
  });

  it("cuts a literal longer than its alphanumeric target, like the MOVE does", () => {
    const { java, cobolRun, javaRun } = one("01 WS-X PIC X(3).", "0000-MAIN.\n    MOVE 'ABCDEF' TO WS-X\n    GOBACK.", ["WS-X"]);
    expect(java).toContain('x = "ABC";');
    expect(cobolRun.fields["WS-X"]).toBe("ABC");
    expect(javaRun.fields).toEqual(cobolRun.fields);
  });

  it("passes pow() an int exponent", () => {
    expect(one("01 WS-A PIC 9(5).", "0000-MAIN.\n    COMPUTE WS-A = 3 ** 2\n    GOBACK.").java).toContain(".pow(2, MC)");
    // pow(2.0, MC) does not compile; intValueExact() also fails on 2.5 at run time, like the model.
    expect(one("01 WS-A PIC 9(5).", "0000-MAIN.\n    COMPUTE WS-A = 3 ** 2.0\n    GOBACK.").java).toContain('.pow(new BigDecimal("2.0").intValueExact(), MC)');
  });

  it("never emits duplicate case labels for repeated WHEN values", () => {
    const { java } = one(
      "01 WS-C PIC X(2).\n01 WS-N PIC 9.",
      "0000-MAIN.\n    EVALUATE WS-C\n        WHEN 'FR' MOVE 1 TO WS-N\n        WHEN 'FR' WHEN 'DE' MOVE 2 TO WS-N\n        WHEN OTHER MOVE 3 TO WS-N\n    END-EVALUATE\n    GOBACK.",
    );
    expect(java.match(/case "FR"/g)).toHaveLength(1);
    expect(java).toContain('case "DE" -> {');
  });

  it("prints a numeric literal the way BigDecimal.toPlainString does", () => {
    const { java, javaRun } = one("01 WS-A PIC 9.", "0000-MAIN.\n    DISPLAY 'RATE ' 1.50\n    GOBACK.");
    expect(java).toContain('new BigDecimal("1.50").toPlainString()');
    expect(javaRun.displays).toEqual(["RATE 1.50"]);
  });

  it("initializes a whole table with Arrays.fill", () => {
    const { java, cobolRun, javaRun } = one(
      "01 WS-T PIC 9(3) OCCURS 3.\n01 WS-S PIC 9(4).",
      "0000-MAIN.\n    MOVE 7 TO WS-T(2)\n    INITIALIZE WS-T\n    COMPUTE WS-S = WS-T(1) + WS-T(2) + WS-T(3)\n    GOBACK.",
      ["WS-S"],
    );
    expect(java).toContain("java.util.Arrays.fill(t, BigDecimal.ZERO);");
    expect(javaRun.status).toBe("ok");
    expect(javaRun.fields).toEqual(cobolRun.fields);
  });

  it("does not name a method after a final method of java.lang.Object", () => {
    const { java } = one("01 WS-A PIC 9.", "0000-MAIN.\n    PERFORM WAIT.\n    GOBACK.\nWAIT.\n    MOVE 1 TO WS-A.");
    expect(java).not.toMatch(/void wait\(\)/);
    expect(java).toMatch(/private void wait2\(\) \{/);
  });

  it("keeps comments from closing a Javadoc block or holding a unicode escape", () => {
    const { java } = one("*    RATE */ 100, SEE C:\\USERS\\ME\n01 WS-A PIC 9V99.", "0000-MAIN.\n    MOVE 1 TO WS-A\n    GOBACK.");
    const doc = java.split("\n").find((l) => l.includes("/** Rate"))!;
    expect(doc).toContain("* / 100");
    expect(doc).not.toMatch(/(^|[^\\])\\u/);
  });

  it("derives a valid class name from any PROGRAM-ID", () => {
    expect(programClassName("CALC-INT")).toBe("CalcInt");
    expect(programClassName("PAY#01")).toBe("Pay01");
    expect(programClassName("2NDPASS")).toBe("Program2ndpass");
    expect(programClassName("PIC")).toBe("PicProgram");
    expect(programClassName("X", "2024 RATE ×UPDATE")).toBe("X");
  });
});

describe("CALL parameters: the Java model follows the generated Java", () => {
  const files = (calleeProc: string, using: string) => [
    { name: "REC.cpy", source: "       01  REC-AREA.\n           05  REC-AMOUNT   PIC 9(5).\n" },
    {
      name: "CALLER.cbl",
      source: source("CALLER", "COPY REC.\n01 WS-AFTER PIC 9(5).", `0000-MAIN.\n    MOVE 10 TO REC-AMOUNT\n    CALL 'CALLEE' USING ${using}\n    MOVE 99 TO WS-AFTER\n    GOBACK.`),
    },
    { name: "CALLEE.cbl", source: source("CALLEE", "", calleeProc, "COPY REC.", "REC-AREA") },
  ];
  const runBoth = (calleeProc: string, using: string) => {
    const sys = analyzeSystem(files(calleeProc, using));
    const irs = new Map<string, JProgram>();
    for (const ast of sys.asts.values()) irs.set(ast.id, transpile(ast, { system: sys.asts, conventions: DEFAULT_CONVENTIONS }));
    const outputs = ["REC-AMOUNT", "WS-AFTER"];
    const java = renderJava(irs.get("CALLER")!, sys.asts.get("CALLER")!, irs).files[0].content;
    return { java, cobol: runCobol(sys.asts, "CALLER", tc(), outputs), model: runJava(irs, "CALLER", tc(), outputs) };
  };

  it("passes a copy of a shared record BY CONTENT", () => {
    const { java, cobol, model } = runBoth("0000-MAIN.\n    MOVE 5 TO REC-AMOUNT\n    GOBACK.", "BY CONTENT REC-AREA");
    expect(java).toContain("RecordArea recordAreaArg = new RecordArea();");
    expect(java).toContain("callee.run(recordAreaArg);");
    expect(java).not.toContain("recordArea.amount = recordAreaArg.amount;");
    expect(cobol.fields["REC-AMOUNT"]).toBe("10");
    expect(model.fields).toEqual(cobol.fields);
  });

  it("returns to the caller after a STOP RUN in a called program, as the Java does", () => {
    const { cobol, model } = runBoth("0000-MAIN.\n    STOP RUN.", "REC-AREA");
    // COBOL ends the run unit; the generated run() returns. The harness reports the difference.
    expect(cobol.fields["WS-AFTER"]).toBe("0");
    expect(model.fields["WS-AFTER"]).toBe("99");
  });
});

describe("CLI usage errors", () => {
  const cli = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", path.join(ROOT, "cli/mue.ts"), ...args], { cwd: ROOT, encoding: "utf8" });

  it("rejects an unknown command or report format with exit code 2", () => {
    const unknown = cli("verfy");
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('Unknown command "verfy"');
    expect(cli("verify", "examples/banking", "--format", "pdf").status).toBe(2);
  });
});
