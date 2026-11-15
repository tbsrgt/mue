// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";
import { notFound } from "next/navigation";
import CodeCompare from "@/components/app/CodeCompare";
import { highlightLine } from "@/components/app/highlight";
import { SubmitButton } from "@/components/app/SubmitButton";
import { Empty, Flash, fmtN, fmtWhen, StageChip } from "@/components/app/ui";
import { getProgramStates, getSystem, isReportCurrent, latestReport, listReports, ready, type ProgramState, type ReportRow } from "@/lib/services";
import type { ProgramAnalysis } from "@/lib/cobol/analyze";
import type { CobolProgram } from "@/lib/cobol/types";
import { CATEGORY_LABEL } from "@/lib/verify/runtime";
import { applyFixAction, convertAction, explainAction, verifyAction } from "../../../../actions";

export const dynamic = "force-dynamic";

type View = "understand" | "convert" | "verify";

export async function generateMetadata({ params }: { params: Promise<{ name: string }> }) {
  return { title: (await params).name };
}

export default async function ProgramPage({ params, searchParams }: { params: Promise<{ id: string; name: string }>; searchParams: Promise<{ view?: string; error?: string; ok?: string }> }) {
  await ready();
  const { id, name: programId } = await params;
  const sp = await searchParams;
  const projectId = Number(id);
  const sys = getSystem(projectId);
  const ast = sys.asts.get(programId);
  const analysis = sys.programs.find((p) => p.id === programId);
  const states = getProgramStates(projectId);
  const state = states.get(programId);
  if (!ast || !analysis || !state) notFound();
  const report = latestReport(projectId, programId);
  const current = report ? isReportCurrent(projectId, report, states) : false;
  const defaultView: View = !state.explanation ? "understand" : state.stage === "converted" || state.stage === "verified" ? "verify" : "convert";
  const view: View = sp.view === "understand" || sp.view === "convert" || sp.view === "verify" ? sp.view : defaultView;
  const base = `/projects/${projectId}/programs/${programId}`;

  const steps: { k: View; n: number; label: string; sub: string; done: boolean }[] = [
    { k: "understand", n: 1, label: "Understand", sub: state.explanation ? `${state.explanation.rules.length} business rules found` : "Read, explain, map", done: !!state.explanation },
    { k: "convert", n: 2, label: "Convert", sub: state.java ? `${state.java.className}.java` : "Readable Java, BigDecimal", done: !!state.java },
    { k: "verify", n: 3, label: "Verify", sub: report ? `${fmtN(report.identical)}/${fmtN(report.total)} identical${current ? "" : " · outdated"}` : "Replay and compare", done: state.stage === "verified" },
  ];

  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div>
          <div className="row" style={{ marginBottom: 6 }}>
            <StageChip stage={state.stage} />
            <span className="chip mut plain">{analysis.isSubprogram ? "Subprogram" : analysis.isBatch ? "Batch" : "Program"}</span>
            <span className="chip mut plain">{ast.file}</span>
          </div>
          <h1 className="mono" style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>{programId}</h1>
          <p>{ast.title ? ast.title.charAt(0) + ast.title.slice(1).toLowerCase() : "Untitled program"} · {fmtN(analysis.lines.total)} lines · complexity {analysis.complexity}{ast.author ? ` · ${ast.author}${ast.dateWritten ? `, ${ast.dateWritten}` : ""}` : ""}</p>
        </div>
      </div>
      <nav className="stepper" aria-label="Migration steps of the program">
        {steps.map((s) => (
          <Link key={s.k} href={`${base}?view=${s.k}`} aria-current={view === s.k ? "page" : undefined} className={s.done ? "done" : ""}>
            <span className="n">{s.done ? "✓" : s.n}</span>
            <span style={{ minWidth: 0 }}>
              <b>{s.label}</b>
              <small>{s.sub}</small>
            </span>
          </Link>
        ))}
      </nav>
      <Flash error={sp.error} ok={sp.ok} />
      {view === "understand" && <Understand projectId={projectId} ast={ast} analysis={analysis} state={state} />}
      {view === "convert" && <Convert projectId={projectId} ast={ast} state={state} />}
      {view === "verify" && <Verify projectId={projectId} ast={ast} state={state} report={report} current={current} history={listReports(projectId, programId)} />}
    </>
  );
}

