// SPDX-License-Identifier: AGPL-3.0-only
/**
 * COBOL interpreter (supported subset): the reference semantics for the equivalence harness.
 *
 * Arithmetic model:
 *  - additions, subtractions and multiplications are exact;
 *  - divisions and powers: intermediate result truncated to 31 significant digits
 *    (IBM Enterprise COBOL model, ARITH(EXTEND) option);
 *  - storing into a field: truncation to the PIC scale, or rounding to nearest with ties
 *    away from zero when ROUNDED; high-order digits silently truncated without
 *    ON SIZE ERROR; the sign is lost on an unsigned PIC.
 */
import Decimal from "decimal.js";
import { elementaryOf } from "./analyze";
import type { CobolProgram, Cond, DataItem, Expr, Paragraph, Pic, Stmt } from "./types";
import {
  Abend,
  alnumToNum,
  DX,
  type Dec,
  displayValue,
  fitPic,
  fmtNum,
  LoopLimit,
  NotSupported,
  numToAlnum,
  rtrim,
  SqlStub,
  type RunResult,
  type StoreEvent,
  type TestCase,
} from "../verify/runtime";

const D31 = Decimal.clone({ precision: 31, rounding: Decimal.ROUND_DOWN });

interface Cell {
  item: DataItem;
  v: Dec | string;
  arr?: (Dec | string)[];
}

type Storage = Map<string, Cell>;

class GoBack extends Error {}
class StopRun extends Error {}
class GoTo extends Error {
  constructor(public target: string) {
    super(target);
  }
}

export interface RunOptions {
  maxSteps?: number;
  trace?: boolean;
}

function defaultValue(it: DataItem): Dec | string {
  if (it.pic?.kind === "numeric") {
    if (it.value) {
      if (it.value.kind === "num") return fitPic(new DX(it.value.value), it.pic, Decimal.ROUND_DOWN).value;
      return new DX(0);
    }
    return new DX(0);
  }
  const len = it.pic?.length ?? 1;
  if (it.value) {
    if (it.value.kind === "str") return it.value.value.padEnd(len, " ").slice(0, len);
    if (it.value.kind === "fig") return (it.value.value === "ZERO" ? "0" : it.value.value === "SPACE" ? " " : it.value.value === "HIGH-VALUE" ? "￿" : it.value.value === "LOW-VALUE" ? "\u0000" : '"').repeat(len);
    if (it.value.kind === "num") return it.value.value.padEnd(len, " ").slice(0, len);
  }
  return " ".repeat(len);
}

export function initialCellValue(it: DataItem, input?: string): Dec | string {
  if (input === undefined) return defaultValue(it);
  if (it.pic?.kind === "numeric") return fitPic(new DX(input), it.pic, Decimal.ROUND_DOWN).value;
  const len = it.pic?.length ?? 1;
  return input.padEnd(len, " ").slice(0, len);
}

export class CobolMachine {
  private steps = 0;
  private sql: SqlStub;
  private wsByProgram = new Map<string, Storage>();
  displays: string[] = [];
  calls: string[] = [];
  stores: StoreEvent[] = [];
  overflows: RunResult["overflows"] = [];
  private maxSteps: number;
  private trace: boolean;

  constructor(private system: Map<string, CobolProgram>, private tc: TestCase, opts: RunOptions = {}) {
    this.sql = new SqlStub(tc);
    this.maxSteps = opts.maxSteps ?? 12000;
    this.trace = !!opts.trace;
  }

  run(programId: string, outputs: string[]): RunResult {
    const prog = this.system.get(programId);
    if (!prog) throw new Error(`Program ${programId} not found`);
    let status: RunResult["status"] = "ok";
    let message: string | undefined;
    const storage = this.storageFor(prog, null);
    try {
      this.execProgram(prog, storage);
    } catch (e) {
      if (e instanceof StopRun) status = "ok";
      else if (e instanceof LoopLimit) {
        status = "loop";
        message = e.message;
      } else if (e instanceof Abend) {
        status = "abend";
        message = e.message;
      } else if (e instanceof NotSupported) {
        status = "unsupported";
        message = e.message;
      } else throw e;
    }
    const fields: Record<string, string> = {};
    for (const name of outputs) {
      const c = storage.get(name);
      if (!c) continue;
      fields[name] = this.canon(c);
    }
    return { status, message, fields, displays: this.displays, sql: this.sql.trace, calls: this.calls, stores: this.stores, overflows: this.overflows };
  }

