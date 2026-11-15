// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Abstract syntax tree (AST) produced by the Mue COBOL parser.
 * Deliberately bounded subset: see README, section "Supported COBOL subset".
 */

export interface Pic {
  raw: string;
  kind: "numeric" | "alnum" | "edited";
  signed: boolean;
  intDigits: number;
  scale: number;
  /** Length in characters (display). */
  length: number;
}

export type Usage = "DISPLAY" | "COMP" | "COMP-3" | "COMP-5" | "BINARY" | "PACKED-DECIMAL" | "COMP-1" | "COMP-2";

export type Literal =
  | { kind: "num"; value: string }
  | { kind: "str"; value: string }
  | { kind: "fig"; value: Figurative };

export type Figurative = "ZERO" | "SPACE" | "HIGH-VALUE" | "LOW-VALUE" | "QUOTE";

export interface ConditionName {
  name: string;
  values: Literal[];
  ranges: [Literal, Literal][];
  line: number;
}

export type Section = "WORKING-STORAGE" | "LINKAGE" | "LOCAL-STORAGE" | "FILE";

export interface DataItem {
  level: number;
  name: string;
  pic?: Pic;
  usage: Usage;
  value?: Literal;
  occurs?: number;
  redefines?: string;
  children: DataItem[];
  conditions: ConditionName[];
  section: Section;
  line: number;
  /** Source copybook when the item comes from a COPY. */
  copybook?: string;
  parent?: string;
  /** Comments placed right above the declaration. */
  comment?: string;
}

export type Expr =
  | { k: "num"; v: string }
  | { k: "str"; v: string }
  | { k: "fig"; v: Figurative }
  | { k: "ref"; name: string; sub?: Expr }
  | { k: "bin"; op: "+" | "-" | "*" | "/" | "**"; l: Expr; r: Expr }
  | { k: "neg"; e: Expr }
  | { k: "func"; name: string; args: Expr[] };

export type RelOp = "=" | "<>" | ">" | "<" | ">=" | "<=";

export type Cond =
  | { k: "rel"; op: RelOp; l: Expr; r: Expr }
  | { k: "and"; a: Cond; b: Cond }
  | { k: "or"; a: Cond; b: Cond }
  | { k: "not"; c: Cond }
  | { k: "cname"; name: string }
  | { k: "class"; e: Expr; cls: "NUMERIC" | "ALPHABETIC"; neg: boolean }
  | { k: "sign"; e: Expr; sign: "POSITIVE" | "NEGATIVE" | "ZERO"; neg: boolean };

export interface Target {
  ref: Expr & { k: "ref" };
  rounded: boolean;
}

interface StmtBase {
  id: number;
  line: number;
  endLine: number;
  /** Source file (copybook) when different from the program. */
  file?: string;
  /** Comments right above. */
  comment?: string;
}

export type WhenObject =
  | { kind: "value"; v: Expr; thru?: Expr; not: boolean }
  | { kind: "cond"; c: Cond }
  | { kind: "any" };

export type Stmt = StmtBase &
  (
    | { kind: "move"; src: Expr; to: (Expr & { k: "ref" })[] }
    | {
        kind: "compute";
        verb: "COMPUTE" | "ADD" | "SUBTRACT" | "MULTIPLY" | "DIVIDE";
        targets: Target[];
        /** One expression per target (ADD A TO B C gives B+A and C+A). */
        exprs: Expr[];
        remainder?: { ref: Expr & { k: "ref" }; dividend: Expr; divisor: Expr };
        onSize?: Stmt[];
        notOnSize?: Stmt[];
      }
    | { kind: "if"; cond: Cond; then: Stmt[]; else?: Stmt[] }
    | { kind: "evaluate"; subject: Expr | "TRUE" | "FALSE"; whens: { objs: WhenObject[]; body: Stmt[] }[]; other?: Stmt[] }
    | {
        kind: "perform";
        target?: { from: string; thru?: string };
        body?: Stmt[];
        times?: Expr;
        until?: Cond;
        varying?: { ref: Expr & { k: "ref" }; from: Expr; by: Expr };
        testAfter: boolean;
      }
    | { kind: "call"; program: string | null; dynamic?: string; using: { ref: Expr; mode: "REFERENCE" | "CONTENT" | "VALUE" }[]; onException?: Stmt[] }
    | { kind: "goto"; targets: string[]; depending?: Expr }
    | { kind: "stop"; how: "STOP RUN" | "GOBACK" | "EXIT PROGRAM" }
    | { kind: "noop"; how: "EXIT" | "CONTINUE" }
    | { kind: "display"; items: Expr[] }
    | { kind: "accept"; ref: Expr & { k: "ref" }; from?: string }
    | { kind: "initialize"; refs: (Expr & { k: "ref" })[] }
    | { kind: "set"; mode: "true"; names: string[] }
    | { kind: "set"; mode: "value"; refs: (Expr & { k: "ref" })[]; value: Expr }
    | { kind: "sql"; sql: SqlInfo }
    | { kind: "unsupported"; verb: string; text: string; reason: string }
  );

export interface SqlInfo {
  op: string;
  text: string;
  tables: { name: string; mode: "R" | "W" }[];
  into: string[];
  hostVars: string[];
  cursor?: string;
}

export interface Paragraph {
  name: string;
  section?: string;
  line: number;
  endLine: number;
  stmts: Stmt[];
  isSection?: boolean;
  comment?: string;
}

export interface Diagnostic {
  line: number;
  severity: "info" | "warn" | "error";
  message: string;
  file?: string;
}

export interface ManualItem {
  line: number;
  construct: string;
  detail: string;
  file?: string;
}

export interface CobolProgram {
  id: string;
  file: string;
  title?: string;
  author?: string;
  dateWritten?: string;
  headerComments: string[];
  decimalComma: boolean;
  items: DataItem[];
  /** All items (groups and elementary), flattened, indexed by name. */
  fields: Map<string, DataItem>;
  procedureUsing: string[];
  paragraphs: Paragraph[];
  copies: { name: string; line: number; resolved: boolean }[];
  files: { name: string; line: number }[];
  diagnostics: Diagnostic[];
  manual: ManualItem[];
  lines: { total: number; code: number; comment: number; blank: number };
  source: string;
  stmtCount: number;
  /** EXEC SQL placed in the DATA DIVISION (DECLARE CURSOR, INCLUDE). */
  sqlDeclarations: SqlInfo[];
}

export interface JclJob {
  name: string;
  file: string;
  steps: { name: string; program: string; line: number }[];
  datasets: string[];
  comment?: string;
}
