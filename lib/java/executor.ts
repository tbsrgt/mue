// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Execution model of the generated Java: runs the IR with java.math.BigDecimal semantics.
 *
 *  - add / subtract / multiply: exact;
 *  - divide(x, MathContext.DECIMAL128): 34 significant digits, HALF_EVEN rounding;
 *  - pow(n, MathContext.DECIMAL128): 34 digits, the exponent must be an integer;
 *  - setScale(n, RoundingMode.X) and Pic.store(...): explicit rounding mode from the IR;
 *  - strings: java.lang.String, compared with equals / compareTo (no trailing spaces).
 */
import Decimal from "decimal.js";
import type { Pic } from "../cobol/types";
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
  ROUNDING,
  rtrim,
  SqlStub,
  type RunResult,
  type StoreEvent,
  type TestCase,
} from "../verify/runtime";
import type { JCond, JExpr, JField, JProgram, JStmt, NumTarget } from "./ir";

const D34 = Decimal.clone({ precision: 34, rounding: Decimal.ROUND_HALF_EVEN });

interface Cell {
  f: JField;
  v: Dec | string;
  arr?: (Dec | string)[];
}
type Storage = Map<string, Cell>;

class FinProgramme extends Error {}
class StopRun extends Error {}

function parseInit(f: JField): Dec | string {
  if (!f.isNum) {
    try {
      return rtrim(JSON.parse(f.init) as string).slice(0, f.length);
    } catch {
      return "";
    }
  }
  if (f.init === "BigDecimal.ZERO" || f.init === "0") return new DX(0);
  if (f.init === "BigDecimal.ONE") return new DX(1);
  if (f.init === "BigDecimal.TEN") return new DX(10);
  const m = /new BigDecimal\("([^"]+)"\)/.exec(f.init);
  return new DX(m ? m[1] : 0);
}

function inputValue(f: JField, input: string): Dec | string {
  if (f.isNum && f.pic) return fitPic(new DX(input), f.pic, Decimal.ROUND_DOWN).value;
  return rtrim(input.slice(0, f.length));
}

export interface JavaRunOptions {
  maxSteps?: number;
  trace?: boolean;
}

export class JavaMachine {
  private steps = 0;
  private sql: SqlStub;
  private instances = new Map<string, Storage>();
  displays: string[] = [];
  calls: string[] = [];
  stores: StoreEvent[] = [];
  private maxSteps: number;
  private trace: boolean;

  constructor(private programs: Map<string, JProgram>, private tc: TestCase, opts: JavaRunOptions = {}) {
    this.sql = new SqlStub(tc);
    this.maxSteps = opts.maxSteps ?? 12000;
    this.trace = !!opts.trace;
  }

  run(programId: string, outputs: string[]): RunResult {
    const prog = this.programs.get(programId);
    if (!prog) throw new Error(`Java program ${programId} not found`);
    const st = this.storageFor(prog, null);
    let status: RunResult["status"] = "ok";
    let message: string | undefined;
    try {
      this.execProgram(prog, st);
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
      const c = st.get(name);
      if (c) fields[name] = this.canon(c);
    }
    return { status, message, fields, displays: this.displays, sql: this.sql.trace, calls: this.calls, stores: this.stores, overflows: [] };
  }

  private canon(c: Cell): string {
    const one = (v: Dec | string) => (typeof v === "string" ? rtrim(v) : fmtNum(v, c.f.pic?.scale ?? 0));
    return c.arr ? c.arr.map(one).join("|") : one(c.v);
  }

  private storageFor(prog: JProgram, bindings: Map<string, Cell> | null): Storage {
    let inst = this.instances.get(prog.id);
    const top = bindings === null;
    if (!inst) {
      inst = new Map();
      for (const f of prog.fields.values()) {
        if (f.section === "LINKAGE") continue;
        const input = top ? this.tc.inputs[f.cobol] : undefined;
        const v = input !== undefined ? inputValue(f, input) : parseInit(f);
        inst.set(f.cobol, f.occurs ? { f, v, arr: Array.from({ length: f.occurs }, () => v) } : { f, v });
      }
      this.instances.set(prog.id, inst);
    }
    const st: Storage = new Map(inst);
    for (const f of prog.fields.values()) {
      if (f.section !== "LINKAGE") continue;
      const b = bindings?.get(f.cobol);
      if (b) st.set(f.cobol, b);
      else {
        const input = top ? this.tc.inputs[f.cobol] : undefined;
        const v = input !== undefined ? inputValue(f, input) : parseInit(f);
        st.set(f.cobol, f.occurs ? { f, v, arr: Array.from({ length: f.occurs }, () => v) } : { f, v });
      }
    }
    return st;
  }

