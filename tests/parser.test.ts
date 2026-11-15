import { describe, expect, it } from "vitest";
import { parseProgram } from "../lib/cobol/parser";
import { parsePic } from "../lib/cobol/pic";
import { loadSystem } from "./helpers";

describe("PIC", () => {
  it("decodes numeric, alphanumeric and edited pictures", () => {
    expect(parsePic("S9(11)V99")).toMatchObject({ kind: "numeric", signed: true, intDigits: 11, scale: 2 });
    expect(parsePic("9(3)V9(4)")).toMatchObject({ kind: "numeric", signed: false, intDigits: 3, scale: 4 });
    expect(parsePic("X(11)")).toMatchObject({ kind: "alnum", length: 11 });
    expect(parsePic("Z(5)9.99-")).toMatchObject({ kind: "edited", signed: true, scale: 2 });
  });
});

describe("COBOL parser", () => {
  const sys = loadSystem();
  const calcint = sys.asts.get("CALCINT")!;

  it("reads divisions, PROGRAM-ID, LINKAGE and copybooks", () => {
    expect(calcint.id).toBe("CALCINT");
    expect(calcint.title).toMatch(/SAVINGS INTEREST CALCULATION/);
    expect(calcint.procedureUsing).toEqual(["ACCT-REC", "LK-CALC-AREA"]);
    expect(calcint.fields.get("ACCT-BALANCE")?.pic).toMatchObject({ intDigits: 11, scale: 2, signed: true });
    expect(calcint.fields.get("ACCT-BALANCE")?.usage).toBe("COMP-3");
    expect(calcint.fields.get("ACCT-BALANCE")?.copybook).toBe("ACCTREC");
    expect(calcint.copies[0]).toMatchObject({ name: "ACCTREC", resolved: true });
    expect(calcint.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  it("recognizes COMPUTE ROUNDED, IF/ELSE and level-88 conditions", () => {
    const para = calcint.paragraphs.find((p) => p.name === "2000-COMPUTE-INTEREST")!;
    const iff = para.stmts[0];
    expect(iff.kind).toBe("if");
    if (iff.kind !== "if") return;
    expect(iff.cond.k).toBe("or");
    const comp = iff.else![0];
    expect(comp.kind === "compute" && comp.targets[0].rounded).toBe(true);
    expect(calcint.fields.get("ACCT-BLOCKED")?.level).toBe(88);
  });

  it("handles DECIMAL-POINT IS COMMA, EXEC SQL and dead code", () => {
    const fee = sys.asts.get("LATEFEE")!;
    expect(fee.decimalComma).toBe(true);
    expect(fee.fields.get("WS-PENALTY-RATE")?.value).toEqual({ kind: "num", value: "0.07" });
    const pa = sys.programs.find((p) => p.id === "LATEFEE")!;
    expect(pa.tables).toEqual(expect.arrayContaining([{ name: "CONTRACTS", read: true, write: false }, { name: "INSTALLMENTS", read: false, write: true }]));
    expect(sys.programs.find((p) => p.id === "CALCINT")!.deadParagraphs).toEqual(["9000-OLD-CALC-360"]);
  });

  it("builds the call graph and flags GO TO and file I/O", () => {
    expect(sys.programs.find((p) => p.id === "CALCINT")!.calledBy).toEqual(["NIGHTINT"]);
    expect(sys.missingPrograms.map((m) => m.name).sort()).toEqual(["COLLECTR", "FMTPAIN"]);
    expect(sys.graph.edges.some((e) => e.kind === "exec" && e.target === "pgm:NIGHTINT")).toBe(true);
    expect(sys.programs.find((p) => p.id === "SEPAXFER")!.gotos).toHaveLength(1);
    expect(sys.programs.find((p) => p.id === "STMTPRT")!.manual.map((m) => m.construct)).toEqual(expect.arrayContaining(["READ", "WRITE", "STRING"]));
  });

  it("parses a FETCH INTO list split over two lines", () => {
    const fetch = sys.asts.get("NIGHTINT")!.paragraphs.find((p) => p.name === "2100-READ-NEXT")!.stmts[0];
    expect(fetch.kind === "sql" && fetch.sql.into).toEqual(["ACCT-NUMBER", "ACCT-STATUS", "ACCT-BALANCE", "ACCT-RATE"]);
  });

  it("flags EXEC CICS as unsupported instead of guessing", () => {
    const src = ["       IDENTIFICATION DIVISION.", "       PROGRAM-ID. ONLINE.", "       PROCEDURE DIVISION.", "           EXEC CICS RECEIVE MAP('M1') MAPSET('S1') END-EXEC", "           EXEC CICS RETURN END-EXEC", "           GOBACK.", ""].join("\n");
    const p = parseProgram(src, { file: "ONLINE.cbl" });
    expect(p.diagnostics).toHaveLength(0);
    expect(p.manual.map((m) => m.construct)).toEqual(["EXEC CICS", "EXEC CICS"]);
    expect(p.paragraphs[0].stmts[0]).toMatchObject({ kind: "unsupported", verb: "EXEC CICS" });
  });

  it("understands abbreviated conditions and EVALUATE", () => {
    const src = `       IDENTIFICATION DIVISION.
       PROGRAM-ID. ABBREV.
       DATA DIVISION.
       WORKING-STORAGE SECTION.
       77  A   PIC 9(2).
       77  P   PIC X(2).
       77  R   PIC X.
       PROCEDURE DIVISION.
           IF A < 2 OR > 98
              MOVE 'K' TO R
           END-IF
           EVALUATE P
              WHEN 'FR'
              WHEN 'MC'
                 MOVE 'F' TO R
              WHEN OTHER
                 MOVE 'X' TO R
           END-EVALUATE
           GOBACK.
`;
    const p = parseProgram(src, { file: "ABBREV.cbl" });
    const s = p.paragraphs[0].stmts;
    expect(s[0].kind === "if" && s[0].cond.k === "or" && s[0].cond.b.k === "rel" && s[0].cond.b.op === ">").toBe(true);
    expect(s[1].kind === "evaluate" && s[1].whens[0].objs.length).toBe(2);
    expect(p.diagnostics).toHaveLength(0);
  });
});