  private canon(c: Cell): string {
    if (c.arr) return c.arr.map((v) => (typeof v === "string" ? rtrim(v) : fmtNum(v, c.item.pic?.scale ?? 0))).join("|");
    return typeof c.v === "string" ? rtrim(c.v) : fmtNum(c.v, c.item.pic?.scale ?? 0);
  }

  /** Builds a program's storage. `bindings` maps the LINKAGE SECTION to the caller's fields. */
  private storageFor(prog: CobolProgram, bindings: Map<string, Cell> | null): Storage {
    let ws = this.wsByProgram.get(prog.id);
    const top = bindings === null;
    if (!ws) {
      ws = new Map();
      for (const it of prog.fields.values()) {
        if (it.level === 88 || it.children.length > 0 || it.section === "LINKAGE") continue;
        const input = top ? this.tc.inputs[it.name] : undefined;
        const v = initialCellValue(it, input);
        ws.set(it.name, it.occurs ? { item: it, v, arr: Array.from({ length: it.occurs }, () => v) } : { item: it, v });
      }
      this.wsByProgram.set(prog.id, ws);
    }
    const st: Storage = new Map(ws);
    for (const it of prog.fields.values()) {
      if (it.level === 88 || it.children.length > 0 || it.section !== "LINKAGE") continue;
      const bound = bindings?.get(it.name);
      if (bound) st.set(it.name, bound);
      else {
        const v = initialCellValue(it, top ? this.tc.inputs[it.name] : undefined);
        st.set(it.name, it.occurs ? { item: it, v, arr: Array.from({ length: it.occurs }, () => v) } : { item: it, v });
      }
    }
    return st;
  }

  private tick() {
    if (++this.steps > this.maxSteps) throw new LoopLimit(`More than ${this.maxSteps} statements executed: probable infinite loop.`);
  }

  private execProgram(prog: CobolProgram, st: Storage) {
    try {
      this.runRange(prog, st, 0, prog.paragraphs.length - 1);
    } catch (e) {
      if (e instanceof GoBack) return;
      throw e;
    }
  }

  private runRange(prog: CobolProgram, st: Storage, from: number, to: number) {
    let pc = from;
    while (pc <= to && pc < prog.paragraphs.length) {
      try {
        this.execStmts(prog, st, prog.paragraphs[pc].stmts);
        pc++;
      } catch (e) {
        if (e instanceof GoTo) {
          const k = prog.paragraphs.findIndex((p) => p.name === e.target);
          if (k < 0) throw new Abend(`GO TO an unknown paragraph: ${e.target}`);
          pc = k;
          continue;
        }
        throw e;
      }
    }
  }

  private paraIndex(prog: CobolProgram, name: string): number {
    const k = prog.paragraphs.findIndex((p: Paragraph) => p.name === name);
    if (k < 0) throw new Abend(`Unknown paragraph: ${name}`);
    return k;
  }

  execStmts(prog: CobolProgram, st: Storage, stmts: Stmt[] | undefined) {
    if (!stmts) return;
    for (const s of stmts) this.exec(prog, st, s);
  }