function SourceBlock({ ast, open = false }: { ast: CobolProgram; open?: boolean }) {
  const lines = ast.source.replace(/\n$/, "").split("\n");
  return (
    <details className="codebox" open={open} id="source">
      <summary className="cbh" style={{ cursor: "pointer" }}>
        <span>COBOL source · {ast.file}</span>
        <span className="sp" />
        <span>{lines.length} lines</span>
      </summary>
      <div className="scroller">
        <pre className="code cobol">
          {lines.map((l, i) => {
            const cm = /^.{6}[*/]/.test(l);
            return (
              <div key={i} id={`c${i + 1}`} className={`l${cm ? " cm" : ""}`}>
                <i>{i + 1}</i>
                <span>{cm ? l : highlightLine(l, "cobol")}</span>
              </div>
            );
          })}
        </pre>
      </div>
    </details>
  );
}

// ---------------- Understand ----------------
function Understand({ projectId, ast, analysis, state }: { projectId: number; ast: CobolProgram; analysis: ProgramAnalysis; state: ProgramState }) {
  const e = state.explanation;
  if (!e)
    return (
      <div className="stack">
        <Empty
          glyph="NOT ANALYZED YET"
          title={`Mue will read the ${fmtN(analysis.lines.total)} lines of ${ast.id}`}
          action={
            <form action={explainAction.bind(null, projectId, ast.id)}>
              <SubmitButton className="btn lg" pending="Reading the code…">Analyze the program</SubmitButton>
            </form>
          }
        >
          It follows the calls ({analysis.calls.length}), copybooks ({analysis.copies.length}) and tables ({analysis.tables.length}), then writes down in plain English what the program does and its business rules, each with its source line.
        </Empty>
        <SourceBlock ast={ast} />
      </div>
    );
  return (
    <div className="stack">
      <div className="cols">
        <div className="stack">
          <section className="panel">
            <div className="hd">
              <h2>What this program does</h2>
              <span className="sp" />
              <span className="chip mut plain">Source: {e.provider === "mock" ? "deterministic engine" : e.provider} · to be reviewed</span>
            </div>
            <div className="bd">
              <p className="lead">{e.role}</p>
              {e.history && <p className="muted" style={{ fontSize: 13.5, margin: "12px 0 0" }}>{e.history}</p>}
            </div>
          </section>
          <section className="panel">
            <div className="hd"><h2>Business rules found</h2><span className="sp" /><small>{e.rules.length} rule{e.rules.length === 1 ? "" : "s"}, with their line</small></div>
            <div className="bd" style={{ paddingTop: 4, paddingBottom: 4 }}>
              {e.rules.length ? (
                <ol className="rules">
                  {e.rules.map((r) => (
                    <li key={r.n}>
                      <span className="no">R{r.n}</span>
                      <span><span className="k">{{ condition: "Condition", computation: "Computation", data: "Data", sql: "Database", call: "Call", loop: "Loop" }[r.kind]}</span>{r.text}</span>
                      <a className="ln" href={`#c${r.line}`}>l. {r.line}{r.endLine > r.line ? `–${r.endLine}` : ""}</a>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="muted">No rule extracted (the program has no condition or computation).</p>
              )}
            </div>
          </section>
          <section className="panel tight">
            <div className="hd"><h2>Paragraphs</h2><span className="sp" /><small>PERFORM and dead code</small></div>
            <div className="tw">
              <table className="t">
                <thead><tr><th>Paragraph</th><th className="num">Lines</th><th className="num">Stmts</th><th>Called by</th><th /></tr></thead>
                <tbody>
                  {analysis.paragraphs.map((p) => (
                    <tr key={p.name}>
                      <td><a className="pg" href={`#c${p.line}`}>{p.name}</a>{p.comment && <span className="sub">{p.comment.toLowerCase()}</span>}</td>
                      <td className="num">{p.line}–{p.endLine}</td>
                      <td className="num">{p.stmts}</td>
                      <td className="mono" style={{ fontSize: 12.5 }}>{p.performedBy.join(", ") || <span className="dimtxt">fall-through</span>}</td>
                      <td>{p.dead && <span className="chip warn">dead code</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
        <div className="stack">
          <section className="panel">
            <div className="hd"><h2>Dependencies</h2></div>
            <div className="bd deps">
              {e.dependencies.map((d) => (
                <div key={d.label}>
                  <span>{d.label}</span>
                  <ul>{d.items.map((i) => <li key={i}>{i}</li>)}</ul>
                </div>
              ))}
              {!e.dependencies.length && <p className="muted" style={{ margin: 0 }}>No dependency: standalone program.</p>}
            </div>
          </section>
          <section className="panel">
            <div className="hd"><h2>Points of attention</h2><span className="sp" /><small>{e.attention.length}</small></div>
            <div className="bd">
              <ul className="attn">
                {e.attention.map((a, i) => (
                  <li key={i} className={a.level}>
                    <span>{a.text}{a.line ? <> <a className="dim mono" style={{ fontSize: 11.5 }} href={`#c${a.line}`}>l. {a.line}</a></> : null}</span>
                  </li>
                ))}
                {!e.attention.length && <li>Nothing in particular.</li>}
              </ul>
            </div>
          </section>
          <section className="panel tight">
            <div className="hd"><h2>Field glossary</h2></div>
            <div className="tw" style={{ maxHeight: 340 }}>
              <table className="t">
                <thead><tr><th>Field</th><th>Meaning</th><th>PIC</th></tr></thead>
                <tbody>
                  {e.glossary.map((g) => (
                    <tr key={g.cobol}><td className="mono" style={{ fontSize: 12 }}>{g.cobol}</td><td style={{ fontSize: 13 }}>{g.label}</td><td className="mono dimtxt" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>{g.pic}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <div className="row">
            <Link href={`?view=convert`} className="btn">Next step: convert →</Link>
            <form action={explainAction.bind(null, projectId, ast.id)}>
              <SubmitButton className="btn ghost" pending="Reading…">Analyze again</SubmitButton>
            </form>
          </div>
        </div>
      </div>
      <SourceBlock ast={ast} open />
    </div>
  );
}

// ---------------- Convert ----------------
function Convert({ projectId, ast, state }: { projectId: number; ast: CobolProgram; state: ProgramState }) {
  const j = state.java;
  if (!j)
    return (
      <Empty
        glyph="READY TO CONVERT"
        title="Convert to readable Java"
        action={
          <form action={convertAction.bind(null, projectId, ast.id)}>
            <SubmitButton className="btn lg" pending="Converting…">Convert to Java</SubmitButton>
          </form>
        }
      >
        {state.explanation ? "" : "The program will be analyzed first. "}Each paragraph becomes a method, each field a BigDecimal or String with a business name, and each business rule is copied as a comment. Unsupported constructs are listed, never guessed.
      </Empty>
    );
  const blocking = j.todos.filter((t) => t.blocking);
  const lines = ast.source.replace(/\n$/, "").split("\n");
  const anyMismatch = j.decisions.some((d) => !d.matchesCobol);
  return (
    <div className="stack">
      <div className="grid2">
        <section className="panel">
          <div className="hd"><h2>Conversion decisions</h2><span className="sp" /><small>rounding · overflow</small></div>
          <div className="bd">
            {j.decisions.length ? (
              <ul className="attn">
                {j.decisions.map((d) => (
                  <li key={d.id} className={d.matchesCobol ? "" : "warn"}>
                    <span>
                      <span className="mono" style={{ fontSize: 12.5 }}>l. {d.line} · {d.cobol}</span> → <b className="mono" style={{ color: d.matchesCobol ? "var(--green)" : "var(--amber)" }}>{d.kind === "rounding" ? `RoundingMode.${d.choice}` : `overflow ${d.choice}`}</b>{" "}
                      {d.matchesCobol ? <span className="chip ok">matches COBOL</span> : <span className="chip warn">differs from COBOL ({d.cobolSemantics})</span>}{" "}
                      <span className="dim" style={{ fontSize: 12 }}>{d.source === "correction" ? "fix applied" : "project convention"}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted" style={{ margin: 0, fontSize: 14 }}>No sensitive decision: no rounding or overflow possible in this program.</p>
            )}
            {anyMismatch && <p className="muted" style={{ fontSize: 13, margin: "12px 0 0" }}>The team convention departs from COBOL semantics. The verification will show whether results change, and on which cases.</p>}
          </div>
        </section>
        <section className={`panel ${blocking.length ? "warnbox" : ""}`}>
          <div className="hd"><h2>Manual work</h2><span className="sp" /><small>{j.todos.length}</small></div>
          <div className="bd">
            {j.todos.length ? (
              <ul className="attn">
                {j.todos.map((t, i) => (
                  <li key={i} className={t.blocking ? "warn" : ""}>
                    <span><b className="mono" style={{ fontSize: 12.5 }}>{t.construct}</b> · l. {t.line}{t.file ? ` (${t.file})` : ""} · {t.text}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted" style={{ margin: 0, fontSize: 14 }}>Nothing: the whole program is in the supported subset.</p>
            )}
            {blocking.length > 0 && <p style={{ fontSize: 13, margin: "12px 0 0", color: "var(--amber)" }}>Mue does not certify a program with parts that were not converted: verification is blocked until they are rewritten.</p>}
          </div>
        </section>
      </div>
      <div className="row">
        <span className="muted" style={{ fontSize: 13 }}>Hover a line to see its counterpart, click to align the other column.</span>
        <span className="sp" />
        <form action={convertAction.bind(null, projectId, ast.id)}>
          <SubmitButton className="btn ghost sm" pending="Converting…">Convert again</SubmitButton>
        </form>
        <Link href="?view=verify" className="btn sm">Next step: verify →</Link>
      </div>
      <CodeCompare
        cobolName={ast.file}
        cobolLines={lines}
        files={j.files}
        mapping={j.mapping}
        cobolMarks={j.decisions.map((d) => ({ line: d.line, tone: d.matchesCobol ? "fx" : "hl" }))}
        javaMarks={[
          ...(j.decisions.some((d) => d.kind === "rounding" && !d.matchesCobol) ? [{ pattern: `RoundingMode.${j.conventions.rounding}`, tone: "hl" as const }] : []),
          ...(j.decisions.some((d) => d.kind === "rounding" && d.matchesCobol && d.source === "correction") ? [{ pattern: "RoundingMode.HALF_UP", tone: "fx" as const }] : []),
        ]}
      />
    </div>
  );
}

// ---------------- Verify ----------------
function Verify({ projectId, ast, state, report, current, history }: { projectId: number; ast: CobolProgram; state: ProgramState; report: ReportRow | null; current: boolean; history: Omit<ReportRow, "data">[] }) {
  if (!state.java)
    return (
      <Empty glyph="NOTHING TO COMPARE" title="Convert the program first" action={<Link className="btn" href="?view=convert">Go to conversion</Link>}>
        The verification replays the same cases through the original COBOL and the generated Java, then compares every result.
      </Empty>
    );
  const blocking = state.java.todos.filter((t) => t.blocking);
  if (blocking.length)
    return (
      <section className="panel warnbox">
        <div className="hd"><h2>Verification blocked</h2><span className="sp" /><span className="chip warn">{blocking.length} to migrate</span></div>
        <div className="bd">
          <p style={{ marginTop: 0, color: "var(--fg-2)" }}>This program contains constructs Mue does not convert automatically. Replaying it would not be honest: it would compare code that does not exist on the Java side.</p>
          <ul className="attn">
            {blocking.map((t, i) => (
              <li key={i} className="warn"><span><b className="mono">{t.construct}</b> · line {t.line} · {t.text}</span></li>
            ))}
          </ul>
        </div>
      </section>
    );
  const d = report?.data;
  return (
    <div className="stack">
      <section className="panel">
        <div className="bd row" style={{ gap: 16 }}>
          <div style={{ flex: "1 1 360px" }}>
            <b>Replay cases through the old and the new code</b>
            <p className="muted" style={{ margin: "4px 0 0", fontSize: 13.5 }}>
              Mue generates about 2,000 realistic cases plus edge cases (zeros, negatives, maximum values, condition boundaries, half-cent ties), runs them through the COBOL interpreter and the Java model, then compares every output field, every database write and every DISPLAY line.
            </p>
          </div>
          <form action={verifyAction.bind(null, projectId, ast.id)}>
            <SubmitButton className="btn lg" pending="Replaying…">{report ? "Replay" : "Run the comparison"}</SubmitButton>
          </form>
        </div>
      </section>

      {!report || !d ? (
        <Empty glyph="NO REPLAY" title="No report for this program yet">Run the comparison: the report is saved and can be exported.</Empty>
      ) : (
        <>
          {!current && <div className="flash info"><span>!</span><span>This report predates the last conversion of one of the replayed programs. Run the comparison again.</span></div>}
          {d.appliedFix && <div className="flash ok"><span>✓</span><span>Replayed after fix: {d.appliedFix}.</span></div>}
          <div className="big3">
            <div><span>Replayed cases</span><b>{fmtN(report.total)}</b></div>
            <div><span>Identical</span><b style={{ color: "var(--green)" }}>{fmtN(report.identical)}</b></div>
            <div><span>Mismatches</span><b style={{ color: report.mismatches ? "var(--red)" : "var(--fg)" }}>{fmtN(report.mismatches)}</b></div>
          </div>

          {report.mismatches === 0 ? (
            <section className="okbox">
              <div className="bd" style={{ padding: 18 }}>
                <div className="row"><span className="chip ok">Equivalent</span><b>Ready to go live</b></div>
                <p style={{ margin: "8px 0 0", color: "var(--fg-2)", fontSize: 14.5 }}>The Java gives exactly the same results as the COBOL on all {fmtN(report.total)} replayed cases, edge cases included. The timestamped report can go into the audit file.</p>
              </div>
            </section>
          ) : (
            d.groups.map((g, i) => {
              const ex = d.explanations[i];
              return (
                <section key={i} className="cause">
                  <div className="hd" style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid" }}>
                    <span className="ai">Probable cause</span>
                    <h3 style={{ margin: 0, fontSize: 15 }}>{ex?.title ?? g.kind}</h3>
                    <span className="sp" />
                    <span className="chip bad">{g.count} mismatch{g.count === 1 ? "" : "es"}</span>
                    <span className="mono dim" style={{ fontSize: 12 }}>{g.program} l. {g.line} · {g.field}</span>
                  </div>
                  <div className="bd" style={{ padding: 16 }}>
                    <p>{ex?.explanation}</p>
                    <div className="tw" style={{ marginBottom: 14 }}>
                      <table className="t">
                        <thead><tr><th>Case</th><th className="num">Exact value</th><th className="num">COBOL</th><th className="num">Java</th></tr></thead>
                        <tbody>
                          {g.examples.map((x) => (
                            <tr key={x.caseId}><td className="mono">#{x.caseId}</td><td className="num">{x.raw ?? "—"}</td><td className="num ok">{x.cobol}</td><td className="num bad">{x.java}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {ex?.fix && current && (
                      <div className="row">
                        <form action={applyFixAction.bind(null, projectId, ast.id, report.id, i, "program")}>
                          <SubmitButton className="btn" pending="Fixing, converting, replaying…">Apply the fix and replay</SubmitButton>
                        </form>
                        <form action={applyFixAction.bind(null, projectId, ast.id, report.id, i, "project")}>
                          <SubmitButton className="btn ghost" pending="Fixing the project…">Apply to the whole project</SubmitButton>
                        </form>
                        <span className="muted" style={{ fontSize: 12.5 }}>{ex.fix.label}</span>
                      </div>
                    )}
                    {!ex?.fix && <p className="muted" style={{ fontSize: 13, margin: 0 }}>No automatic fix: to be decided with the business owners ({ex?.confidence}).</p>}
                  </div>
                </section>
              );
            })
          )}

          <div className="grid2">
            <section className="panel tight">
              <div className="hd"><h2>Test data</h2><span className="sp" /><small>seed {d.seed} · {d.durationMs} ms</small></div>
              <div className="tw">
                <table className="t">
                  <thead><tr><th>Category</th><th className="num">Cases</th><th className="num">Mismatches</th><th style={{ width: "30%" }} /></tr></thead>
                  <tbody>
                    {d.byCategory.map((c) => (
                      <tr key={c.category}>
                        <td>{CATEGORY_LABEL[c.category]}</td>
                        <td className="num">{fmtN(c.total)}</td>
                        <td className={`num ${c.mismatches ? "bad" : "dimtxt"}`}>{c.mismatches}</td>
                        <td><div className="bar"><i className={c.mismatches ? "bad" : ""} style={{ width: `${c.mismatches ? Math.max(4, (c.mismatches / c.total) * 100) : 100}%` }} /></div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="panel">
              <div className="hd"><h2>What is compared</h2></div>
              <div className="bd">
                <dl className="kv">
                  <dt>Inputs</dt><dd>{d.inputs.join(", ") || "—"}</dd>
                  {d.selects.length > 0 && (<><dt>Read from DB</dt><dd>{d.selects.join(", ")}</dd></>)}
                  {d.cursors.length > 0 && (<><dt>Cursors</dt><dd>{d.cursors.join(", ")} (1 to 6 rows per case)</dd></>)}
                  <dt>Outputs</dt><dd>{d.outputs.join(", ")}</dd>
                  <dt>Also</dt><dd>SQL writes, external calls, DISPLAY lines</dd>
                  <dt>Java replayed</dt><dd>{d.javaPrograms.map((j) => `${j.className} (${j.rounding})`).join(", ")}</dd>
                </dl>
              </div>
            </section>
          </div>

          {d.warnings.length > 0 && (
            <section className="warnbox">
              <div className="hd" style={{ display: "flex", padding: "12px 16px", borderBottom: "1px solid var(--line)" }}><h3 style={{ margin: 0, fontSize: 14 }}>Legacy behaviors reproduced exactly</h3></div>
              <div className="bd" style={{ padding: 16 }}>
                <ul className="attn">
                  {d.warnings.map((w, i) => (
                    <li key={i} className="warn">
                      <span><b>{w.title}</b> · {w.count} cases{w.line ? ` · ${w.program} l. ${w.line}` : ""}. {w.detail} <span className="dim mono" style={{ fontSize: 12 }}>{w.examples.join(" · ")}</span></span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          {d.examples.length > 0 && (
            <section className="panel tight">
              <div className="hd"><h2>Mismatching cases</h2><span className="sp" /><small>first {d.examples.length}</small></div>
              <div className="tw">
                <table className="t">
                  <thead><tr><th>Case</th><th>Category</th><th>Inputs</th><th>Difference</th></tr></thead>
                  <tbody>
                    {d.examples.slice(0, 12).map((x) => (
                      <tr key={x.id}>
                        <td className="mono">#{x.id}</td>
                        <td style={{ fontSize: 12.5 }}>{CATEGORY_LABEL[x.category]}</td>
                        <td className="mono" style={{ fontSize: 11.5, color: "var(--fg-2)" }}>{Object.entries(x.inputs).slice(0, 4).map(([k, v]) => `${k}=${v}`).join("  ") || (x.rows ? `${x.rows} row(s) from DB` : "—")}</td>
                        <td className="mono" style={{ fontSize: 12 }}>{x.diffs.slice(0, 2).map((df, k) => <div key={k}>{df.name}: <span className="ok">{df.cobol}</span> ≠ <span className="bad">{df.java}</span></div>)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="panel">
            <div className="hd"><h2>Replay history</h2><span className="sp" /><Link className="btn ghost sm" href={`/reports/${report.id}`}>Printable report</Link><a className="btn ghost sm" href={`/reports/${report.id}/html?download=1`}>Download (HTML)</a></div>
            <div className="bd" style={{ paddingTop: 4, paddingBottom: 4 }}>
              <ul className="journal">
                {history.map((h) => (
                  <li key={h.id}>
                    <time>{fmtWhen(h.createdAt)}</time>
                    <span>
                      <Link href={`/reports/${h.id}`} className="mono" style={{ textDecoration: "none" }}>#{h.id}</Link> · {fmtN(h.total)} cases · {h.mismatches ? <span style={{ color: "var(--red)" }}>{h.mismatches} mismatches</span> : <span style={{ color: "var(--green)" }}>0 mismatches</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
