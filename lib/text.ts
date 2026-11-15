// SPDX-License-Identifier: AGPL-3.0-only
/** Text helpers: turning upper-case COBOL comments into readable sentences, number formatting. */

/** Tokens kept in upper case (acronyms, codes). */
const KEEP_UPPER = new Set(["SEPA", "IBAN", "BBAN", "DB2", "SQL", "OK", "JCL", "CICS", "VSAM", "COBOL", "PIC", "ID", "EUR", "USD", "AM", "PM"]);

/** "NO INTEREST ON A BLOCKED ACCOUNT" → "No interest on a blocked account" */
export function sentence(text: string): string {
  const parts = text.trim().split(/(\s+|[.,:;()'/=-])/);
  const next = (i: number) => parts.slice(i + 1).find((x) => x.trim());
  const out = parts
    .map((w, i) => {
      const up = w.toUpperCase();
      if (/^[A-Z]$/.test(w) && next(i) === "=") return w; // code letters: "A = ACTIVE"
      if (/\d/.test(up) && /[A-Z]/.test(up) && /^[A-Z0-9]+$/.test(up)) return up; // codes: RJ01, PAIN001
      if (KEEP_UPPER.has(up)) return up;
      return w.toLowerCase();
    })
    .join("")
    .replace(/\s+([:;,.])/g, "$1");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

export function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

export function plural(n: number, one: string, many: string): string {
  return `${fmtInt(n)} ${n === 1 ? one : many}`;
}