  private exec(prog: CobolProgram, st: Storage, s: Stmt) {
    this.tick();
    switch (s.kind) {
      case "move": {
        for (const t of s.to) this.moveTo(prog, st, s, t, s.src);
        return;
      }
      case "compute": {
        let anySize = false;
        const values = s.exprs.map((e) => this.evalNum(prog, st, e));
        s.targets.forEach((t, i) => {
          const r = this.storeNum(prog, st, s, t.ref, values[i], t.rounded, !!s.onSize);
          if (r) anySize = true;
        });
        if (s.remainder) {
          const q = this.evalNum(prog, st, s.targets[0].ref);
          const rem = this.evalNum(prog, st, s.remainder.dividend).minus(q.times(this.evalNum(prog, st, s.remainder.divisor))) as Dec;
          this.storeNum(prog, st, s, s.remainder.ref, rem, false, !!s.onSize);
        }
        if (anySize && s.onSize) this.execStmts(prog, st, s.onSize);
        else if (!anySize && s.notOnSize) this.execStmts(prog, st, s.notOnSize);
        return;
      }
      case "if":
        if (this.evalCond(prog, st, s.cond)) this.execStmts(prog, st, s.then);
        else this.execStmts(prog, st, s.else);
        return;
      case "evaluate": {
        for (const w of s.whens) {
          const hit = w.objs.some((o) => {
            if (o.kind === "any") return true;
            if (o.kind === "cond") {
              const c = this.evalCond(prog, st, o.c);
              return s.subject === "FALSE" ? !c : c;
            }
            const subj = s.subject as Expr;
            let r: boolean;
            if (o.thru) r = this.compare(prog, st, subj, o.v) >= 0 && this.compare(prog, st, subj, o.thru) <= 0;
            else r = this.compare(prog, st, subj, o.v) === 0;
            return o.not ? !r : r;
          });
          if (hit) {
            this.execStmts(prog, st, w.body);
            return;
          }
        }
        this.execStmts(prog, st, s.other);
        return;
      }
      case "perform": {
        const body = () => {
          if (s.target) {
            const a = this.paraIndex(prog, s.target.from);
            const b = s.target.thru ? this.paraIndex(prog, s.target.thru) : a;
            this.runRange(prog, st, a, b);
          } else this.execStmts(prog, st, s.body);
        };
        if (s.varying) {
          const v = s.varying;
          this.storeNum(prog, st, s, v.ref, this.evalNum(prog, st, v.from), false, false);
          for (;;) {
            this.tick();
            if (!s.testAfter && this.evalCond(prog, st, s.until!)) break;
            body();
            this.storeNum(prog, st, s, v.ref, this.evalNum(prog, st, v.ref).plus(this.evalNum(prog, st, v.by)) as Dec, false, false);
            if (s.testAfter && this.evalCond(prog, st, s.until!)) break;
          }
        } else if (s.until) {
          if (s.testAfter) {
            do {
              this.tick();
              body();
            } while (!this.evalCond(prog, st, s.until));
          } else
            while (!this.evalCond(prog, st, s.until)) {
              this.tick();
              body();
            }
        } else if (s.times) {
          const n = this.evalNum(prog, st, s.times).trunc().toNumber();
          for (let i = 0; i < n; i++) {
            this.tick();
            body();
          }
        } else body();
        return;
      }
      case "call":
        this.call(prog, st, s);
        return;
      case "goto": {
        if (s.depending) {
          const k = this.evalNum(prog, st, s.depending).toNumber();
          if (k >= 1 && k <= s.targets.length) throw new GoTo(s.targets[k - 1]);
          return;
        }
        throw new GoTo(s.targets[0]);
      }
      case "stop":
        if (s.how === "STOP RUN") throw new StopRun();
        throw new GoBack();
      case "noop":
        return;
      case "display": {
        const line = s.items.map((e) => this.displayExpr(prog, st, e)).join("");
        this.displays.push(rtrim(line));
        return;
      }
      case "accept": {
        const v = this.tc.inputs[`ACCEPT:${s.ref.name}`] ?? (s.from?.startsWith("DATE") ? "20261112" : s.from === "TIME" ? "02000000" : "");
        this.moveTo(prog, st, s, s.ref, { k: "str", v });
        return;
      }
      case "initialize":
        for (const r of s.refs)
          for (const el of elementaryOf(prog, r.name)) {
            const c = st.get(el.name);
            if (!c) continue;
            const v = el.pic?.kind === "numeric" ? new DX(0) : " ".repeat(el.pic?.length ?? 1);
            if (c.arr) c.arr = c.arr.map(() => v);
            else c.v = v;
          }
        return;
      case "set":
        if (s.mode === "true") {
          for (const n of s.names) {
            const cn = prog.fields.get(n);
            const parent = cn?.parent ? prog.fields.get(cn.parent) : undefined;
            const cond = parent?.conditions.find((c) => c.name === n);
            if (!parent || !cond) throw new Abend(`SET ${n}: unknown condition name`);
            const lit = cond.values[0] ?? cond.ranges[0]?.[0];
            const src: Expr = lit.kind === "num" ? { k: "num", v: lit.value } : lit.kind === "str" ? { k: "str", v: lit.value } : { k: "fig", v: lit.value };
            this.moveTo(prog, st, s, { k: "ref", name: parent.name }, src);
          }
        } else for (const r of s.refs) this.moveTo(prog, st, s, r, s.value);
        return;
      case "sql": {
        const code = this.sql.exec(
          s.sql,
          (v) => {
            const c = st.get(v);
            return c ? this.canon(c) : "";
          },
          (v, value) => {
            const c = st.get(v);
            if (!c) return;
            if (c.item.pic?.kind === "numeric") this.storeNum(prog, st, s, { k: "ref", name: v }, alnumToNum(value), false, false);
            else this.moveTo(prog, st, s, { k: "ref", name: v }, { k: "str", v: value });
          },
        );
        if (st.has("SQLCODE")) this.storeNum(prog, st, s, { k: "ref", name: "SQLCODE" }, new DX(code), false, false);
        return;
      }
      case "unsupported":
        throw new NotSupported(`${s.verb} (line ${s.line}): ${s.reason}`);
    }
  }

