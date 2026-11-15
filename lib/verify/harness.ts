// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Equivalence harness: generates test data (realistic random values + edge cases),
 * runs the COBOL interpreter and the Java model on every case, compares them, then walks
 * back to the first diverging statement to explain each mismatch.
 */
import Decimal from "decimal.js";
import { dataFlow, elementaryOf, walkStmts } from "../cobol/analyze";
import { CobolMachine } from "../cobol/interpreter";
import type { CobolProgram, Cond, Expr, Stmt } from "../cobol/types";
import { JavaMachine } from "../java/executor";
import type { JProgram } from "../java/ir";
import { CATEGORY_LABEL, DX, type CaseCategory, type RunResult, type StoreEvent, type TestCase } from "./runtime";

// ---------------- deterministic PRNG ----------------
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ---------------- input profiles ----------------
interface FieldProfile {
  name: string;
  program: string;
  numeric: boolean;
  intDigits: number;
  scale: number;
  signed: boolean;
  length: number;
  candidates: string[];
  bounds: string[];
}

function reachablePrograms(system: Map<string, CobolProgram>, root: string): CobolProgram[] {
  const out: CobolProgram[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const p = system.get(id);
    if (!p) return;
    out.push(p);
    for (const para of p.paragraphs) walkStmts(para.stmts, (s) => s.kind === "call" && s.program && visit(s.program));
  };
  visit(root);
  return out;
}

function litOf(e: Expr, prog: CobolProgram): string | null {
  if (e.k === "num") return e.v;
  if (e.k === "str") return e.v;
  if (e.k === "fig" && e.v === "ZERO") return "0";
  if (e.k === "ref") {
    const it = prog.fields.get(e.name);
    if (it?.value?.kind === "num" || it?.value?.kind === "str") return it.value.value;
  }
  return null;
}

function collectDomains(progs: CobolProgram[]) {
  const dom = new Map<string, { candidates: Set<string>; bounds: Set<string> }>();
  const get = (n: string) => {
    if (!dom.has(n)) dom.set(n, { candidates: new Set(), bounds: new Set() });
    return dom.get(n)!;
  };
  for (const p of progs) {
    for (const it of p.fields.values())
      for (const c of it.conditions) {
        for (const v of c.values) if (v.kind !== "fig") get(it.name).candidates.add(v.value);
        for (const [lo, hi] of c.ranges) {
          if (lo.kind !== "fig") get(it.name).bounds.add(lo.value);
          if (hi.kind !== "fig") get(it.name).bounds.add(hi.value);
        }
      }
    const visitCond = (c: Cond) => {
      if (c.k === "rel") {
        if (c.l.k === "ref") {
          const v = litOf(c.r, p);
          if (v !== null) (p.fields.get(c.l.name)?.pic?.kind === "numeric" ? get(c.l.name).bounds : get(c.l.name).candidates).add(v);
        }
        if (c.r.k === "ref") {
          const v = litOf(c.l, p);
          if (v !== null) (p.fields.get(c.r.name)?.pic?.kind === "numeric" ? get(c.r.name).bounds : get(c.r.name).candidates).add(v);
        }
      } else if (c.k === "and" || c.k === "or") {
        visitCond(c.a);
        visitCond(c.b);
      } else if (c.k === "not") visitCond(c.c);
    };
    for (const para of p.paragraphs)
      walkStmts(para.stmts, (s: Stmt) => {
        if (s.kind === "if") visitCond(s.cond);
        if (s.kind === "perform" && s.until) visitCond(s.until);
        if (s.kind === "evaluate") {
          if (s.subject !== "TRUE" && s.subject !== "FALSE" && s.subject.k === "ref") {
            const name = s.subject.name;
            for (const w of s.whens) for (const o of w.objs) if (o.kind === "value") {
              const v = litOf(o.v, p);
              if (v !== null) (p.fields.get(name)?.pic?.kind === "numeric" ? get(name).bounds : get(name).candidates).add(v);
            }
          } else for (const w of s.whens) for (const o of w.objs) if (o.kind === "cond") visitCond(o.c);
        }
      });
  }
  return dom;
}

