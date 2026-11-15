// SPDX-License-Identifier: AGPL-3.0-only
/**
 * COBOL lexer: fixed format (indicator in column 7, code in 8-72) or free format, comments,
 * continuation lines, strings, PIC strings, EXEC SQL … END-EXEC and COPY expansion.
 */

export type TokType = "word" | "num" | "str" | "op" | "period" | "sql" | "pic" | "eof";

export interface Token {
  t: TokType;
  /** Normalized value (upper-case words, numbers with a decimal point). */
  v: string;
  /** Original text. */
  raw: string;
  line: number;
  file?: string;
  /** Comments placed right above this token. */
  comment?: string;
  /** For "sql" tokens: the EXEC kind (SQL, CICS, DLI). Only SQL is supported. */
  exec?: string;
}

export interface LexOptions {
  file: string;
  decimalComma?: boolean;
  resolveCopy?: (name: string) => string | null;
  /** Stack of COPY statements being expanded (guards against cycles). */
  copyStack?: string[];
}

export interface LexResult {
  tokens: Token[];
  copies: { name: string; line: number; resolved: boolean; file?: string }[];
  comments: { line: number; text: string }[];
  stats: { total: number; code: number; comment: number; blank: number };
  diagnostics: { line: number; message: string; file?: string }[];
}

interface LogicalLine {
  text: string;
  line: number;
  comment?: string;
}

export function isFreeFormat(source: string): boolean {
  if (/>>\s*SOURCE\s+FORMAT\s+(IS\s+)?FREE/i.test(source)) return true;
  const lines = source.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  let marginUsed = 0;
  for (const l of lines) {
    const margin = l.slice(0, 6);
    if (/[A-Za-z.]/.test(margin) && !/^\s*\d+\s*$/.test(margin)) marginUsed++;
  }
  return marginUsed / lines.length > 0.4;
}