  private call(prog: CobolProgram, st: Storage, s: Stmt & { kind: "call" }) {
    if (!s.program) throw new NotSupported(`Dynamic CALL (line ${s.line})`);
    const callee = this.system.get(s.program);
    if (!callee) {
      const args = s.using.flatMap((u) => (u.ref.k === "ref" ? elementaryOf(prog, u.ref.name).map((el) => `${el.name}=${st.get(el.name) ? this.canon(st.get(el.name)!) : ""}`) : [this.displayExpr(prog, st, u.ref)]));
      this.calls.push(`CALL ${s.program} ${args.join(" ")}`);
      return;
    }
    const bindings = new Map<string, Cell>();
    callee.procedureUsing.forEach((param, i) => {
      const arg = s.using[i];
      if (!arg) throw new Abend(`CALL ${s.program}: missing parameter ${param}`);
      const calleeEls = elementaryOf(callee, param);
      if (arg.ref.k !== "ref") {
        const lit = this.evalAny(prog, st, arg.ref);
        const el = calleeEls[0];
        if (el) bindings.set(el.name, { item: el, v: typeof lit === "string" ? lit.padEnd(el.pic?.length ?? 1, " ") : lit });
        return;
      }
      const callerEls = elementaryOf(prog, arg.ref.name);
      if (callerEls.length !== calleeEls.length) throw new Abend(`CALL ${s.program}: ${arg.ref.name} and ${param} have different structures`);
      calleeEls.forEach((el, k) => {
        const cell = st.get(callerEls[k].name);
        if (!cell) return;
        bindings.set(el.name, arg.mode === "REFERENCE" ? cell : { item: el, v: cell.v, arr: cell.arr ? [...cell.arr] : undefined });
      });
    });
    const calleeSt = this.storageFor(callee, bindings);
    this.execProgram(callee, calleeSt);
  }

  // ---------- values ----------
  private cellOf(st: Storage, prog: CobolProgram, name: string): Cell {
    const c = st.get(name);
    if (!c) {
      if (prog.fields.get(name)?.children.length) throw new NotSupported(`Group item ${name} used as a value`);
      throw new Abend(`Unknown data item: ${name}`);
    }
    return c;
  }

  private index(prog: CobolProgram, st: Storage, e: Expr & { k: "ref" }, c: Cell): number {
    if (!c.arr) return -1;
    if (!e.sub) throw new Abend(`${e.name}: missing subscript`);
    const i = this.evalNum(prog, st, e.sub).toNumber();
    if (i < 1 || i > c.arr.length) throw new Abend(`${e.name}(${i}): subscript out of range`);
    return i - 1;
  }

  private getRef(prog: CobolProgram, st: Storage, e: Expr & { k: "ref" }): Dec | string {
    const c = this.cellOf(st, prog, e.name);
    if (c.arr) return c.arr[this.index(prog, st, e, c)];
    return c.v;
  }

  evalAny(prog: CobolProgram, st: Storage, e: Expr): Dec | string {
    switch (e.k) {
      case "num":
        return new DX(e.v);
      case "str":
        return e.v;
      case "fig":
        return e.v === "ZERO" ? new DX(0) : e.v === "SPACE" ? " " : e.v === "QUOTE" ? '"' : e.v === "HIGH-VALUE" ? "￿" : "\u0000";
      case "ref":
        return this.getRef(prog, st, e);
      default:
        return this.evalNum(prog, st, e);
    }
  }