function profile(prog: CobolProgram, name: string, dom: ReturnType<typeof collectDomains>): FieldProfile | null {
  const it = prog.fields.get(name);
  if (!it || !it.pic) return null;
  const d = dom.get(name);
  return {
    name,
    program: prog.id,
    numeric: it.pic.kind === "numeric",
    intDigits: it.pic.intDigits,
    scale: it.pic.scale,
    signed: it.pic.signed,
    length: it.pic.length,
    candidates: [...(d?.candidates ?? [])],
    bounds: [...(d?.bounds ?? [])],
  };
}

// ---------------- value generators ----------------
type Rand = () => number;

function maxOf(f: FieldProfile): Decimal {
  return new DX(10).pow(f.intDigits).minus(new DX(10).pow(-f.scale));
}

function clampToPic(v: Decimal, f: FieldProfile): string {
  let x = v.toDecimalPlaces(f.scale, Decimal.ROUND_DOWN);
  const max = maxOf(f);
  if (x.gt(max)) x = max;
  if (!f.signed && x.isNeg()) x = x.abs();
  if (f.signed && x.lt(max.neg())) x = max.neg();
  return x.toFixed(f.scale);
}

/** Words of a COBOL name ("LK-DAYS-LATE" → ["LK", "DAYS", "LATE"]). */
function nameWords(f: FieldProfile): string[] {
  return f.name.toUpperCase().split(/[-_]+/);
}

/** True when one word of the field name matches the pattern (English and French names). */
function nameHas(f: FieldProfile, re: RegExp): boolean {
  return nameWords(f).some((w) => re.test(w));
}

const RATE = /^(RATE|RT|TAUX|TX)$/;
const DAYS = /^(DAYS?|JOURS?)$/;
const MONTHS = /^(MONTHS?|MOIS)$/;
const AMOUNT = /^(AMOUNT|AMT|BALANCE|BAL|PRINCIPAL|PREMIUM|LIMIT|CAP|TOTAL|FEES?|SOLDE|MONTANT|CAPITAL|PRIME|PLAFOND|MT|MNT)$/;
const ID_LIKE = /^(NUMBER|NUM|NO|NBR|REF|REFERENCE|ID|ACCOUNT|ACCT|CUSTOMER|CUST|CONTRACT|CLIENT|COMPTE|CONTRAT|NUMERO)$/;

function realisticNumber(f: FieldProfile, r: Rand): string {
  const max = maxOf(f).toNumber();
  let v: number;
  if (nameHas(f, RATE)) v = r() * Math.min(max, 6);
  else if (nameHas(f, DAYS)) v = 1 + Math.floor(r() * Math.min(max, 366));
  else if (nameHas(f, MONTHS)) v = 1 + Math.floor(r() * Math.min(max, 300));
  else if (nameHas(f, AMOUNT)) v = Math.exp(r() * Math.log(Math.min(max, 250000) + 1)) - 1;
  else if (f.scale === 0 && f.intDigits <= 3) v = Math.floor(r() * (max + 1));
  else v = r() * Math.min(max, 5000);
  if (f.signed && r() < 0.12) v = -v;
  return clampToPic(new DX(v), f);
}

const NICE = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 10, 12.5, 25, 50, 100, 125, 250, 500, 1000];

