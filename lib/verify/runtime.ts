// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared pieces of the two execution engines (COBOL and the Java model):
 * test cases, SQL stub, canonical value format, results.
 *
 * The SQL stub and the display format are deliberately shared: they model the
 * environment (database, console), not the code under comparison.
 */
import Decimal from "decimal.js";
import type { Pic, SqlInfo } from "../cobol/types";

/** Exact arithmetic (64 significant digits, far beyond any PIC). */
export const DX = Decimal.clone({ precision: 64, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof DX>;

export type CaseCategory = "random" | "zero" | "negative" | "max" | "boundary" | "half-cent" | "sql-not-found" | "recorded";

export const CATEGORY_LABEL: Record<CaseCategory, string> = {
  random: "Realistic random operations",
  zero: "Zero values",
  negative: "Negative amounts",
  max: "Maximum field values",
  boundary: "Condition boundaries",
  "half-cent": "Half-cent ties (rounding cases)",
  "sql-not-found": "Row not found (SQLCODE 100)",
  recorded: "Recorded inputs (supplied by you)",
};

export interface TestCase {
  id: number;
  category: CaseCategory;
  inputs: Record<string, string>;
  sqlSelect: Record<string, string>;
  sqlNotFound: boolean;
  cursors: Record<string, Record<string, string>[]>;
}

export interface StoreEvent {
  program: string;
  stmtId: number;
  field: string;
  value: string;
  raw?: string;
  rounded?: boolean;
  sizeError?: boolean;
}

export interface RunResult {
  status: "ok" | "abend" | "loop" | "unsupported";
  message?: string;
  fields: Record<string, string>;
  displays: string[];
  sql: string[];
  calls: string[];
  stores: StoreEvent[];
  overflows: { program: string; stmtId: number; field: string; raw: string }[];
}

export class LoopLimit extends Error {}
export class Abend extends Error {}
export class NotSupported extends Error {}

export function isNumericPic(p: Pic | undefined): boolean {
  return !!p && p.kind === "numeric";
}

/** Numeric value in canonical format (scale of the field). */
export function fmtNum(v: Dec, scale: number): string {
  const s = v.toFixed(scale);
  return s === "-0" || /^-0\.0*$/.test(s) ? s.slice(1) : s;
}

export function rtrim(s: string): string {
  return s.replace(/\s+$/, "");
}

/** DISPLAY rendering of a value (identical on both sides: it is the console). */
export function displayValue(v: Dec | string, pic: Pic | undefined): string {
  if (typeof v === "string") return v;
  return fmtNum(v, pic?.scale ?? 0);
}

/** SQL stub: environment contract shared by both executions. */
export class SqlStub {
  private cursorPos = new Map<string, number>();
  trace: string[] = [];
  constructor(private tc: TestCase) {}

  /**
   * Executes an SQL statement. `read` reads a host variable (canonical format),
   * `write` assigns a host variable. Returns the SQLCODE.
   */
  exec(sql: SqlInfo, read: (v: string) => string, write: (v: string, value: string) => void): number {
    switch (sql.op) {
      case "INCLUDE":
      case "DECLARE":
        return 0;
      case "SELECT": {
        if (this.tc.sqlNotFound) return 100;
        for (const v of sql.into) write(v, this.tc.sqlSelect[v] ?? "0");
        return 0;
      }
      case "OPEN":
        if (sql.cursor) this.cursorPos.set(sql.cursor, 0);
        return 0;
      case "CLOSE":
        return 0;
      case "FETCH": {
        const c = sql.cursor ?? "";
        const rows = this.tc.cursors[c] ?? [];
        const pos = this.cursorPos.get(c) ?? 0;
        if (pos >= rows.length) return 100;
        const row = rows[pos];
        for (const v of sql.into) write(v, row[v] ?? "0");
        this.cursorPos.set(c, pos + 1);
        return 0;
      }
      case "INSERT":
      case "UPDATE":
      case "DELETE": {
        const into = new Set(sql.into);
        const vals = sql.hostVars.filter((h) => !into.has(h)).map((h) => `${h}=${read(h)}`);
        this.trace.push(`${sql.op} ${sql.tables.map((t) => t.name).join(",")} ${vals.join(" ")}`);
        return 0;
      }
      default:
        return 0;
    }
  }
}

/** Fits a value into a numeric PIC: scale, sign, high-order digits. */
export function fitPic(v: Dec, pic: Pic, mode: Decimal.Rounding): { value: Dec; sizeError: boolean } {
  let x = v.toDecimalPlaces(pic.scale, mode) as Dec;
  if (!pic.signed) x = x.abs() as Dec;
  const lim = new DX(10).pow(pic.intDigits);
  let sizeError = false;
  if (x.abs().gte(lim)) {
    sizeError = true;
    const sign = x.isNeg() ? -1 : 1;
    x = x.abs().mod(lim).times(sign) as Dec;
  }
  return { value: x, sizeError };
}

/** COBOL rule for a numeric → alphanumeric MOVE: digits without sign or decimal point. */
export function numToAlnum(v: Dec, pic: Pic | undefined, len: number): string {
  const scale = pic?.scale ?? 0;
  const digits = v.abs().toFixed(scale).replace(".", "");
  const width = pic && pic.kind === "numeric" ? pic.intDigits + pic.scale : digits.length;
  return digits.padStart(width, "0").slice(-width).padEnd(len, " ").slice(0, len);
}

export function alnumToNum(s: string): Dec {
  const t = s.trim();
  if (/^[+-]?\d+(\.\d+)?$/.test(t)) return new DX(t);
  return new DX(0);
}

/** Java rounding mode → decimal.js mode */
export const ROUNDING: Record<string, Decimal.Rounding> = {
  HALF_UP: Decimal.ROUND_HALF_UP,
  HALF_EVEN: Decimal.ROUND_HALF_EVEN,
  HALF_DOWN: Decimal.ROUND_HALF_DOWN,
  DOWN: Decimal.ROUND_DOWN,
  UP: Decimal.ROUND_UP,
  FLOOR: Decimal.ROUND_FLOOR,
  CEILING: Decimal.ROUND_CEIL,
};