/** Splits the source into logical lines (code area), separating comments. */
export function splitLines(source: string) {
  const raw = source.replace(/\t/g, "    ").split(/\r?\n/);
  const free = isFreeFormat(source);
  const out: LogicalLine[] = [];
  const comments: { line: number; text: string }[] = [];
  const stats = { total: raw.length, code: 0, comment: 0, blank: 0 };
  let pending: string[] = [];
  // Trailing empty line (end of file): not counted.
  if (raw.length > 0 && raw[raw.length - 1].trim() === "") stats.total--;

  raw.forEach((l, idx) => {
    const lineNo = idx + 1;
    if (lineNo > stats.total) return;
    if (l.trim() === "") {
      stats.blank++;
      return;
    }
    if (free) {
      const t = l.trimStart();
      if (t.startsWith("*>") || (l.startsWith("*") && !l.startsWith("*>")) || t.startsWith(">>")) {
        if (!t.startsWith(">>")) {
          stats.comment++;
          const c = t.replace(/^\*>?\s?/, "").trim();
          comments.push({ line: lineNo, text: c });
          if (c) pending.push(c);
        } else stats.code++;
        return;
      }
      const cut = l.indexOf("*>");
      const text = cut >= 0 ? l.slice(0, cut) : l;
      stats.code++;
      out.push({ text, line: lineNo, comment: pending.length ? pending.join(" ") : undefined });
      pending = [];
      return;
    }
    const indicator = l.length > 6 ? l[6] : " ";
    if (indicator === "*" || indicator === "/") {
      stats.comment++;
      const c = l.slice(7, 72).trim();
      comments.push({ line: lineNo, text: c });
      if (c && !/^[-*=\s]+$/.test(c) && !/EXEMPLE MUE|MUE EXAMPLE/i.test(c)) pending.push(c);
      return;
    }
    let area = l.slice(7);
    if (l.length > 72) {
      const tail = l.slice(72);
      if (tail.length <= 8 && !/['".]/.test(tail)) area = l.slice(7, 72);
    }
    if (area.trim() === "") {
      stats.blank++;
      return;
    }
    stats.code++;
    if (indicator === "-" && out.length > 0) {
      // Continuation: glue to the previous text.
      const prev = out[out.length - 1];
      let cont = area.trimStart();
      if (cont.startsWith("'") || cont.startsWith('"')) cont = cont.slice(1);
      else prev.text = prev.text.trimEnd() + " ";
      prev.text = prev.text.replace(/\s+$/, (m) => (/(['"])[^'"]*$/.test(prev.text) ? "" : m)) + cont;
      return;
    }
    if (indicator === "D" || indicator === "d") {
      // Debugging line: ignored like a comment.
      stats.comment++;
      return;
    }
    out.push({ text: area, line: lineNo, comment: pending.length ? pending.join(" ") : undefined });
    pending = [];
  });
  return { lines: out, comments, stats };
}

const WORD_START = /[A-Za-z0-9]/;

export function lex(source: string, opts: LexOptions): LexResult {
  const { lines, comments, stats } = splitLines(source);
  const tokens: Token[] = [];
  const copies: LexResult["copies"] = [];
  const diagnostics: LexResult["diagnostics"] = [];
  const decimalComma = opts.decimalComma ?? /DECIMAL-POINT\s+IS\s+COMMA/i.test(source);
  const file = opts.file;

  let sqlBuf: { text: string; line: number; comment?: string; exec: string } | null = null;

  const push = (tk: Omit<Token, "file">) => tokens.push({ ...tk, file });

  for (const ll of lines) {
    const s = ll.text;
    let i = 0;
    let lineComment = ll.comment;
    const take = () => {
      const c = lineComment;
      lineComment = undefined;
      return c;
    };

    while (i < s.length) {
      // Inside an EXEC SQL block: accumulate until END-EXEC.
      if (sqlBuf) {
        const rest = s.slice(i);
        const m = /END-EXEC/i.exec(rest);
        if (m) {
          sqlBuf.text += " " + rest.slice(0, m.index);
          push({ t: "sql", v: sqlBuf.text.replace(/\s+/g, " ").trim(), raw: sqlBuf.text, line: sqlBuf.line, comment: sqlBuf.comment, exec: sqlBuf.exec });
          sqlBuf = null;
          i += m.index + 8;
          continue;
        }
        sqlBuf.text += " " + rest;
        i = s.length;
        continue;
      }

      const c = s[i];
      if (c === " " || c === "\t") {
        i++;
        continue;
      }
      // Ignored separators
      if (c === ";" || (c === "," && !(decimalComma && /\d/.test(s[i + 1] ?? "") && /[\s(=]/.test(s[i - 1] ?? " ")))) {
        i++;
        continue;
      }
      // Strings
      if (c === "'" || c === '"') {
        let j = i + 1;
        let val = "";
        while (j < s.length) {
          if (s[j] === c) {
            if (s[j + 1] === c) {
              val += c;
              j += 2;
              continue;
            }
            break;
          }
          val += s[j++];
        }
        push({ t: "str", v: val, raw: s.slice(i, j + 1), line: ll.line, comment: take() });
        i = j + 1;
        continue;
      }
      // Sentence-ending period (followed by a blank or end of line)
      if (c === "." && !/\d/.test(s[i + 1] ?? "")) {
        push({ t: "period", v: ".", raw: ".", line: ll.line });
        i++;
        continue;
      }
      // Number starting with a decimal separator (.5 or ,5)
      if ((c === "." || (c === "," && decimalComma)) && /\d/.test(s[i + 1] ?? "")) {
        let j = i + 1;
        while (j < s.length && /\d/.test(s[j])) j++;
        push({ t: "num", v: "0." + s.slice(i + 1, j), raw: s.slice(i, j), line: ll.line, comment: take() });
        i = j;
        continue;
      }
      // Operators
      const two = s.slice(i, i + 2);
      if (two === "**" || two === ">=" || two === "<=" || two === "<>") {
        push({ t: "op", v: two, raw: two, line: ll.line, comment: take() });
        i += 2;
        continue;
      }
      if ("+-*/=<>():".includes(c)) {
        push({ t: "op", v: c, raw: c, line: ll.line, comment: take() });
        i++;
        continue;
      }
      if (WORD_START.test(c)) {
        let j = i;
        while (j < s.length && /[A-Za-z0-9-]/.test(s[j])) j++;
        // no trailing hyphen
        while (j > i + 1 && s[j - 1] === "-") j--;
        const word = s.slice(i, j);
        // Decimal number: 123.45 or 0,07 (DECIMAL-POINT IS COMMA)
        if (/^\d+$/.test(word)) {
          const sep = s[j];
          if ((sep === "." || (sep === "," && decimalComma)) && /\d/.test(s[j + 1] ?? "")) {
            let k = j + 1;
            while (k < s.length && /\d/.test(s[k])) k++;
            const frac = s.slice(j + 1, k);
            push({ t: "num", v: word + "." + frac, raw: s.slice(i, k), line: ll.line, comment: take() });
            i = k;
            continue;
          }
          push({ t: "num", v: word, raw: word, line: ll.line, comment: take() });
          i = j;
          continue;
        }
        const upper = word.toUpperCase();
        // EXEC SQL (and EXEC CICS / DLI, kept as a block so they can be reported as unsupported)
        if (upper === "EXEC" || upper === "EXECUTE") {
          const after = s.slice(j);
          const m = /^\s+(SQL|CICS|DLI)\b/i.exec(after);
          if (m) {
            const exec = m[1].toUpperCase();
            const rest = after.slice(m[0].length);
            const end = /END-EXEC/i.exec(rest);
            if (end) {
              const text = rest.slice(0, end.index);
              push({ t: "sql", v: text.replace(/\s+/g, " ").trim(), raw: text, line: ll.line, comment: take(), exec });
              i = j + m[0].length + end.index + 8;
            } else {
              sqlBuf = { text: rest, line: ll.line, comment: take(), exec };
              i = s.length;
            }
            continue;
          }
        }
        // PIC / PICTURE: raw picture string
        if (upper === "PIC" || upper === "PICTURE") {
          push({ t: "word", v: upper, raw: word, line: ll.line, comment: take() });
          let k = j;
          while (k < s.length && s[k] === " ") k++;
          if (/^IS\s/i.test(s.slice(k))) {
            k += 2;
            while (k < s.length && s[k] === " ") k++;
          }
          let e = k;
          while (e < s.length && s[e] !== " ") e++;
          let pic = s.slice(k, e);
          let period = false;
          if (pic.endsWith(".")) {
            pic = pic.slice(0, -1);
            period = true;
          }
          push({ t: "pic", v: pic.toUpperCase(), raw: pic, line: ll.line });
          if (period) push({ t: "period", v: ".", raw: ".", line: ll.line });
          i = e;
          continue;
        }
        // COPY: expansion
        if (upper === "COPY") {
          const m = /^\s+([A-Za-z0-9-]+)(?:\s+(?:OF|IN)\s+[A-Za-z0-9-]+)?([^.]*)\.?/i.exec(s.slice(j));
          if (m) {
            const name = m[1].toUpperCase();
            const stack = opts.copyStack ?? [];
            if (/REPLACING/i.test(m[2] ?? "")) {
              diagnostics.push({ line: ll.line, message: `COPY ${name} REPLACING is not supported: copybook inserted without replacement.`, file });
            }
            let src: string | null = null;
            if (!stack.includes(name)) src = opts.resolveCopy?.(name) ?? null;
            copies.push({ name, line: ll.line, resolved: !!src, file });
            if (src) {
              const sub = lex(src, { file: name, decimalComma, resolveCopy: opts.resolveCopy, copyStack: [...stack, name] });
              const first = sub.tokens.findIndex((t) => t.t !== "eof");
              if (first >= 0 && ll.comment && !sub.tokens[first].comment) sub.tokens[first].comment = take();
              for (const t of sub.tokens) if (t.t !== "eof") tokens.push(t);
              for (const cp of sub.copies) copies.push(cp);
              for (const d of sub.diagnostics) diagnostics.push(d);
            } else if (!stack.includes(name)) {
              diagnostics.push({ line: ll.line, message: `Copybook ${name} not found in the project.`, file });
            }
            i = j + m[0].length;
            continue;
          }
        }
        push({ t: "word", v: upper, raw: word, line: ll.line, comment: take() });
        i = j;
        continue;
      }
      // Unknown character: skip it and report it.
      diagnostics.push({ line: ll.line, message: `Unexpected character "${c}".`, file });
      i++;
    }
  }
  if (sqlBuf) diagnostics.push({ line: sqlBuf.line, message: "EXEC SQL without END-EXEC.", file });
  tokens.push({ t: "eof", v: "", raw: "", line: lines.length ? lines[lines.length - 1].line : 1, file });
  return { tokens, copies, comments, stats, diagnostics };
}
