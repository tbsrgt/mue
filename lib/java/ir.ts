// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Intermediate representation (IR) of the generated Java.
 * Single source of truth: the Java text is rendered from this IR, and the Java execution
 * model (BigDecimal semantics) runs this very same IR.
 */
import type { Pic, RelOp, SqlInfo } from "../cobol/types";

export type Mode = "HALF_UP" | "HALF_EVEN" | "DOWN";

export interface Conventions {
  /** Rounding mode used for ROUNDED. */
  rounding: "HALF_UP" | "HALF_EVEN";
  /** Size overflow without ON SIZE ERROR. */
  overflow: "reproduce" | "ignore";
  /** Target Java package. */
  package: string;
}

export type Overrides = Partial<Pick<Conventions, "rounding" | "overflow">>;

/** Defaults are COBOL-exact. HALF_EVEN is a common Java team convention, opt in explicitly. */
export const DEFAULT_CONVENTIONS: Conventions = { rounding: "HALF_UP", overflow: "reproduce", package: "com.example.bank" };

export interface JField {
  cobol: string;
  name: string;
  /** Java access path (e.g. account.balance). */
  path: string;
  owner?: string;
  pic?: Pic;
  isNum: boolean;
  length: number;
  occurs?: number;
  constant?: boolean;
  section: string;
  comment?: string;
  init: string;
}

export interface JGroup {
  cobol: string;
  cls: string;
  /** Class name usable from another program (Account, SavingsInterestCalculation.CalcArea). */
  qualified: string;
  varName: string;
  copybook?: string;
  fields: JField[];
  conditions: { name: string; method: string; field: string; values: { v: string; num: boolean }[] }[];
  isParam: boolean;
  section: string;
  comment?: string;
}

export type JExpr =
  | { k: "num"; v: string }
  | { k: "str"; v: string }
  | { k: "field"; f: string; sub?: JExpr }
  | { k: "op"; op: "add" | "sub" | "mul" | "div" | "pow"; a: JExpr; b: JExpr }
  | { k: "neg"; e: JExpr }
  | { k: "func"; name: string; args: JExpr[] }
  | { k: "digits"; e: JExpr; pic?: Pic }
  | { k: "parse"; e: JExpr }
  | { k: "fill"; ch: string; len: number };

export type JCond =
  | { k: "cmpNum"; op: RelOp; a: JExpr; b: JExpr }
  | { k: "cmpStr"; op: RelOp; a: JExpr; b: JExpr }
  | { k: "and"; a: JCond; b: JCond }
  | { k: "or"; a: JCond; b: JCond }
  | { k: "not"; c: JCond }
  | { k: "cond88"; cobol: string; call: string; field: string; values: { v: string; num: boolean }[]; ranges: { lo: string; hi: string; num: boolean }[] }
  | { k: "isNumeric"; e: JExpr; neg: boolean };

export interface Origin {
  id: number;
  line: number;
  endLine: number;
  file?: string;
  comment?: string;
  program: string;
}

export interface NumTarget {
  f: string;
  sub?: JExpr;
  e: JExpr;
  /** null: direct assignment, the value always fits in the field. */
  fit: null | { mode: Mode; overflow: "reproduce" | "ignore" };
  rounded: boolean;
  decision?: string;
  /** Evaluated after the other targets are stored (DIVIDE ... REMAINDER uses the stored quotient). */
  afterStore?: boolean;
}

export type JStmt = { o: Origin } & (
  | { k: "setNum"; targets: NumTarget[]; sizeError?: { on?: JStmt[]; not?: JStmt[] }; note?: string }
  | { k: "setStr"; f: string; sub?: JExpr; e: JExpr; note?: string }
  | { k: "if"; c: JCond; then: JStmt[]; else?: JStmt[] }
  | { k: "switchStr"; subject: JExpr; cases: { values: string[]; body: JStmt[] }[]; other?: JStmt[] }
  | { k: "chain"; cases: { c: JCond; body: JStmt[] }[]; other?: JStmt[] }
  | { k: "perform"; methods: string[]; paragraphs: string[] }
  | { k: "block"; body: JStmt[] }
  | { k: "while"; c: JCond; body: JStmt[]; doWhile: boolean }
  | { k: "repeat"; n: JExpr; body: JStmt[] }
  | { k: "varying"; init: JStmt; c: JCond; body: JStmt[]; step: JStmt }
  | { k: "call"; program: string; external: boolean; args: { cobol: string; param?: string; mode: "REFERENCE" | "CONTENT" | "VALUE"; literal?: JExpr }[] }
  | { k: "exit"; how: "GOBACK" | "STOP RUN" | "EXIT PROGRAM" }
  | { k: "print"; parts: JExpr[] }
  | { k: "sql"; sql: SqlInfo }
  | { k: "todo"; construct: string; text: string; blocking: boolean }
  | { k: "noop"; text: string }
);

export interface JParagraph {
  cobol: string;
  method: string;
  body: JStmt[];
  dead: boolean;
  line: number;
  comment?: string;
}

export interface Decision {
  id: string;
  kind: "rounding" | "overflow";
  stmtId: number;
  line: number;
  cobol: string;
  choice: string;
  cobolSemantics: string;
  matchesCobol: boolean;
  source: "convention" | "correction";
}

export interface JProgram {
  id: string;
  className: string;
  groups: JGroup[];
  /** Elementary fields indexed by COBOL name. */
  fields: Map<string, JField>;
  paragraphs: JParagraph[];
  /** Methods called in sequence by run(). */
  entry: string[];
  params: string[];
  decisions: Decision[];
  todos: { line: number; construct: string; text: string; blocking: boolean; file?: string }[];
  conventions: Conventions;
}
