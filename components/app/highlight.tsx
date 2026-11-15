// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";

const JAVA_KW = /\b(public|private|static|final|class|void|if|else|return|new|while|for|do|switch|case|default|throw|try|catch|import|package|int|boolean|this)\b/;
const COBOL_KW = /(?<![A-Za-z0-9-])(IF|ELSE|END-IF|MOVE|TO|COMPUTE|ROUNDED|PERFORM|UNTIL|VARYING|FROM|BY|EVALUATE|WHEN|OTHER|END-EVALUATE|END-PERFORM|CALL|USING|GOBACK|STOP|RUN|ADD|SUBTRACT|MULTIPLY|DIVIDE|GIVING|INTO|SET|TRUE|DISPLAY|EXEC|SQL|END-EXEC|SELECT|UPDATE|INSERT|FETCH|OPEN|CLOSE|WHERE|AND|OR|NOT|ZERO|SPACES|PIC|VALUE|COPY|DIVISION|SECTION|PROGRAM-ID|GO)(?![A-Za-z0-9-])/;

/** Lightweight syntax highlighting, line by line. */
export function highlightLine(line: string, lang: "java" | "cobol"): ReactNode {
  if (lang === "java") {
    const ci = line.indexOf("//");
    const code = ci >= 0 && !/"[^"]*\/\/[^"]*"/.test(line) ? line.slice(0, ci) : line;
    const comment = code.length < line.length ? line.slice(code.length) : "";
    return (
      <>
        {tokenize(code, JAVA_KW, /"(?:[^"\\]|\\.)*"/)}
        {comment && <span className="tok-c">{comment}</span>}
      </>
    );
  }
  return tokenize(line, COBOL_KW, /'[^']*'|"[^"]*"/);
}

function tokenize(text: string, kw: RegExp, str: RegExp): ReactNode[] {
  const re = new RegExp(`(${str.source})|(${kw.source})|((?<![A-Za-z0-9-])\\d+(?:[.,]\\d+)?(?![A-Za-z0-9-]))`, "g");
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const cls = m[1] ? "tok-s" : m[2] ? "tok-k" : "tok-n";
    out.push(
      <span key={k++} className={cls}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
