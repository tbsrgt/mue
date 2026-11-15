// SPDX-License-Identifier: AGPL-3.0-only
"use client";
import { useMemo, useRef, useState } from "react";
import type { JavaFile, LineMap } from "@/lib/java/render";
import { highlightLine } from "./highlight";

interface Props {
  cobolName: string;
  cobolLines: string[];
  files: JavaFile[];
  mapping: LineMap[];
  /** COBOL lines to flag (e.g. a ROUNDED whose decision differs). */
  cobolMarks?: { line: number; tone: "hl" | "fx" }[];
  javaMarks?: { pattern: string; tone: "hl" | "fx" }[];
}

export default function CodeCompare({ cobolName, cobolLines, files, mapping, cobolMarks = [], javaMarks = [] }: Props) {
  const [fileIdx, setFileIdx] = useState(0);
  const [sel, setSel] = useState<LineMap | null>(null);
  const javaRef = useRef<HTMLDivElement>(null);
  const cobolRef = useRef<HTMLDivElement>(null);
  const file = files[fileIdx];
  const javaLines = useMemo(() => file.content.replace(/\n$/, "").split("\n"), [file]);
  const isMain = file.kind === "main";

  const best = (pred: (m: LineMap) => boolean) =>
    mapping.filter(pred).sort((a, b) => a.javaEnd - a.javaStart + (a.cobolEnd - a.cobolStart) - (b.javaEnd - b.javaStart + (b.cobolEnd - b.cobolStart)))[0] ?? null;

  const scrollTo = (box: HTMLDivElement | null, line: number) => {
    const el = box?.querySelector<HTMLElement>(`[data-l="${line}"]`);
    if (el && box) box.scrollTo({ top: el.offsetTop - box.clientHeight / 3, behavior: "smooth" });
  };

  const pickCobol = (l: number, scroll: boolean) => {
    const m = best((x) => l >= x.cobolStart && l <= x.cobolEnd);
    setSel(m);
    if (m && scroll && isMain) scrollTo(javaRef.current, m.javaStart);
  };
  const pickJava = (l: number, scroll: boolean) => {
    if (!isMain) return;
    const m = best((x) => l >= x.javaStart && l <= x.javaEnd);
    setSel(m);
    if (m && scroll) scrollTo(cobolRef.current, m.cobolStart);
  };

  const cobolMark = new Map(cobolMarks.map((m) => [m.line, m.tone]));

  return (
    <div className="split" onMouseLeave={() => setSel(null)}>
      <div className="codebox">
        <div className="cbh">
          <span>Original COBOL · {cobolName}</span>
          <span className="sp" />
          <span>{cobolLines.length} lines</span>
        </div>
        <div className="scroller" ref={cobolRef}>
          <pre className="code cobol" aria-label={`COBOL source ${cobolName}`}>
            {cobolLines.map((line, i) => {
              const n = i + 1;
              const on = sel && n >= sel.cobolStart && n <= sel.cobolEnd;
              const cm = /^.{6}[*/]/.test(line);
              const mark = cobolMark.get(n);
              return (
                <div key={n} data-l={n} className={`l${cm ? " cm" : ""}${on ? " on" : ""}${mark && !on ? " " + mark : ""}`} onMouseEnter={() => pickCobol(n, false)} onClick={() => pickCobol(n, true)}>
                  <i>{n}</i>
                  <span>{cm ? line : highlightLine(line, "cobol")}</span>
                </div>
              );
            })}
          </pre>
        </div>
      </div>
      <div className="codebox">
        <div className="cbh">
          <div className="ftabs" role="group" aria-label="Generated Java files">
            {files.map((f, i) => (
              <button key={f.name} type="button" aria-pressed={i === fileIdx} onClick={() => { setFileIdx(i); setSel(null); }}>
                {f.name}
                {f.kind === "runtime" ? " · runtime" : ""}
              </button>
            ))}
          </div>
          <span className="sp" />
          <button type="button" className="btn ghost sm" onClick={() => navigator.clipboard?.writeText(file.content)}>
            Copy
          </button>
        </div>
        <div className="scroller" ref={javaRef}>
          <pre className="code java" aria-label={`Generated Java ${file.name}`}>
            {javaLines.map((line, i) => {
              const n = i + 1;
              const on = isMain && sel && n >= sel.javaStart && n <= sel.javaEnd;
              const cm = /^\s*(\/\/|\/\*\*|\*)/.test(line);
              const mark = isMain ? javaMarks.find((m) => line.includes(m.pattern))?.tone : undefined;
              return (
                <div key={n} data-l={n} className={`l${cm ? " cm" : ""}${on ? " on" : ""}${mark && !on ? " " + mark : ""}`} onMouseEnter={() => pickJava(n, false)} onClick={() => pickJava(n, true)}>
                  <i>{n}</i>
                  <span>{cm ? line : highlightLine(line, "java")}</span>
                </div>
              );
            })}
          </pre>
        </div>
      </div>
    </div>
  );
}