/** "Round" values: they hit exact half-cent ties far more often. */
function niceNumber(f: FieldProfile, r: Rand): string {
  if (nameHas(f, DAYS)) return clampToPic(new DX([73, 91, 146, 182, 365, 30, 60, 90, 180, 360][Math.floor(r() * 10)]), f);
  if (nameHas(f, MONTHS)) return clampToPic(new DX([1, 2, 3, 4, 6, 8, 12, 16, 24, 36, 48][Math.floor(r() * 11)]), f);
  if (nameHas(f, RATE)) return clampToPic(new DX([0.5, 1, 1.25, 1.5, 2, 2.5, 3, 3.5, 4, 5][Math.floor(r() * 10)]), f);
  const base = NICE[Math.floor(r() * NICE.length)] * (1 + Math.floor(r() * 400));
  const cents = [0, 0.05, 0.1, 0.25, 0.5, 0.75, 0.15, 0.35][Math.floor(r() * 8)];
  return clampToPic(new DX(base + cents), f);
}

function randomText(f: FieldProfile, r: Rand): string {
  if (f.candidates.length && r() < 0.88) return f.candidates[Math.floor(r() * f.candidates.length)];
  const alphabet = nameHas(f, ID_LIKE) ? "0123456789" : "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const len = Math.max(1, Math.min(f.length, f.length <= 4 ? f.length : 6 + Math.floor(r() * Math.max(1, f.length - 6))));
  let s = "";
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(r() * alphabet.length)];
  return s;
}

function valueFor(f: FieldProfile, r: Rand, nice = false): string {
  if (!f.numeric) return randomText(f, r);
  if (f.bounds.length && r() < 0.15) return boundaryValues(f)[Math.floor(r() * boundaryValues(f).length)];
  return nice ? niceNumber(f, r) : realisticNumber(f, r);
}

function boundaryValues(f: FieldProfile): string[] {
  const eps = new DX(10).pow(-f.scale);
  const out = new Set<string>();
  for (const b of f.bounds) {
    const k = new DX(b);
    for (const v of [k.minus(eps), k, k.plus(eps)]) if (f.signed || !v.isNeg()) out.add(clampToPic(v, f));
  }
  return [...out];
}

// ---------------- test plan ----------------
export interface TestPlan {
  inputs: FieldProfile[];
  selectVars: FieldProfile[];
  cursors: { name: string; vars: FieldProfile[] }[];
  hasSelect: boolean;
  outputs: string[];
}

export function buildPlan(system: Map<string, CobolProgram>, programId: string): TestPlan {
  const prog = system.get(programId)!;
  const progs = reachablePrograms(system, programId);
  const dom = collectDomains(progs);
  const { inputs, outputs } = dataFlow(prog);
  const inputProfiles = inputs.map((n) => profile(prog, n, dom)).filter((x): x is FieldProfile => !!x);
  const selectVars: FieldProfile[] = [];
  const cursors = new Map<string, FieldProfile[]>();
  let hasSelect = false;
  for (const p of progs)
    for (const para of p.paragraphs)
      walkStmts(para.stmts, (s) => {
        if (s.kind !== "sql") return;
        if (s.sql.op === "SELECT") {
          hasSelect = true;
          for (const v of s.sql.into) {
            const pr = profile(p, v, dom);
            if (pr && !selectVars.some((x) => x.name === v)) selectVars.push(pr);
          }
        }
        if (s.sql.op === "FETCH" && s.sql.cursor) {
          const vars = s.sql.into.map((v) => profile(p, v, dom)).filter((x): x is FieldProfile => !!x);
          cursors.set(s.sql.cursor, vars);
        }
      });
  // Fields filled by FETCH are not direct inputs.
  const fetched = new Set([...cursors.values()].flat().map((f) => f.name));
  return {
    inputs: inputProfiles.filter((f) => !fetched.has(f.name)),
    selectVars,
    cursors: [...cursors].map(([name, vars]) => ({ name, vars })),
    hasSelect,
    outputs: outputs.filter((o) => prog.fields.has(o)),
  };
}