  evalNum(prog: CobolProgram, st: Storage, e: Expr): Dec {
    switch (e.k) {
      case "num":
        return new DX(e.v);
      case "fig":
        if (e.v === "ZERO") return new DX(0);
        throw new Abend(`Figurative constant ${e.v} in arithmetic`);
      case "str":
        return alnumToNum(e.v);
      case "ref": {
        const v = this.getRef(prog, st, e);
        return typeof v === "string" ? alnumToNum(v) : v;
      }
      case "neg":
        return this.evalNum(prog, st, e.e).neg() as Dec;
      case "bin": {
        const a = this.evalNum(prog, st, e.l);
        const b = this.evalNum(prog, st, e.r);
        switch (e.op) {
          case "+":
            return a.plus(b) as Dec;
          case "-":
            return a.minus(b) as Dec;
          case "*":
            return a.times(b) as Dec;
          case "/":
            if (b.isZero()) throw new Abend("Division by zero");
            return new DX(new D31(a).div(b));
          case "**":
            if (a.isZero() && b.isNeg()) throw new Abend("Division by zero (power)");
            return new DX(new D31(a).pow(b));
        }
      }
       
      case "func": {
        const args = e.args.map((x) => this.evalNum(prog, st, x));
        switch (e.name) {
          case "MAX":
            return DX.max(...args) as Dec;
          case "MIN":
            return DX.min(...args) as Dec;
          case "ABS":
            return args[0].abs() as Dec;
          case "MOD":
            return args[0].minus(args[1].times(args[0].div(args[1]).floor())) as Dec;
          case "REM":
            return args[0].minus(args[1].times(args[0].div(args[1]).trunc())) as Dec;
          case "INTEGER":
            return args[0].floor() as Dec;
          case "INTEGER-PART":
            return args[0].trunc() as Dec;
          default:
            throw new NotSupported(`FUNCTION ${e.name}`);
        }
      }
    }
  }

  private displayExpr(prog: CobolProgram, st: Storage, e: Expr): string {
    if (e.k === "ref") {
      const c = st.get(e.name);
      if (!c) return "";
      return displayValue(this.getRef(prog, st, e), c.item.pic);
    }
    const v = this.evalAny(prog, st, e);
    return typeof v === "string" ? v : v.toString();
  }

  /** Numeric store; returns true on overflow. */
  private storeNum(prog: CobolProgram, st: Storage, s: Stmt, ref: Expr & { k: "ref" }, raw: Dec, rounded: boolean, hasHandler: boolean): boolean {
    const c = this.cellOf(st, prog, ref.name);
    const pic = c.item.pic;
    if (!pic || pic.kind !== "numeric") {
      this.moveTo(prog, st, s, ref, { k: "num", v: raw.toString() });
      return false;
    }
    const { value, sizeError } = fitPic(raw, pic, rounded ? Decimal.ROUND_HALF_UP : Decimal.ROUND_DOWN);
    if (sizeError && hasHandler) {
      if (this.trace) this.stores.push({ program: prog.id, stmtId: s.id, field: ref.name, value: "(unchanged)", raw: raw.toString(), rounded, sizeError });
      return true;
    }
    if (sizeError) this.overflows.push({ program: prog.id, stmtId: s.id, field: ref.name, raw: raw.toString() });
    this.setCell(prog, st, ref, c, value);
    if (this.trace) this.stores.push({ program: prog.id, stmtId: s.id, field: ref.name, value: fmtNum(value, pic.scale), raw: raw.toString(), rounded, sizeError });
    return sizeError;
  }

  private setCell(prog: CobolProgram, st: Storage, ref: Expr & { k: "ref" }, c: Cell, v: Dec | string) {
    if (c.arr) c.arr[this.index(prog, st, ref, c)] = v;
    else c.v = v;
  }

  private moveTo(prog: CobolProgram, st: Storage, s: Stmt, ref: Expr & { k: "ref" }, src: Expr) {
    const target = prog.fields.get(ref.name);
    // Group-to-group MOVE: element by element when the structures match
    if (target && target.children.length > 0) {
      const tEls = elementaryOf(prog, ref.name);
      if (src.k === "ref" && prog.fields.get(src.name)?.children.length) {
        const sEls = elementaryOf(prog, src.name);
        if (sEls.length !== tEls.length) throw new NotSupported(`MOVE ${src.name} TO ${ref.name}: different structures`);
        tEls.forEach((el, k) => this.moveTo(prog, st, s, { k: "ref", name: el.name }, { k: "ref", name: sEls[k].name }));
        return;
      }
      for (const el of tEls) this.moveTo(prog, st, s, { k: "ref", name: el.name }, src);
      return;
    }
    const c = this.cellOf(st, prog, ref.name);
    const pic = c.item.pic as Pic | undefined;
    const v = this.evalAny(prog, st, src);
    if (pic?.kind === "numeric") {
      let num: Dec;
      if (typeof v === "string") {
        if (src.k === "fig") num = new DX(0);
        else num = alnumToNum(v);
      } else num = v;
      this.storeNum(prog, st, s, ref, num, false, false);
      return;
    }
    const len = pic?.length ?? 1;
    let out: string;
    if (typeof v === "string") {
      if (src.k === "fig") out = (v || " ").repeat(len).slice(0, len);
      else out = v.padEnd(len, " ").slice(0, len);
    } else {
      const srcPic = src.k === "ref" ? st.get(src.name)?.item.pic : undefined;
      if (src.k === "fig") out = "0".repeat(len);
      else out = numToAlnum(v, srcPic, len);
    }
    this.setCell(prog, st, ref, c, out);
    if (this.trace) this.stores.push({ program: prog.id, stmtId: s.id, field: ref.name, value: rtrim(out) });
  }

