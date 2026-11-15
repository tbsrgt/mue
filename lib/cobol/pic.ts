// SPDX-License-Identifier: AGPL-3.0-only
import type { Pic } from "./types";

/** Expands repetitions: 9(3)V9(2) → 999V99 */
export function expandPic(raw: string): string {
  return raw.toUpperCase().replace(/(.)\((\d+)\)/g, (_, ch: string, n: string) => ch.repeat(Number(n)));
}

export function parsePic(raw: string): Pic {
  const x = expandPic(raw);
  if (/^S?[9V]*P*$/.test(x) || /^S?P*[9V]*$/.test(x)) {
    const signed = x.startsWith("S");
    const body = x.replace(/^S/, "").replace(/P/g, "");
    const [intPart, fracPart = ""] = body.split("V");
    const intDigits = intPart.length;
    const scale = fracPart.length;
    return { raw, kind: "numeric", signed, intDigits, scale, length: intDigits + scale };
  }
  if (/^[XA9]+$/.test(x)) {
    return { raw, kind: "alnum", signed: false, intDigits: 0, scale: 0, length: x.length };
  }
  // Edited picture (Z, *, ., ,, +, -, CR, DB, B, 0, /, $)
  const digits = x.replace(/[^9Z*]/g, "");
  const dot = x.indexOf(".");
  const scale = dot >= 0 ? x.slice(dot + 1).replace(/[^9Z*]/g, "").length : 0;
  return {
    raw,
    kind: "edited",
    signed: /[-+]|CR|DB/.test(x),
    intDigits: digits.length - scale,
    scale,
    length: x.replace(/CR|DB/g, "XX").length,
  };
}

export function picLabel(p: Pic | undefined): string {
  if (!p) return "group";
  if (p.kind === "alnum") return `text (${p.length})`;
  if (p.kind === "edited") return `edited (${p.raw})`;
  const s = p.signed ? "signed" : "unsigned";
  return p.scale > 0 ? `decimal ${p.intDigits}+${p.scale} digits, ${s}` : `integer ${p.intDigits} digits, ${s}`;
}