function makeCase(plan: TestPlan, id: number, category: CaseCategory, r: Rand, nice = false, rowsMax = 6): TestCase {
  const tc: TestCase = { id, category, inputs: {}, sqlSelect: {}, sqlNotFound: false, cursors: {} };
  for (const f of plan.inputs) tc.inputs[f.name] = valueFor(f, r, nice);
  for (const f of plan.selectVars) tc.sqlSelect[f.name] = valueFor(f, r, nice);
  for (const c of plan.cursors) {
    const n = 1 + Math.floor(r() * rowsMax);
    tc.cursors[c.name] = Array.from({ length: n }, () => Object.fromEntries(c.vars.map((f) => [f.name, valueFor(f, r, nice)])));
  }
  if (plan.hasSelect && category === "random" && r() < 0.06) {
    tc.sqlNotFound = true;
    tc.category = "sql-not-found";
  }
  return tc;
}

function isTie(raw: string, scale: number): boolean {
  const x = new DX(raw).times(new DX(10).pow(scale));
  return x.minus(x.trunc()).abs().eq(0.5);
}

/** A tie where HALF_UP and HALF_EVEN disagree (the digit before the 5 is even). */
function isDiscriminatingTie(raw: string, scale: number): boolean {
  if (!isTie(raw, scale)) return false;
  const x = new DX(raw);
  return !x.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP).eq(x.toDecimalPlaces(scale, Decimal.ROUND_HALF_EVEN));
}

export interface GenerateOptions {
  /** Number of realistic random cases (default 2,000, or 400 for batch programs with cursors). */
  count?: number;
  /**
   * Total number of cases. Edge cases and targeted half-cent cases are generated first, then
   * random cases fill up to this total. Takes precedence over `count`.
   */
  total?: number;
  seed?: number;
  maxSteps?: number;
}