  private tick() {
    if (++this.steps > this.maxSteps) throw new LoopLimit(`More than ${this.maxSteps} statements executed: probable infinite loop.`);
  }

  private execProgram(prog: JProgram, st: Storage) {
    try {
      for (const m of prog.entry) this.runMethod(prog, st, m);
    } catch (e) {
      if (e instanceof FinProgramme) return;
      throw e;
    }
  }

  private runMethod(prog: JProgram, st: Storage, method: string) {
    const p = prog.paragraphs.find((x) => x.method === method);
    if (!p) throw new Abend(`Unknown method: ${method}`);
    this.execAll(prog, st, p.body);
  }

  private execAll(prog: JProgram, st: Storage, stmts: JStmt[] | undefined) {
    if (!stmts) return;
    for (const s of stmts) this.exec(prog, st, s);
  }

  private exec(prog: JProgram, st: Storage, s: JStmt) {
    this.tick();
    switch (s.k) {
      case "setNum": {
        let anySize = false;
        // All expressions are evaluated before any target is stored (COMPUTE A B = A + 1),
        // except the REMAINDER, which uses the stored quotient. The renderer emits the same order.
        const main = s.targets.filter((t) => !t.afterStore);
        const values = main.map((t) => this.evalNum(prog, st, t.e));
        main.forEach((t, i) => {
          if (this.setNum(prog, st, s.o.id, t, values[i], !!s.sizeError)) anySize = true;
        });
        for (const t of s.targets.filter((x) => x.afterStore)) if (this.setNum(prog, st, s.o.id, t, this.evalNum(prog, st, t.e), !!s.sizeError)) anySize = true;
        if (s.sizeError) {
          if (anySize) this.execAll(prog, st, s.sizeError.on);
          else this.execAll(prog, st, s.sizeError.not);
        }
        return;
      }
      case "setStr": {
        const c = this.cell(st, s.f);
        const v = this.evalStr(prog, st, s.e);
        const out = rtrim(v.slice(0, c.f.length));
        this.put(prog, st, c, s.sub, out);
        if (this.trace) this.stores.push({ program: prog.id, stmtId: s.o.id, field: s.f, value: out });
        return;
      }
      case "if":
        if (this.cond(prog, st, s.c)) this.execAll(prog, st, s.then);
        else this.execAll(prog, st, s.else);
        return;
      case "switchStr": {
        const v = rtrim(this.evalStr(prog, st, s.subject));
        for (const c of s.cases)
          if (c.values.includes(v)) {
            this.execAll(prog, st, c.body);
            return;
          }
        this.execAll(prog, st, s.other);
        return;
      }
      case "chain":
        for (const c of s.cases)
          if (this.cond(prog, st, c.c)) {
            this.execAll(prog, st, c.body);
            return;
          }
        this.execAll(prog, st, s.other);
        return;
      case "perform":
        for (const m of s.methods) this.runMethod(prog, st, m);
        return;
      case "block":
        this.execAll(prog, st, s.body);
        return;
      case "while":
        if (s.doWhile) {
          do {
            this.tick();
            this.execAll(prog, st, s.body);
          } while (this.cond(prog, st, s.c));
        } else
          while (this.cond(prog, st, s.c)) {
            this.tick();
            this.execAll(prog, st, s.body);
          }
        return;
      case "repeat": {
        const n = this.evalNum(prog, st, s.n).trunc().toNumber();
        for (let i = 0; i < n; i++) {
          this.tick();
          this.execAll(prog, st, s.body);
        }
        return;
      }
      case "varying":
        this.exec(prog, st, s.init);
        while (this.cond(prog, st, s.c)) {
          this.tick();
          this.execAll(prog, st, s.body);
          this.exec(prog, st, s.step);
        }
        return;
      case "call":
        this.call(prog, st, s);
        return;
      case "exit":
        if (s.how === "STOP RUN") throw new StopRun();
        throw new FinProgramme();
      case "print": {
        const line = s.parts
          .map((p) => {
            if (p.k === "field") {
              const c = this.cell(st, p.f);
              const v = this.read(prog, st, c, p.sub);
              return typeof v === "string" ? v.padEnd(c.f.length, " ") : displayValue(v, c.f.pic);
            }
            if (p.k === "str" || p.k === "fill") return this.evalStr(prog, st, p);
            return this.evalNum(prog, st, p).toString();
          })
          .join("");
        this.displays.push(rtrim(line));
        return;
      }
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
            if (c.f.isNum && c.f.pic) {
              const raw = alnumToNum(value);
              const { value: x, sizeError } = fitPic(raw, c.f.pic, Decimal.ROUND_DOWN);
              c.v = x;
              if (this.trace) this.stores.push({ program: prog.id, stmtId: s.o.id, field: v, value: fmtNum(x, c.f.pic.scale), raw: raw.toString(), rounded: false, sizeError });
            } else {
              c.v = rtrim(value.slice(0, c.f.length));
              if (this.trace) this.stores.push({ program: prog.id, stmtId: s.o.id, field: v, value: c.v });
            }
          },
        );
        const sc = st.get("SQLCODE");
        if (sc) {
          sc.v = new DX(code);
          if (this.trace) this.stores.push({ program: prog.id, stmtId: s.o.id, field: "SQLCODE", value: String(code), raw: String(code), rounded: false, sizeError: false });
        }
        return;
      }
      case "todo":
        if (s.blocking) throw new NotSupported(`${s.construct} (line ${s.o.line})`);
        return;
      case "noop":
        return;
    }
  }

  private call(prog: JProgram, st: Storage, s: JStmt & { k: "call" }) {
    const callee = this.programs.get(s.program);
    if (s.external || !callee) {
      const args = s.args.flatMap((a) => {
        if (a.literal) return [this.evalStr(prog, st, a.literal)];
        const g = prog.groups.find((x) => x.cobol === a.cobol);
        const fs = g ? g.fields : prog.fields.get(a.cobol) ? [prog.fields.get(a.cobol)!] : [];
        return fs.map((f) => `${f.cobol}=${st.get(f.cobol) ? this.canon(st.get(f.cobol)!) : ""}`);
      });
      this.calls.push(`CALL ${s.program} ${args.join(" ")}`);
      return;
    }
    const bindings = new Map<string, Cell>();
    s.args.forEach((a) => {
      if (!a.param) return;
      const calleeFields = callee.groups.find((g) => g.cobol === a.param)?.fields ?? (callee.fields.get(a.param) ? [callee.fields.get(a.param)!] : []);
      if (a.literal) {
        const f = calleeFields[0];
        if (f) bindings.set(f.cobol, { f, v: this.evalStr(prog, st, a.literal) });
        return;
      }
      const callerFields = prog.groups.find((g) => g.cobol === a.cobol)?.fields ?? (prog.fields.get(a.cobol) ? [prog.fields.get(a.cobol)!] : []);
      if (callerFields.length !== calleeFields.length) throw new Abend(`Call ${s.program}: ${a.cobol} and ${a.param} have different structures`);
      calleeFields.forEach((f, k) => {
        const cell = st.get(callerFields[k].cobol);
        if (!cell) return;
        bindings.set(f.cobol, a.mode === "REFERENCE" ? cell : { f, v: cell.v, arr: cell.arr ? [...cell.arr] : undefined });
      });
    });
    const cst = this.storageFor(callee, bindings);
    this.execProgram(callee, cst);
  }

  // ---------- values ----------
  private cell(st: Storage, name: string): Cell {
    const c = st.get(name);
    if (!c) throw new Abend(`Unknown field: ${name}`);
    return c;
  }

  private idx(prog: JProgram, st: Storage, c: Cell, sub?: JExpr): number {
    if (!c.arr) return -1;
    if (!sub) throw new Abend(`${c.f.cobol}: missing subscript`);
    const i = this.evalNum(prog, st, sub).toNumber();
    if (!Number.isInteger(i) || i < 1 || i > c.arr.length) throw new Abend(`ArrayIndexOutOfBoundsException: ${c.f.name}[${i - 1}]`);
    return i - 1;
  }

  private read(prog: JProgram, st: Storage, c: Cell, sub?: JExpr): Dec | string {
    return c.arr ? c.arr[this.idx(prog, st, c, sub)] : c.v;
  }

  private put(prog: JProgram, st: Storage, c: Cell, sub: JExpr | undefined, v: Dec | string) {
    if (c.arr) c.arr[this.idx(prog, st, c, sub)] = v;
    else c.v = v;
  }

  /** Numeric assignment; returns true when the value overflows the field (with a handler). */
  private setNum(prog: JProgram, st: Storage, stmtId: number, t: NumTarget, raw: Dec, hasHandler: boolean): boolean {
    const c = this.cell(st, t.f);
    let value: Dec = raw;
    let sizeError = false;
    if (t.fit && c.f.pic) {
      const pic = c.f.pic as Pic;
      if (t.fit.overflow === "reproduce" || hasHandler) {
        const r = fitPic(raw, pic, ROUNDING[t.fit.mode]);
        value = r.value;
        sizeError = r.sizeError;
      } else {
        value = raw.toDecimalPlaces(pic.scale, ROUNDING[t.fit.mode]) as Dec;
        if (!pic.signed) value = value.abs() as Dec;
      }
    }
    if (sizeError && hasHandler) {
      if (this.trace) this.stores.push({ program: prog.id, stmtId, field: t.f, value: "(unchanged)", raw: raw.toString(), rounded: t.rounded, sizeError });
      return true;
    }
    this.put(prog, st, c, t.sub, value);
    if (this.trace) this.stores.push({ program: prog.id, stmtId, field: t.f, value: fmtNum(value, c.f.pic?.scale ?? 0), raw: raw.toString(), rounded: t.rounded, sizeError });
    return false;
  }

  evalNum(prog: JProgram, st: Storage, e: JExpr): Dec {
    switch (e.k) {
      case "num":
        return new DX(e.v);
      case "field": {
        const c = this.cell(st, e.f);
        const v = this.read(prog, st, c, e.sub);
        return typeof v === "string" ? alnumToNum(v) : v;
      }
      case "op": {
        const a = this.evalNum(prog, st, e.a);
        const b = this.evalNum(prog, st, e.b);
        switch (e.op) {
          case "add":
            return a.plus(b) as Dec;
          case "sub":
            return a.minus(b) as Dec;
          case "mul":
            return a.times(b) as Dec;
          case "div":
            if (b.isZero()) throw new Abend("ArithmeticException: Division by zero");
            return new DX(new D34(a).div(b));
          case "pow": {
            if (!b.isInteger()) throw new Abend("ArithmeticException: non-integer exponent (intValueExact)");
            if (a.isZero() && b.isNeg()) throw new Abend("ArithmeticException: Division by zero");
            return new DX(new D34(a).pow(b));
          }
        }
        break;
      }
      case "neg":
        return this.evalNum(prog, st, e.e).neg() as Dec;
      case "parse":
        return alnumToNum(this.evalStr(prog, st, e.e));
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
        }
        throw new NotSupported(`Function ${e.name}`);
      }
      case "str":
      case "fill":
      case "digits":
        return alnumToNum(this.evalStr(prog, st, e));
    }
    throw new Abend("Expression invalide");
  }

  evalStr(prog: JProgram, st: Storage, e: JExpr): string {
    switch (e.k) {
      case "str":
        return e.v;
      case "fill":
        return e.ch.repeat(e.len);
      case "field": {
        const c = this.cell(st, e.f);
        const v = this.read(prog, st, c, e.sub);
        return typeof v === "string" ? v : fmtNum(v, c.f.pic?.scale ?? 0);
      }
      case "digits": {
        const v = this.evalNum(prog, st, e.e);
        return numToAlnum(v, e.pic, (e.pic?.intDigits ?? 0) + (e.pic?.scale ?? 0) || v.abs().toFixed(e.pic?.scale ?? 0).replace(".", "").length);
      }
      case "func":
        if (e.name === "ACCEPT") {
          const name = (e.args[0] as { v: string }).v;
          const from = (e.args[1] as { v: string }).v;
          return this.tc.inputs[`ACCEPT:${name}`] ?? (from.startsWith("DATE") ? "20261112" : from === "TIME" ? "02000000" : "");
        }
        return this.evalNum(prog, st, e).toString();
      default:
        return this.evalNum(prog, st, e).toString();
    }
  }

  cond(prog: JProgram, st: Storage, c: JCond): boolean {
    switch (c.k) {
      case "and":
        return this.cond(prog, st, c.a) && this.cond(prog, st, c.b);
      case "or":
        return this.cond(prog, st, c.a) || this.cond(prog, st, c.b);
      case "not":
        return !this.cond(prog, st, c.c);
      case "cmpNum":
        return rel(this.evalNum(prog, st, c.a).cmp(this.evalNum(prog, st, c.b)), c.op);
      case "cmpStr": {
        const a = rtrim(this.evalStr(prog, st, c.a));
        const b = rtrim(this.evalStr(prog, st, c.b));
        return rel(a < b ? -1 : a > b ? 1 : 0, c.op);
      }
      case "cond88": {
        const cell = this.cell(st, c.field);
        const v = cell.v;
        if (typeof v === "string") return c.values.some((x) => rtrim(x.v) === rtrim(v)) || c.ranges.some((r) => v >= r.lo && v <= r.hi);
        return c.values.some((x) => v.eq(alnumToNum(x.v))) || c.ranges.some((r) => v.gte(alnumToNum(r.lo)) && v.lte(alnumToNum(r.hi)));
      }
      case "isNumeric": {
        if (c.e.k === "field") {
          const cell = this.cell(st, c.e.f);
          const v = cell.v;
          const r = typeof v !== "string" || /^\d+$/.test(v.padEnd(cell.f.length, " "));
          return c.neg ? !r : r;
        }
        return !c.neg;
      }
    }
  }
}

function rel(k: number, op: string): boolean {
  switch (op) {
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

export function runJava(programs: Map<string, JProgram>, programId: string, tc: TestCase, outputs: string[], opts: JavaRunOptions = {}): RunResult {
  return new JavaMachine(programs, tc, opts).run(programId, outputs);
}