  // ---------- conditions ----------
  compare(prog: CobolProgram, st: Storage, l: Expr, r: Expr): number {
    const a = this.evalAny(prog, st, l);
    const b = this.evalAny(prog, st, r);
    if (typeof a !== "string" && typeof b !== "string") return a.cmp(b);
    if (typeof a === "string" && typeof b === "string") {
      let sa = a;
      let sb = b;
      if (r.k === "fig") sb = b.repeat(Math.max(1, a.length));
      if (l.k === "fig") sa = a.repeat(Math.max(1, b.length));
      const n = Math.max(sa.length, sb.length);
      sa = sa.padEnd(n, " ");
      sb = sb.padEnd(n, " ");
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    }
    // numeric versus alphanumeric: compare numerically when possible
    const na = typeof a === "string" ? alnumToNum(a) : a;
    const nb = typeof b === "string" ? (r.k === "fig" ? new DX(0) : alnumToNum(b)) : b;
    return na.cmp(nb);
  }

  evalCond(prog: CobolProgram, st: Storage, c: Cond): boolean {
    switch (c.k) {
      case "and":
        return this.evalCond(prog, st, c.a) && this.evalCond(prog, st, c.b);
      case "or":
        return this.evalCond(prog, st, c.a) || this.evalCond(prog, st, c.b);
      case "not":
        return !this.evalCond(prog, st, c.c);
      case "rel": {
        const k = this.compare(prog, st, c.l, c.r);
        switch (c.op) {
          case "=":
            return k === 0;
          case "<>":
            return k !== 0;
          case ">":
            return k > 0;
          case "<":
            return k < 0;
          case ">=":
            return k >= 0;
          case "<=":
            return k <= 0;
        }
        return false;
      }
      case "cname": {
        const cn = prog.fields.get(c.name);
        const parent = cn?.parent ? prog.fields.get(cn.parent) : undefined;
        const def = parent?.conditions.find((x) => x.name === c.name);
        if (!parent || !def) throw new Abend(`Unknown condition: ${c.name}`);
        const ref: Expr = { k: "ref", name: parent.name };
        const lit = (l: (typeof def.values)[number]): Expr => (l.kind === "num" ? { k: "num", v: l.value } : l.kind === "str" ? { k: "str", v: l.value } : { k: "fig", v: l.value });
        if (def.values.some((v) => this.compare(prog, st, ref, lit(v)) === 0)) return true;
        return def.ranges.some(([lo, hi]) => this.compare(prog, st, ref, lit(lo)) >= 0 && this.compare(prog, st, ref, lit(hi)) <= 0);
      }
      case "class": {
        const v = this.evalAny(prog, st, c.e);
        let r: boolean;
        if (c.cls === "NUMERIC") r = typeof v !== "string" || /^\d+$/.test(v);
        else r = typeof v === "string" && /^[A-Za-z ]*$/.test(v);
        return c.neg ? !r : r;
      }
      case "sign": {
        const v = this.evalNum(prog, st, c.e);
        const r = c.sign === "POSITIVE" ? v.gt(0) : c.sign === "NEGATIVE" ? v.lt(0) : v.isZero();
        return c.neg ? !r : r;
      }
    }
  }
}

export function runCobol(system: Map<string, CobolProgram>, programId: string, tc: TestCase, outputs: string[], opts: RunOptions = {}): RunResult {
  return new CobolMachine(system, tc, opts).run(programId, outputs);
}