export function generateCases(system: Map<string, CobolProgram>, programId: string, plan: TestPlan, opts: GenerateOptions = {}): TestCase[] {
  const seed = opts.seed ?? hashSeed(programId);
  // Three independent streams, so the edge cases do not depend on how many random cases are asked for.
  const rRandom = mulberry32(seed);
  const r = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const batch = plan.cursors.length > 0;
  const count = opts.count ?? (batch ? 400 : 2000);
  const cases: TestCase[] = [];
  let id = 1;

  // Zero, negative and maximum values, condition boundaries
  const numericInputs = [...plan.inputs, ...plan.selectVars].filter((f) => f.numeric);
  const allFields = [...plan.inputs, ...plan.selectVars, ...plan.cursors.flatMap((c) => c.vars)];
  const setField = (tc: TestCase, f: FieldProfile, v: string) => {
    if (plan.inputs.includes(f)) tc.inputs[f.name] = v;
    else if (plan.selectVars.includes(f)) tc.sqlSelect[f.name] = v;
    else for (const c of plan.cursors) if (c.vars.includes(f)) for (const row of tc.cursors[c.name] ?? []) row[f.name] = v;
  };
  const numericAll = allFields.filter((f) => f.numeric);
  for (const f of numericAll) {
    const tc = makeCase(plan, id++, "zero", r);
    setField(tc, f, (0).toFixed(f.scale));
    cases.push(tc);
  }
  if (numericAll.length) {
    const tc = makeCase(plan, id++, "zero", r);
    for (const f of numericAll) setField(tc, f, (0).toFixed(f.scale));
    cases.push(tc);
  }
  for (const f of numericAll.filter((x) => x.signed))
    for (let k = 0; k < 3; k++) {
      const tc = makeCase(plan, id++, "negative", r);
      setField(tc, f, clampToPic(new DX(realisticNumber(f, r)).abs().neg(), f));
      cases.push(tc);
    }
  for (const f of numericAll) {
    const tc = makeCase(plan, id++, "max", r);
    setField(tc, f, maxOf(f).toFixed(f.scale));
    cases.push(tc);
  }
  if (numericAll.length) {
    const tc = makeCase(plan, id++, "max", r);
    for (const f of numericAll) setField(tc, f, maxOf(f).toFixed(f.scale));
    cases.push(tc);
  }
  for (const f of allFields) {
    const vals = f.numeric ? boundaryValues(f) : f.candidates;
    for (const v of vals) {
      const tc = makeCase(plan, id++, "boundary", r);
      setField(tc, f, v);
      cases.push(tc);
    }
  }
  void numericInputs;

  // Targeted search for half-cent ties on ROUNDED statements
  const hasRounded = reachablePrograms(system, programId).some((p) => p.paragraphs.some((para) => {
    let found = false;
    walkStmts(para.stmts, (s) => {
      if (s.kind === "compute" && s.targets.some((t) => t.rounded)) found = true;
    });
    return found;
  }));
  if (hasRounded) {
    const wanted = Math.max(8, Math.min(40, Math.round((opts.total ?? count) / 60)));
    const seen = new Set<string>();
    let found = 0;
    for (let k = 0; k < 6000 && found < wanted; k++) {
      const tc = makeCase(plan, id, "half-cent", r, true, 3);
      const m = new CobolMachine(system, tc, { trace: true, maxSteps: opts.maxSteps ?? 5000 });
      let res: RunResult;
      try {
        res = m.run(programId, []);
      } catch {
        continue;
      }
      // Only keep ties that actually separate the rounding modes: they are the informative ones.
      const tie = res.stores.find((e) => e.rounded && e.raw && !e.sizeError && isDiscriminatingTie(e.raw, scaleOf(system, e)));
      if (!tie) continue;
      const key = `${tie.program}:${tie.stmtId}:${tie.raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tc.id = id++;
      cases.push(tc);
      found++;
    }
  }
  // Realistic random operations fill up to the requested total.
  const randomCount = opts.total !== undefined ? Math.max(0, opts.total - cases.length) : count;
  const random: TestCase[] = [];
  for (let i = 0; i < randomCount; i++) random.push(makeCase(plan, 0, "random", rRandom));
  return [...random, ...cases].map((tc, i) => ({ ...tc, id: i + 1 }));
}

function scaleOf(system: Map<string, CobolProgram>, e: StoreEvent): number {
  return system.get(e.program)?.fields.get(e.field)?.pic?.scale ?? 0;
}

// ---------------- comparison ----------------
export interface Diff {
  what: "status" | "field" | "display" | "sql" | "call";
  name: string;
  cobol: string;
  java: string;
}

export function compareRuns(a: RunResult, b: RunResult): Diff[] {
  const out: Diff[] = [];
  // Same abnormal stop on both sides: the state at the time of the stop is not comparable.
  if (a.status === b.status && a.status !== "ok") return out;
  if (a.status !== b.status) out.push({ what: "status", name: "execution", cobol: a.status + (a.message ? ` (${a.message})` : ""), java: b.status + (b.message ? ` (${b.message})` : "") });
  for (const k of Object.keys(a.fields)) if (a.fields[k] !== b.fields[k]) out.push({ what: "field", name: k, cobol: a.fields[k], java: b.fields[k] ?? "(missing)" });
  const cmpList = (what: Diff["what"], x: string[], y: string[]) => {
    const n = Math.max(x.length, y.length);
    for (let i = 0; i < n; i++) if (x[i] !== y[i]) out.push({ what, name: `#${i + 1}`, cobol: x[i] ?? "(none)", java: y[i] ?? "(none)" });
  };
  cmpList("display", a.displays, b.displays);
  cmpList("sql", a.sql, b.sql);
  cmpList("call", a.calls, b.calls);
  return out;
}

// ---------------- root cause of mismatches ----------------
export type CauseKind = "rounding-tie" | "overflow" | "precision" | "control-flow" | "unsupported" | "other";

export interface Divergence {
  kind: CauseKind;
  program: string;
  stmtId: number;
  line: number;
  field: string;
  cobolValue: string;
  javaValue: string;
  raw?: string;
  javaMode?: string;
  pic?: string;
}

export function firstDivergence(system: Map<string, CobolProgram>, javas: Map<string, JProgram>, programId: string, tc: TestCase, maxSteps: number): Divergence | null {
  const a = new CobolMachine(system, tc, { trace: true, maxSteps }).run(programId, []);
  const b = new JavaMachine(javas, tc, { trace: true, maxSteps }).run(programId, []);
  const n = Math.min(a.stores.length, b.stores.length);
  for (let i = 0; i < n; i++) {
    const x = a.stores[i];
    const y = b.stores[i];
    if (x.program === y.program && x.stmtId === y.stmtId && x.field === y.field && x.value === y.value) continue;
    const prog = system.get(x.program);
    const stmt = findStmt(prog, x.stmtId);
    const jp = javas.get(x.program);
    const decision = jp?.decisions.find((d) => d.stmtId === x.stmtId && d.id.endsWith(`:${x.field}`));
    const pic = prog?.fields.get(x.field)?.pic;
    let kind: CauseKind = "other";
    if (x.program !== y.program || x.stmtId !== y.stmtId || x.field !== y.field) kind = "control-flow";
    else if (x.rounded && decision && decision.kind === "rounding" && decision.choice !== "HALF_UP" && x.raw && pic && isTie(x.raw, pic.scale)) kind = "rounding-tie";
    else if (x.sizeError) kind = "overflow";
    else if (x.raw && y.raw && x.raw !== y.raw) kind = "precision";
    return { kind, program: x.program, stmtId: x.stmtId, line: stmt?.line ?? 0, field: x.field, cobolValue: x.value, javaValue: y.value, raw: x.raw, javaMode: decision?.choice, pic: pic?.raw };
  }
  // Same stores so far, but one side stopped on a construct that was not converted.
  if (a.status !== b.status && (a.status === "unsupported" || b.status === "unsupported")) {
    const msg = (b.status === "unsupported" ? b.message : a.message) ?? "";
    const line = Number(/line (\d+)/.exec(msg)?.[1] ?? 0);
    return { kind: "unsupported", program: programId, stmtId: 0, line, field: msg.replace(/\s*\(line \d+\).*$/, ""), cobolValue: a.status, javaValue: b.status + (b.message ? ` (${b.message})` : "") };
  }
  if (a.stores.length !== b.stores.length) {
    const x = a.stores[n] ?? a.stores[n - 1];
    return x ? { kind: "control-flow", program: x.program, stmtId: x.stmtId, line: findStmt(system.get(x.program), x.stmtId)?.line ?? 0, field: x.field, cobolValue: x.value, javaValue: "(not executed)" } : null;
  }
  return null;
}

export function findStmt(prog: CobolProgram | undefined, id: number): Stmt | undefined {
  if (!prog) return undefined;
  let found: Stmt | undefined;
  for (const p of prog.paragraphs)
    walkStmts(p.stmts, (s) => {
      if (s.id === id) found = s;
    });
  return found;
}

// ---------------- report ----------------
export interface CaseRecord {
  id: number;
  category: CaseCategory;
  inputs: Record<string, string>;
  sql?: Record<string, string>;
  rows?: number;
  diffs: Diff[];
  cause?: Divergence;
}

export interface CauseGroup {
  kind: CauseKind;
  program: string;
  stmtId: number;
  line: number;
  field: string;
  count: number;
  javaMode?: string;
  pic?: string;
  examples: { caseId: number; raw?: string; cobol: string; java: string }[];
}

export interface Warning {
  kind: "truncation" | "loop" | "abend" | "unsupported";
  title: string;
  detail: string;
  count: number;
  program?: string;
  line?: number;
  field?: string;
  examples: string[];
}

export interface EquivalenceReport {
  programId: string;
  createdAt: string;
  durationMs: number;
  seed: number;
  total: number;
  identical: number;
  mismatches: number;
  byCategory: { category: CaseCategory; label: string; total: number; mismatches: number }[];
  groups: CauseGroup[];
  examples: CaseRecord[];
  warnings: Warning[];
  inputs: string[];
  outputs: string[];
  cursors: string[];
  selects: string[];
  javaPrograms: { id: string; className: string; rounding: string; overflow: string; decisions: number }[];
  model: { cobol: string; java: string };
}

/** A case supplied by the user (for example inputs recorded in production). */
export interface RecordedCase {
  inputs: Record<string, string>;
  /** Values returned by SELECT ... INTO, by host variable. */
  sql?: Record<string, string>;
  /** SELECT returns SQLCODE 100. */
  sqlNotFound?: boolean;
  /** Rows returned by FETCH, by cursor name, then by host variable. */
  cursors?: Record<string, Record<string, string>[]>;
}

export interface VerifyOptions extends GenerateOptions {
  maxExamples?: number;
  /** Extra cases replayed after the generated ones. */
  extraCases?: RecordedCase[];
}

export function verifyProgram(system: Map<string, CobolProgram>, javas: Map<string, JProgram>, programId: string, opts: VerifyOptions = {}): EquivalenceReport {
  const t0 = Date.now();
  const maxSteps = opts.maxSteps ?? 12000;
  const seed = opts.seed ?? hashSeed(programId);
  const plan = buildPlan(system, programId);
  const generated = generateCases(system, programId, plan, { ...opts, seed, maxSteps });
  const cases: TestCase[] = [
    ...generated,
    ...(opts.extraCases ?? []).map((c, i): TestCase => ({ id: generated.length + i + 1, category: "recorded", inputs: c.inputs ?? {}, sqlSelect: c.sql ?? {}, sqlNotFound: !!c.sqlNotFound, cursors: c.cursors ?? {} })),
  ];
  const outputs = plan.outputs;
  const byCat = new Map<CaseCategory, { total: number; mismatches: number }>();
  const groups = new Map<string, CauseGroup>();
  const examples: CaseRecord[] = [];
  const overflowAgg = new Map<string, Warning>();
  let loops = 0;
  const loopEx: string[] = [];
  let abends = 0;
  const abendEx: string[] = [];
  let mismatches = 0;
  const maxExamples = opts.maxExamples ?? 30;

  for (const tc of cases) {
    const a = new CobolMachine(system, tc, { maxSteps }).run(programId, outputs);
    const b = new JavaMachine(javas, tc, { maxSteps }).run(programId, outputs);
    const cat = byCat.get(tc.category) ?? { total: 0, mismatches: 0 };
    cat.total++;
    const diffs = compareRuns(a, b);
    // Warnings (behaviors of the legacy code, reproduced exactly)
    const seenInCase = new Set<string>();
    for (const o of a.overflows) {
      const key = `${o.program}:${o.stmtId}:${o.field}`;
      if (seenInCase.has(key)) continue;
      seenInCase.add(key);
      const prog = system.get(o.program);
      const st = findStmt(prog, o.stmtId);
      const pic = prog?.fields.get(o.field)?.pic;
      const wv = overflowAgg.get(key) ?? {
        kind: "truncation" as const,
        title: `Silent truncation of ${o.field}`,
        detail: `COBOL drops the high-order digits when the result does not fit PIC ${pic?.raw ?? "?"}, without any error. The Java reproduces this behavior: confirm it with the business owners.`,
        count: 0,
        program: o.program,
        line: st?.line,
        field: o.field,
        examples: [],
      };
      wv.count++;
      if (wv.examples.length < 3) wv.examples.push(`case #${tc.id}: exact result ${trimRaw(o.raw)}`);
      overflowAgg.set(key, wv);
    }
    if (a.status === "loop") {
      loops++;
      if (loopEx.length < 3) loopEx.push(`case #${tc.id}: ${summarizeInputs(tc)}`);
    }
    if (a.status === "abend" && b.status === "abend") {
      abends++;
      if (abendEx.length < 3) abendEx.push(`case #${tc.id}: ${a.message}`);
    }
    if (diffs.length) {
      mismatches++;
      cat.mismatches++;
      const cause = firstDivergence(system, javas, programId, tc, maxSteps) ?? undefined;
      if (cause) {
        const key = `${cause.kind}:${cause.program}:${cause.stmtId}:${cause.field}`;
        const g = groups.get(key) ?? { kind: cause.kind, program: cause.program, stmtId: cause.stmtId, line: cause.line, field: cause.field, count: 0, javaMode: cause.javaMode, pic: cause.pic, examples: [] };
        g.count++;
        if (g.examples.length < 5) g.examples.push({ caseId: tc.id, raw: cause.raw ? trimRaw(cause.raw) : undefined, cobol: cause.cobolValue, java: cause.javaValue });
        groups.set(key, g);
      }
      if (examples.length < maxExamples)
        examples.push({
          id: tc.id,
          category: tc.category,
          inputs: tc.inputs,
          sql: Object.keys(tc.sqlSelect).length ? tc.sqlSelect : undefined,
          rows: Object.values(tc.cursors).reduce((s, r) => s + r.length, 0) || undefined,
          diffs: diffs.slice(0, 6),
          cause,
        });
    }
    byCat.set(tc.category, cat);
  }

  const warnings: Warning[] = [...overflowAgg.values()];
  if (loops)
    warnings.push({
      kind: "loop",
      title: "Infinite loop in the legacy code",
      detail: `On ${loops} cases the COBOL program never stops (more than ${maxSteps.toLocaleString("en-US")} statements). The Java reproduces the same loop. Probable cause: a counter that is too short and wraps around to zero.`,
      count: loops,
      examples: loopEx,
    });
  if (abends)
    warnings.push({ kind: "abend", title: "Abnormal end on both sides", detail: "Both versions stop the same way (division by zero, subscript out of range…).", count: abends, examples: abendEx });

  const javaPrograms = reachablePrograms(system, programId)
    .map((p) => javas.get(p.id))
    .filter((j): j is JProgram => !!j)
    .map((j) => ({ id: j.id, className: j.className, rounding: j.conventions.rounding, overflow: j.conventions.overflow, decisions: j.decisions.length }));

  const order: CaseCategory[] = ["random", "sql-not-found", "zero", "negative", "max", "boundary", "half-cent", "recorded"];
  return {
    programId,
    createdAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    seed,
    total: cases.length,
    identical: cases.length - mismatches,
    mismatches,
    byCategory: order.filter((c) => byCat.has(c)).map((c) => ({ category: c, label: CATEGORY_LABEL[c], ...byCat.get(c)! })),
    groups: [...groups.values()].sort((a, b) => b.count - a.count),
    examples,
    warnings,
    inputs: plan.inputs.map((f) => f.name),
    outputs,
    cursors: plan.cursors.map((c) => c.name),
    selects: plan.selectVars.map((f) => f.name),
    javaPrograms,
    model: {
      cobol: "Mue interpreter: intermediate results truncated to 31 digits (IBM ARITH(EXTEND)), ROUNDED to nearest with ties away from zero, fields truncated according to their PIC.",
      java: "BigDecimal model: exact operations, divisions and powers in MathContext.DECIMAL128, rounding according to the RoundingMode of the generated code.",
    },
  };
}

function trimRaw(raw: string): string {
  const [i, f = ""] = raw.split(".");
  return f.length > 8 ? `${i}.${f.slice(0, 8)}…` : raw;
}

function summarizeInputs(tc: TestCase): string {
  const parts = Object.entries(tc.inputs).slice(0, 4).map(([k, v]) => `${k} = ${v}`);
  return parts.join(", ") || "(inputs from the database)";
}

export { elementaryOf };
