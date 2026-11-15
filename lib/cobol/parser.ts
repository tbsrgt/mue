// SPDX-License-Identifier: AGPL-3.0-only
/**
 * COBOL parser (supported subset): divisions, data items, PROCEDURE DIVISION.
 * Produces the AST consumed by the system analysis, the interpreter and the transpiler.
 */
import { lex, type Token } from "./lexer";
import { parsePic } from "./pic";
import type {
  CobolProgram,
  Cond,
  DataItem,
  Diagnostic,
  Expr,
  Figurative,
  Literal,
  ManualItem,
  Paragraph,
  RelOp,
  Section,
  SqlInfo,
  Stmt,
  Target,
  Usage,
  WhenObject,
} from "./types";

export interface ParseOptions {
  file: string;
  resolveCopy?: (name: string) => string | null;
}

const VERBS = new Set([
  "MOVE", "COMPUTE", "ADD", "SUBTRACT", "MULTIPLY", "DIVIDE", "IF", "EVALUATE", "PERFORM", "CALL", "GO", "GOBACK",
  "STOP", "EXIT", "CONTINUE", "DISPLAY", "ACCEPT", "INITIALIZE", "SET", "NEXT",
  // recognized but not supported
  "READ", "WRITE", "OPEN", "CLOSE", "REWRITE", "DELETE", "START", "STRING", "UNSTRING", "INSPECT", "SEARCH", "SORT",
  "MERGE", "RELEASE", "RETURN", "CANCEL", "ALTER", "ENTRY", "INVOKE", "EXHIBIT", "TRANSFORM", "UNLOCK",
]);

const UNSUPPORTED_SCOPED = new Set(["READ", "WRITE", "REWRITE", "DELETE", "START", "STRING", "UNSTRING", "SEARCH", "RETURN"]);

const UNSUPPORTED_REASON: Record<string, string> = {
  READ: "Sequential or indexed file read",
  WRITE: "File write",
  OPEN: "File open",
  CLOSE: "File close",
  REWRITE: "Record rewrite",
  DELETE: "Record delete",
  START: "Positioning in an indexed file",
  STRING: "String concatenation",
  UNSTRING: "String splitting",
  INSPECT: "String inspection",
  SEARCH: "Table search",
  SORT: "Internal sort",
  MERGE: "File merge",
  RELEASE: "Internal sort",
  RETURN: "Internal sort",
  CANCEL: "Program unload",
  ALTER: "Dynamic GO TO modification",
  ENTRY: "Secondary entry point",
  INVOKE: "Object method call",
  EXHIBIT: "Obsolete statement",
  TRANSFORM: "Obsolete statement",
  UNLOCK: "File locking",
};

const TERMINATORS = new Set(["ELSE", "WHEN", "END-IF", "END-EVALUATE", "END-PERFORM", "END-COMPUTE", "END-ADD", "END-SUBTRACT", "END-MULTIPLY", "END-DIVIDE", "END-CALL", "END-READ", "END-WRITE", "END-STRING", "END-UNSTRING", "END-SEARCH", "END-RETURN", "END-START", "END-DELETE", "END-REWRITE", "END-EXEC"]);

const KEYWORDS = new Set([
  "TO", "FROM", "BY", "GIVING", "ROUNDED", "INTO", "REMAINDER", "ON", "NOT", "SIZE", "ERROR", "THEN", "USING", "UNTIL",
  "VARYING", "TIMES", "THRU", "THROUGH", "AFTER", "BEFORE", "TEST", "WITH", "ALSO", "OTHER", "AND", "OR", "IS", "EQUAL",
  "GREATER", "LESS", "THAN", "UPON", "NO", "ADVANCING", "DEPENDING", "OF", "IN", "EXCEPTION", "OVERFLOW", "AT", "END",
  "REFERENCE", "CONTENT", "VALUE", "TRUE", "FALSE", "CORR", "CORRESPONDING", "ALL", "SECTION", "DIVISION", "INVALID", "KEY",
]);

const FIGURATIVES: Record<string, Figurative> = {
  ZERO: "ZERO", ZEROS: "ZERO", ZEROES: "ZERO", SPACE: "SPACE", SPACES: "SPACE", "HIGH-VALUE": "HIGH-VALUE",
  "HIGH-VALUES": "HIGH-VALUE", "LOW-VALUE": "LOW-VALUE", "LOW-VALUES": "LOW-VALUE", QUOTE: "QUOTE", QUOTES: "QUOTE",
};

class ParseError extends Error {}

type RefExpr = Expr & { k: "ref" };

export function parseProgram(source: string, opts: ParseOptions): CobolProgram {
  const lx = lex(source, { file: opts.file, resolveCopy: opts.resolveCopy });
  const p = new Parser(lx.tokens, opts.file);
  for (const d of lx.diagnostics) p.diagnostics.push({ line: d.line, severity: "warn", message: d.message, file: d.file === opts.file ? undefined : d.file });
  const prog = p.parseAll();

  // Title and header comments: comments before the DATA/PROCEDURE DIVISION.
  const firstCodeLine = p.firstProcedureLine ?? Infinity;
  const header = lx.comments
    .filter((c) => c.line < firstCodeLine && c.text && !/^[-*=\s.]+$/.test(c.text))
    .map((c) => c.text);
  const decimalComma = /DECIMAL-POINT\s+IS\s+COMMA/i.test(source);

  const result: CobolProgram = {
    id: prog.id ?? opts.file.replace(/\.[^.]+$/, "").toUpperCase(),
    file: opts.file,
    title: header.find((h) => h.length > 6 && !/^(AUTEUR|AUTHOR|DATE|MODIF|CHANGE|VERSION|PROGRAMME?\s*:)/i.test(h)),
    author: prog.author,
    dateWritten: prog.dateWritten,
    headerComments: header.slice(0, 12),
    decimalComma,
    items: p.items,
    fields: p.fields,
    procedureUsing: p.using,
    paragraphs: p.paragraphs,
    copies: lx.copies.map((c) => ({ name: c.name, line: c.line, resolved: c.resolved })),
    files: p.fileDecls,
    diagnostics: p.diagnostics,
    manual: p.manual,
    lines: lx.stats,
    source,
    stmtCount: p.stmtId,
    sqlDeclarations: p.sqlDecls,
  };
  // Implicit SQLCODE (SQLCA) as soon as there is SQL
  if (/EXEC\s+SQL/i.test(source) && !result.fields.has("SQLCODE")) {
    const sqlcode: DataItem = { level: 1, name: "SQLCODE", pic: parsePic("S9(9)"), usage: "COMP", children: [], conditions: [], section: "WORKING-STORAGE", line: 0, copybook: "SQLCA" };
    result.items.push(sqlcode);
    result.fields.set("SQLCODE", sqlcode);
  }
  return result;
}

class Parser {
  pos = 0;
  stmtId = 0;
  diagnostics: Diagnostic[] = [];
  manual: ManualItem[] = [];
  items: DataItem[] = [];
  fields = new Map<string, DataItem>();
  paragraphs: Paragraph[] = [];
  using: string[] = [];
  fileDecls: { name: string; line: number }[] = [];
  firstProcedureLine?: number;
  sqlDecls: SqlInfo[] = [];
  private lastRel: { l: Expr; op: RelOp } | null = null;

  constructor(private toks: Token[], private file: string) {}

  // ---------- utilitaires ----------
  get tok(): Token {
    return this.toks[this.pos];
  }
  peek(n = 1): Token {
    return this.toks[Math.min(this.pos + n, this.toks.length - 1)];
  }
  next(): Token {
    const t = this.toks[this.pos];
    if (this.pos < this.toks.length - 1) this.pos++;
    return t;
  }
  isWord(v?: string, t: Token = this.tok): boolean {
    return t.t === "word" && (v === undefined || t.v === v);
  }
  isOp(v: string, t: Token = this.tok): boolean {
    return t.t === "op" && t.v === v;
  }
  accept(v: string): boolean {
    if (this.isWord(v)) {
      this.next();
      return true;
    }
    return false;
  }
  expectWord(v: string) {
    if (!this.accept(v)) throw new ParseError(`Expected "${v}", found "${this.tok.raw || "end of input"}"`);
  }
  get eof() {
    return this.tok.t === "eof";
  }
  fileOf(t: Token) {
    return t.file && t.file !== this.file ? t.file : undefined;
  }
  diag(t: Token, message: string, severity: Diagnostic["severity"] = "warn") {
    this.diagnostics.push({ line: t.line, severity, message, file: this.fileOf(t) });
  }
  addManual(t: Token, construct: string, detail: string) {
    this.manual.push({ line: t.line, construct, detail, file: this.fileOf(t) });
  }
  skipToPeriod() {
    while (!this.eof && this.tok.t !== "period") this.next();
    if (this.tok.t === "period") this.next();
  }
  isDivision(name: string) {
    return this.isWord(name) && this.isWord("DIVISION", this.peek());
  }

  // ---------- program ----------
  parseAll() {
    const info: { id?: string; author?: string; dateWritten?: string } = {};
    // IDENTIFICATION DIVISION
    while (!this.eof && !this.isDivision("IDENTIFICATION") && !this.isDivision("ID") && !this.isWord("PROGRAM-ID")) this.next();
    if (this.isDivision("IDENTIFICATION") || this.isDivision("ID")) {
      this.next();
      this.next();
      if (this.tok.t === "period") this.next();
    }
    while (!this.eof && !this.isDivision("ENVIRONMENT") && !this.isDivision("DATA") && !this.isDivision("PROCEDURE")) {
      if (this.isWord("PROGRAM-ID")) {
        this.next();
        if (this.tok.t === "period") this.next();
        const t = this.next();
        info.id = (t.t === "str" ? t.v : t.v).toUpperCase();
        while (!this.eof && this.tok.t !== "period") this.next();
        if (this.tok.t === "period") this.next();
        continue;
      }
      if (this.isWord("AUTHOR") || this.isWord("DATE-WRITTEN") || this.isWord("INSTALLATION") || this.isWord("DATE-COMPILED") || this.isWord("SECURITY") || this.isWord("REMARKS")) {
        const key = this.next().v;
        if (this.tok.t === "period") this.next();
        const words: string[] = [];
        const startLine = this.tok.line;
        while (!this.eof && this.tok.line === startLine && !(this.tok.t === "period" && this.peek().line !== startLine)) {
          const t = this.next();
          if (t.t !== "period") words.push(t.raw);
        }
        if (this.tok.t === "period") this.next();
        const text = words.join(" ").replace(/\s*([/.:,-])\s*/g, "$1").trim();
        if (key === "AUTHOR") info.author = text;
        if (key === "DATE-WRITTEN") info.dateWritten = text;
        continue;
      }
      this.next();
    }
    // ENVIRONMENT DIVISION
    if (this.isDivision("ENVIRONMENT")) {
      while (!this.eof && !this.isDivision("DATA") && !this.isDivision("PROCEDURE")) {
        if (this.isWord("SELECT")) {
          const t = this.next();
          let name = this.next();
          if (name.v === "OPTIONAL") name = this.next();
          this.fileDecls.push({ name: name.v, line: t.line });
          this.addManual(t, "File I/O", `File ${name.v} (SELECT/ASSIGN): file I/O must be migrated by hand.`);
          this.skipToPeriod();
          continue;
        }
        this.next();
      }
    }
    // DATA DIVISION
    if (this.isDivision("DATA")) {
      this.next();
      this.next();
      if (this.tok.t === "period") this.next();
      this.parseData();
    }
    // PROCEDURE DIVISION
    if (this.isDivision("PROCEDURE")) {
      this.firstProcedureLine = this.tok.line;
      this.next();
      this.next();
      if (this.accept("USING")) {
        while (!this.eof && this.tok.t !== "period") {
          const t = this.next();
          if (t.t === "word" && !["BY", "REFERENCE", "VALUE", "CONTENT"].includes(t.v)) this.using.push(t.v);
        }
      }
      while (!this.eof && this.tok.t !== "period") this.next();
      if (this.tok.t === "period") this.next();
      this.parseProcedure();
    } else {
      this.diag(this.tok, "PROCEDURE DIVISION introuvable.", "error");
    }
    return info;
  }

  // ---------- DATA DIVISION ----------
  parseData() {
    let section: Section = "WORKING-STORAGE";
    const stack: DataItem[] = [];
    let lastItem: DataItem | null = null;

    while (!this.eof && !this.isDivision("PROCEDURE")) {
      const t = this.tok;
      if (t.t === "word" && this.isWord("SECTION", this.peek())) {
        const name = t.v;
        section = name === "LINKAGE" ? "LINKAGE" : name === "LOCAL-STORAGE" ? "LOCAL-STORAGE" : name === "FILE" ? "FILE" : "WORKING-STORAGE";
        this.next();
        this.next();
        if (this.tok.t === "period") this.next();
        stack.length = 0;
        continue;
      }
      if (this.isWord("FD") || this.isWord("SD")) {
        this.next();
        this.skipToPeriod();
        stack.length = 0;
        continue;
      }
      if (t.t === "sql") {
        this.next();
        if (t.exec && t.exec !== "SQL") {
          this.addManual(t, `EXEC ${t.exec}`, `EXEC ${t.exec} in the DATA DIVISION is not supported.`);
          if (this.tok.t === "period") this.next();
          continue;
        }
        this.sqlDecls.push(parseSql(t.v));
        if (this.tok.t === "period") this.next();
        continue;
      }
      if (t.t !== "num") {
        this.diag(t, `Unexpected data entry "${t.raw}".`);
        this.skipToPeriod();
        continue;
      }
      const level = Number(this.next().v);
      let name = "FILLER";
      if (this.tok.t === "word" && !this.isDataClause(this.tok.v)) name = this.next().v;
      const item: DataItem = { level, name, usage: "DISPLAY", children: [], conditions: [], section, line: t.line, copybook: this.fileOf(t), comment: t.comment };

      if (level === 88) {
        const cond = { name, values: [] as Literal[], ranges: [] as [Literal, Literal][], line: t.line };
        if (this.accept("VALUE") || this.accept("VALUES")) {
          this.accept("IS");
          this.accept("ARE");
          while (!this.eof && this.tok.t !== "period") {
            const lit = this.parseLiteral();
            if (!lit) {
              this.next();
              continue;
            }
            if (this.accept("THRU") || this.accept("THROUGH")) {
              const hi = this.parseLiteral();
              if (hi) cond.ranges.push([lit, hi]);
            } else cond.values.push(lit);
          }
        }
        this.skipToPeriod();
        if (lastItem) lastItem.conditions.push(cond);
        else this.diag(t, `Level 88 ${name} has no parent data item.`);
        this.fields.set(name, { ...item, level: 88, parent: lastItem?.name });
        continue;
      }
      if (level === 66) {
        this.addManual(t, "RENAMES", `Level 66 ${name} (RENAMES) must be migrated by hand.`);
        this.skipToPeriod();
        continue;
      }

      // Clauses
      while (!this.eof && this.tok.t !== "period") {
        const c = this.tok;
        if (this.isWord("PIC") || this.isWord("PICTURE")) {
          this.next();
          if (this.tok.t === "pic") item.pic = parsePic(this.next().v);
          continue;
        }
        if (this.accept("USAGE")) {
          this.accept("IS");
          continue;
        }
        const usage = this.usageOf(c.v);
        if (c.t === "word" && usage) {
          item.usage = usage;
          this.next();
          continue;
        }
        if (this.isWord("VALUE") || this.isWord("VALUES")) {
          this.next();
          this.accept("IS");
          const lit = this.parseLiteral();
          if (lit) item.value = lit;
          continue;
        }
        if (this.accept("OCCURS")) {
          const n = this.next();
          item.occurs = Number(n.v) || 1;
          if (this.isWord("TO")) {
            this.next();
            item.occurs = Number(this.next().v) || item.occurs;
          }
          this.accept("TIMES");
          if (this.accept("DEPENDING")) {
            this.accept("ON");
            this.next();
          }
          while (this.isWord("INDEXED") || this.isWord("ASCENDING") || this.isWord("DESCENDING")) {
            this.next();
            this.accept("BY");
            this.accept("KEY");
            this.accept("IS");
            while (this.tok.t === "word" && !this.isDataClause(this.tok.v)) this.next();
          }
          continue;
        }
        if (this.accept("REDEFINES")) {
          item.redefines = this.next().v;
          this.addManual(c, "REDEFINES", `${name} redefines ${item.redefines}: the shared storage must be reviewed by hand.`);
          continue;
        }
        if (this.accept("SIGN")) {
          this.accept("IS");
          this.accept("LEADING");
          this.accept("TRAILING");
          this.accept("SEPARATE");
          this.accept("CHARACTER");
          continue;
        }
        if (["JUSTIFIED", "JUST", "RIGHT", "BLANK", "WHEN", "ZERO", "SYNC", "SYNCHRONIZED", "LEFT", "GLOBAL", "EXTERNAL"].includes(c.v)) {
          this.next();
          continue;
        }
        this.diag(c, `Unrecognized data clause "${c.raw}".`, "info");
        this.next();
      }
      if (this.tok.t === "period") this.next();

      if (item.pic?.kind === "edited") this.addManual(t, "Edited PIC", `${name} PIC ${item.pic.raw}: display format, handled as text.`);
      if (item.pic?.kind === "numeric" && /P/i.test(item.pic.raw)) this.addManual(t, "PIC P scaling", `${name} PIC ${item.pic.raw}: the scaling positions (P) are not modeled.`);

      // Hierarchy
      if (level === 77 || level === 1) {
        stack.length = 0;
        this.items.push(item);
        stack.push(item);
      } else {
        while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
        const parent = stack[stack.length - 1];
        if (parent) {
          item.parent = parent.name;
          parent.children.push(item);
        } else this.items.push(item);
        stack.push(item);
      }
      if (item.occurs && !item.pic) this.addManual(t, "OCCURS on a group", `${name}: table of groups, must be migrated by hand.`);
      if (name !== "FILLER") {
        if (this.fields.has(name)) this.diag(t, `Duplicate data name: ${name} (the first declaration is used).`, "info");
        else this.fields.set(name, item);
      }
      lastItem = item;
    }
    // Groups: OCCURS inheritance is not supported, but the section is propagated
  }

  isDataClause(v: string) {
    return ["PIC", "PICTURE", "VALUE", "VALUES", "USAGE", "OCCURS", "REDEFINES", "SIGN", "JUSTIFIED", "JUST", "BLANK", "SYNC", "SYNCHRONIZED", "GLOBAL", "EXTERNAL"].includes(v) || !!this.usageOf(v);
  }

  usageOf(v: string): Usage | null {
    switch (v) {
      case "COMP":
      case "COMPUTATIONAL":
      case "COMP-4":
      case "COMPUTATIONAL-4":
        return "COMP";
      case "COMP-3":
      case "COMPUTATIONAL-3":
        return "COMP-3";
      case "PACKED-DECIMAL":
        return "PACKED-DECIMAL";
      case "BINARY":
        return "BINARY";
      case "COMP-5":
      case "COMPUTATIONAL-5":
        return "COMP-5";
      case "COMP-1":
        return "COMP-1";
      case "COMP-2":
        return "COMP-2";
      case "DISPLAY":
        return "DISPLAY";
      default:
        return null;
    }
  }

  parseLiteral(): Literal | null {
    const t = this.tok;
    if (t.t === "str") {
      this.next();
      return { kind: "str", value: t.v };
    }
    if (t.t === "num") {
      this.next();
      return { kind: "num", value: t.v };
    }
    if (t.t === "op" && (t.v === "-" || t.v === "+") && this.peek().t === "num") {
      this.next();
      const n = this.next();
      return { kind: "num", value: (t.v === "-" ? "-" : "") + n.v };
    }
    if (t.t === "word" && FIGURATIVES[t.v]) {
      this.next();
      return { kind: "fig", value: FIGURATIVES[t.v] };
    }
    if (t.t === "word" && t.v === "ALL" && this.peek().t === "str") {
      this.next();
      return { kind: "str", value: this.next().v };
    }
    return null;
  }

  // ---------- PROCEDURE DIVISION ----------
  parseProcedure() {
    let current: Paragraph | null = null;
    let section: string | undefined;
    const close = (endLine: number) => {
      if (current) current.endLine = Math.max(current.line, endLine);
    };
    let lastLine = this.tok.line;

    while (!this.eof) {
      const t = this.tok;
      if (this.isWord("DECLARATIVES")) {
        this.addManual(t, "DECLARATIVES", "DECLARATIVES section ignored.");
        while (!this.eof && !(this.isWord("END") && this.isWord("DECLARATIVES", this.peek()))) this.next();
        this.next();
        this.next();
        if (this.tok.t === "period") this.next();
        continue;
      }
      // Section or paragraph header
      if (t.t === "word" && !VERBS.has(t.v) && !TERMINATORS.has(t.v)) {
        if (this.isWord("SECTION", this.peek()) && this.peek(2).t === "period") {
          close(lastLine);
          section = t.v;
          current = { name: t.v, section, line: t.line, endLine: t.line, stmts: [], isSection: true, comment: t.comment };
          this.paragraphs.push(current);
          this.pos += 3;
          continue;
        }
        if (this.peek().t === "period") {
          close(lastLine);
          current = { name: t.v, section, line: t.line, endLine: t.line, stmts: [], comment: t.comment };
          this.paragraphs.push(current);
          this.pos += 2;
          continue;
        }
      }
      if (t.t === "period") {
        this.next();
        continue;
      }
      if (!current) {
        current = { name: "(DEBUT)", line: t.line, endLine: t.line, stmts: [] };
        this.paragraphs.push(current);
      }
      const before = this.pos;
      try {
        const stmts = this.parseBlock();
        current.stmts.push(...stmts);
      } catch (e) {
        if (e instanceof ParseError) {
          this.diag(this.tok, e.message, "error");
          this.skipToPeriod();
        } else throw e;
      }
      lastLine = this.toks[Math.max(0, this.pos - 1)].line;
      if (this.tok.t === "period") {
        lastLine = this.tok.line;
        this.next();
      } else if (this.tok.t === "word" && TERMINATORS.has(this.tok.v)) {
        this.diag(this.tok, `Unexpected "${this.tok.raw}".`);
        this.next();
      } else if (this.pos === before) {
        this.diag(this.tok, `Unrecognized statement "${this.tok.raw}".`);
        this.next();
      }
    }
    close(lastLine);
  }

  /** Statement block up to the period, a scope terminator or a conditional clause. */
  parseBlock(): Stmt[] {
    const out: Stmt[] = [];
    while (!this.eof && this.tok.t !== "period") {
      const t = this.tok;
      if (t.t === "word" && TERMINATORS.has(t.v)) break;
      if (this.isPhraseStart()) break;
      if (t.t === "sql") {
        out.push(this.parseSql());
        continue;
      }
      if (t.t !== "word" || !VERBS.has(t.v)) {
        // Probably a paragraph name without a preceding period, or an unknown word
        if (t.t === "word" && this.peek().t === "period") break;
        this.diag(t, `Unrecognized statement "${t.raw}".`);
        this.next();
        continue;
      }
      out.push(this.parseStatement());
    }
    return out;
  }

  isPhraseStart(): boolean {
    const t = this.tok;
    if (t.t !== "word") return false;
    const n = this.peek();
    const n2 = this.peek(2);
    if (t.v === "ON" && ["SIZE", "EXCEPTION", "OVERFLOW"].includes(n.v)) return true;
    if (t.v === "SIZE" && n.v === "ERROR") return true;
    if (t.v === "EXCEPTION" || t.v === "OVERFLOW") return true;
    if (t.v === "AT" && n.v === "END") return true;
    if (t.v === "INVALID") return true;
    if (t.v === "NOT" && (["SIZE", "EXCEPTION", "OVERFLOW", "INVALID"].includes(n.v) || (n.v === "ON" && ["SIZE", "EXCEPTION", "OVERFLOW"].includes(n2.v)) || (n.v === "AT" && n2.v === "END"))) return true;
    return false;
  }

  newStmt<T extends Record<string, unknown>>(start: Token, body: T): Stmt {
    const end = this.toks[Math.max(0, this.pos - 1)];
    return { id: ++this.stmtId, line: start.line, endLine: Math.max(start.line, end.file === start.file ? end.line : start.line), file: this.fileOf(start), comment: start.comment, ...body } as unknown as Stmt;
  }

  parseStatement(): Stmt {
    const start = this.tok;
    const verb = this.next().v;
    switch (verb) {
      case "MOVE":
        return this.parseMove(start);
      case "COMPUTE":
        return this.parseCompute(start);
      case "ADD":
      case "SUBTRACT":
      case "MULTIPLY":
      case "DIVIDE":
        return this.parseArith(start, verb);
      case "IF":
        return this.parseIf(start);
      case "EVALUATE":
        return this.parseEvaluate(start);
      case "PERFORM":
        return this.parsePerform(start);
      case "CALL":
        return this.parseCall(start);
      case "GO": {
        this.accept("TO");
        const targets: string[] = [];
        while (this.tok.t === "word" && !VERBS.has(this.tok.v) && !KEYWORDS.has(this.tok.v) && !TERMINATORS.has(this.tok.v)) targets.push(this.next().v);
        let depending: Expr | undefined;
        if (this.accept("DEPENDING")) {
          this.accept("ON");
          depending = this.parseOperand();
        }
        this.addManual(start, "GO TO", `GO TO ${targets.join(", ")}: unstructured jump, must be restructured by hand.`);
        return this.newStmt(start, { kind: "goto", targets, depending });
      }
      case "GOBACK":
        return this.newStmt(start, { kind: "stop", how: "GOBACK" });
      case "STOP":
        if (this.accept("RUN")) return this.newStmt(start, { kind: "stop", how: "STOP RUN" });
        this.parseOperand();
        this.addManual(start, "STOP literal", "STOP with a literal (operator pause) is not supported.");
        return this.newStmt(start, { kind: "unsupported", verb: "STOP", text: "STOP literal", reason: "Operator pause" });
      case "EXIT":
        if (this.accept("PROGRAM")) return this.newStmt(start, { kind: "stop", how: "EXIT PROGRAM" });
        if (this.isWord("PARAGRAPH") || this.isWord("SECTION") || this.isWord("PERFORM")) {
          const w = this.next().v;
          this.accept("CYCLE");
          this.addManual(start, `EXIT ${w}`, `EXIT ${w}: early exit, must be migrated by hand.`);
          return this.newStmt(start, { kind: "unsupported", verb: "EXIT", text: `EXIT ${w}`, reason: "Early exit" });
        }
        return this.newStmt(start, { kind: "noop", how: "EXIT" });
      case "CONTINUE":
        return this.newStmt(start, { kind: "noop", how: "CONTINUE" });
      case "NEXT":
        this.accept("SENTENCE");
        this.addManual(start, "NEXT SENTENCE", "NEXT SENTENCE: jump to the next sentence, must be restructured by hand.");
        return this.newStmt(start, { kind: "unsupported", verb: "NEXT SENTENCE", text: "NEXT SENTENCE", reason: "Implicit jump" });
      case "DISPLAY": {
        const items: Expr[] = [];
        while (!this.eof && this.tok.t !== "period" && !this.atStatementBoundary()) {
          if (this.accept("UPON")) {
            this.next();
            continue;
          }
          if (this.isWord("WITH") || this.isWord("NO")) {
            this.accept("WITH");
            this.accept("NO");
            this.accept("ADVANCING");
            continue;
          }
          items.push(this.parseOperand());
        }
        return this.newStmt(start, { kind: "display", items });
      }
      case "ACCEPT": {
        const ref = this.parseRef();
        let from: string | undefined;
        if (this.accept("FROM")) {
          from = this.next().v;
          if (this.isWord("YYYYMMDD") || this.isWord("YYYYDDD")) from += " " + this.next().v;
        }
        return this.newStmt(start, { kind: "accept", ref, from });
      }
      case "INITIALIZE": {
        const refs: RefExpr[] = [];
        while (this.isRefStart()) refs.push(this.parseRef());
        if (this.isWord("REPLACING")) {
          this.addManual(start, "INITIALIZE REPLACING", "INITIALIZE … REPLACING is not supported.");
          while (!this.eof && this.tok.t !== "period" && !this.atStatementBoundary()) this.next();
        }
        return this.newStmt(start, { kind: "initialize", refs });
      }
      case "SET": {
        const names: string[] = [];
        while (this.tok.t === "word" && !KEYWORDS.has(this.tok.v)) names.push(this.next().v);
        if (this.accept("TO")) {
          if (this.accept("TRUE")) {
            return this.newStmt(start, { kind: "set", mode: "true", names });
          }
          const value = this.parseOperand();
          return this.newStmt(start, { kind: "set", mode: "value", refs: names.map((n) => ({ k: "ref" as const, name: n })), value });
        }
        if (this.isWord("UP") || this.isWord("DOWN")) {
          const dir = this.next().v;
          this.accept("BY");
          const v = this.parseOperand();
          const exprs = names.map((n) => ({ k: "bin" as const, op: dir === "UP" ? ("+" as const) : ("-" as const), l: { k: "ref" as const, name: n }, r: v }));
          return this.newStmt(start, { kind: "compute", verb: "ADD", targets: names.map((n) => ({ ref: { k: "ref" as const, name: n }, rounded: false })), exprs });
        }
        this.addManual(start, "SET", "Unsupported form of SET.");
        return this.newStmt(start, { kind: "unsupported", verb: "SET", text: "SET", reason: "Unsupported form" });
      }
      default:
        return this.parseUnsupported(start, verb);
    }
  }

  parseUnsupported(start: Token, verb: string): Stmt {
    const texts: string[] = [verb];
    const endWord = "END-" + verb;
    // Look for an END-verb before the next period
    let j = this.pos;
    let hasEnd = false;
    let hasPhrase = false;
    while (j < this.toks.length && this.toks[j].t !== "period" && this.toks[j].t !== "eof") {
      if (this.toks[j].v === endWord) {
        hasEnd = true;
        break;
      }
      if (["AT", "INVALID", "ON", "WHEN"].includes(this.toks[j].v)) hasPhrase = true;
      j++;
    }
    if (hasEnd || (UNSUPPORTED_SCOPED.has(verb) && hasPhrase)) {
      while (!this.eof && this.tok.t !== "period" && this.tok.v !== endWord) texts.push(this.next().raw);
      if (this.tok.v === endWord) this.next();
    } else {
      while (!this.eof && this.tok.t !== "period" && !this.atStatementBoundary()) texts.push(this.next().raw);
    }
    const text = texts.join(" ").slice(0, 120);
    this.addManual(start, verb, `${UNSUPPORTED_REASON[verb] ?? "Unsupported statement"}: ${text}`);
    return this.newStmt(start, { kind: "unsupported", verb, text, reason: UNSUPPORTED_REASON[verb] ?? "Unsupported statement" });
  }

  atStatementBoundary(): boolean {
    const t = this.tok;
    if (t.t === "sql") return true;
    if (t.t !== "word") return false;
    return VERBS.has(t.v) || TERMINATORS.has(t.v) || this.isPhraseStart();
  }

  isRefStart(): boolean {
    const t = this.tok;
    return t.t === "word" && !VERBS.has(t.v) && !KEYWORDS.has(t.v) && !TERMINATORS.has(t.v) && !FIGURATIVES[t.v];
  }

  parseRef(): RefExpr {
    const t = this.tok;
    if (t.t !== "word") throw new ParseError(`Expected a data name, found "${t.raw || "end of input"}"`);
    this.next();
    const ref: RefExpr = { k: "ref", name: t.v };
    while (this.isWord("OF") || this.isWord("IN")) {
      this.next();
      this.next();
    }
    if (this.isOp("(")) {
      // subscript (OCCURS) or reference modification (a:b)
      let depth = 0;
      let hasColon = false;
      let j = this.pos;
      for (; j < this.toks.length; j++) {
        const x = this.toks[j];
        if (x.t === "op" && x.v === "(") depth++;
        if (x.t === "op" && x.v === ")") {
          depth--;
          if (depth === 0) break;
        }
        if (x.t === "op" && x.v === ":" && depth === 1) hasColon = true;
      }
      const item = this.fields.get(t.v);
      if (hasColon) {
        this.addManual(t, "Reference modification", `${t.v}(start:length): substring, must be migrated by hand.`);
        this.pos = j + 1;
      } else if (item?.occurs || this.parentOccurs(t.v)) {
        this.next();
        ref.sub = this.parseExpr();
        if (this.isOp(")")) this.next();
      }
    }
    return ref;
  }

  parentOccurs(name: string): boolean {
    let it = this.fields.get(name);
    while (it?.parent) {
      it = this.fields.get(it.parent);
      if (it?.occurs) return true;
    }
    return false;
  }

  /** Simple operand: literal, figurative constant or reference. */
  parseOperand(): Expr {
    const t = this.tok;
    if (t.t === "num") {
      this.next();
      return { k: "num", v: t.v };
    }
    if (t.t === "str") {
      this.next();
      return { k: "str", v: t.v };
    }
    if (t.t === "op" && (t.v === "-" || t.v === "+") && this.peek().t === "num") {
      this.next();
      const n = this.next();
      return { k: "num", v: (t.v === "-" ? "-" : "") + n.v };
    }
    if (t.t === "word" && FIGURATIVES[t.v]) {
      this.next();
      return { k: "fig", v: FIGURATIVES[t.v] };
    }
    if (t.t === "word" && t.v === "ALL" && this.peek().t === "str") {
      this.next();
      return { k: "str", v: this.next().v };
    }
    if (t.t === "word" && t.v === "FUNCTION") return this.parseFunction();
    return this.parseRef();
  }

  parseFunction(): Expr {
    const start = this.next();
    const name = this.next().v;
    const args: Expr[] = [];
    if (this.isOp("(")) {
      this.next();
      while (!this.eof && !this.isOp(")")) args.push(this.parseExpr());
      if (this.isOp(")")) this.next();
    }
    const supported = ["MAX", "MIN", "ABS", "MOD", "REM", "INTEGER", "INTEGER-PART"];
    if (!supported.includes(name)) this.addManual(start, "FUNCTION", `FUNCTION ${name} is not supported.`);
    return { k: "func", name, args };
  }

  // ---------- expressions ----------
  parseExpr(): Expr {
    let l = this.parseTerm();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.next().v as "+" | "-";
      const r = this.parseTerm();
      l = { k: "bin", op, l, r };
    }
    return l;
  }
  parseTerm(): Expr {
    let l = this.parsePower();
    while (this.isOp("*") || this.isOp("/")) {
      const op = this.next().v as "*" | "/";
      const r = this.parsePower();
      l = { k: "bin", op, l, r };
    }
    return l;
  }
  parsePower(): Expr {
    const base = this.parseUnary();
    if (this.isOp("**")) {
      this.next();
      const exp = this.parsePower();
      return { k: "bin", op: "**", l: base, r: exp };
    }
    return base;
  }
  parseUnary(): Expr {
    if (this.isOp("-")) {
      this.next();
      const e = this.parseUnary();
      if (e.k === "num") return { k: "num", v: e.v.startsWith("-") ? e.v.slice(1) : "-" + e.v };
      return { k: "neg", e };
    }
    if (this.isOp("+")) {
      this.next();
      return this.parseUnary();
    }
    return this.parsePrimary();
  }
  parsePrimary(): Expr {
    if (this.isOp("(")) {
      this.next();
      const e = this.parseExpr();
      if (!this.isOp(")")) throw new ParseError("Expected a closing parenthesis");
      this.next();
      return e;
    }
    const t = this.tok;
    if (t.t === "word" && (VERBS.has(t.v) || (KEYWORDS.has(t.v) && t.v !== "FUNCTION"))) throw new ParseError(`Expected an operand, found "${t.raw}"`);
    if (t.t === "period" || t.t === "eof") throw new ParseError("Expected an operand");
    return this.parseOperand();
  }

  // ---------- conditions ----------
  parseCond(): Cond {
    this.lastRel = null;
    return this.parseOr();
  }
  parseOr(): Cond {
    let a = this.parseAnd();
    while (this.isWord("OR")) {
      this.next();
      const b = this.parseAnd();
      a = { k: "or", a, b };
    }
    return a;
  }
  parseAnd(): Cond {
    let a = this.parseNot();
    while (this.isWord("AND")) {
      this.next();
      const b = this.parseNot();
      a = { k: "and", a, b };
    }
    return a;
  }
  parseNot(): Cond {
    if (this.isWord("NOT") && !this.relOpAhead(1)) {
      this.next();
      return { k: "not", c: this.parseNot() };
    }
    return this.parseCondPrimary();
  }

  relOpAhead(offset = 0): boolean {
    const t = this.peek(offset);
    if (t.t === "op" && ["=", ">", "<", ">=", "<=", "<>"].includes(t.v)) return true;
    if (t.t === "word" && ["EQUAL", "GREATER", "LESS", "EQUALS"].includes(t.v)) return true;
    return false;
  }

  /** Reads a relational operator (with IS / NOT). Returns null when absent. */
  readRelOp(): RelOp | null {
    const save = this.pos;
    this.accept("IS");
    let neg = false;
    if (this.isWord("NOT")) {
      this.next();
      neg = true;
    }
    let op: RelOp | null = null;
    const t = this.tok;
    if (t.t === "op" && ["=", ">", "<", ">=", "<=", "<>"].includes(t.v)) {
      this.next();
      op = t.v as RelOp;
      if (op === ">" && this.isWord("OR") && this.isWord("EQUAL", this.peek())) {
        this.next();
        this.next();
        this.accept("TO");
        op = ">=";
      }
    } else if (this.isWord("EQUAL") || this.isWord("EQUALS")) {
      this.next();
      this.accept("TO");
      op = "=";
    } else if (this.isWord("GREATER") || this.isWord("LESS")) {
      const g = this.next().v === "GREATER";
      this.accept("THAN");
      if (this.isWord("OR") && this.isWord("EQUAL", this.peek())) {
        this.next();
        this.next();
        this.accept("TO");
        op = g ? ">=" : "<=";
      } else op = g ? ">" : "<";
    }
    if (!op) {
      this.pos = save;
      return null;
    }
    if (neg) op = ({ "=": "<>", "<>": "=", ">": "<=", "<": ">=", ">=": "<", "<=": ">" } as const)[op];
    return op;
  }

  parseCondPrimary(): Cond {
    // Parentheses: grouped condition or arithmetic expression
    if (this.isOp("(")) {
      const save = this.pos;
      const saveRel = this.lastRel;
      try {
        this.next();
        const c = this.parseOr();
        if (this.isOp(")")) {
          this.next();
          if (!this.relOpAhead() && !this.isWord("IS") && !this.isOp("+") && !this.isOp("-") && !this.isOp("*") && !this.isOp("/") && !(this.isWord("NOT") && this.relOpAhead(1))) return c;
        }
      } catch {
        /* on retente comme expression */
      }
      this.pos = save;
      this.lastRel = saveRel;
    }
    // Abbreviated form: "AND > 5", "OR NOT = 'X'"
    if (this.lastRel && (this.relOpAhead() || (this.isWord("NOT") && this.relOpAhead(1)))) {
      const op = this.readRelOp();
      if (op) {
        const r = this.parseExpr();
        this.lastRel = { l: this.lastRel.l, op };
        return { k: "rel", op, l: this.lastRel.l, r };
      }
    }
    // Condition name (level 88)
    const t = this.tok;
    if (t.t === "word" && this.fields.get(t.v)?.level === 88 && !this.relOpAhead(1)) {
      this.next();
      return { k: "cname", name: t.v };
    }
    const l = this.parseExpr();
    const save = this.pos;
    this.accept("IS");
    let neg = false;
    if (this.isWord("NOT") && !this.relOpAhead(1)) {
      this.next();
      neg = true;
    }
    if (this.isWord("NUMERIC") || this.isWord("ALPHABETIC")) {
      return { k: "class", e: l, cls: this.next().v as "NUMERIC" | "ALPHABETIC", neg };
    }
    if (this.isWord("POSITIVE") || this.isWord("NEGATIVE") || this.isWord("ZERO")) {
      return { k: "sign", e: l, sign: this.next().v as "POSITIVE" | "NEGATIVE" | "ZERO", neg };
    }
    this.pos = save;
    const op = this.readRelOp();
    if (op) {
      const r = this.parseExpr();
      this.lastRel = { l, op };
      return { k: "rel", op, l, r };
    }
    // Abbreviated form "A = 1 OR 2": same subject, same operator
    if (this.lastRel) return { k: "rel", op: this.lastRel.op, l: this.lastRel.l, r: l };
    throw new ParseError(`Incomplete condition near "${this.tok.raw || "end of input"}"`);
  }

  // ---------- instructions ----------
  parseMove(start: Token): Stmt {
    if (this.isWord("CORR") || this.isWord("CORRESPONDING")) {
      this.next();
      this.addManual(start, "MOVE CORRESPONDING", "MOVE CORRESPONDING must be migrated by hand.");
    }
    const src = this.parseOperand();
    this.expectWord("TO");
    const to: RefExpr[] = [];
    while (this.isRefStart()) to.push(this.parseRef());
    if (!to.length) throw new ParseError("Expected a MOVE target");
    return this.newStmt(start, { kind: "move", src, to });
  }

  parseTargets(): Target[] {
    const out: Target[] = [];
    while (this.isRefStart()) {
      const ref = this.parseRef();
      const rounded = this.accept("ROUNDED");
      if (rounded && (this.isWord("MODE") || this.isWord("IS"))) {
        this.accept("MODE");
        this.accept("IS");
        this.addManual(this.tok, "ROUNDED MODE", "Explicit ROUNDED MODE: only the default mode (nearest, half away from zero) is supported.");
        this.next();
      }
      out.push({ ref, rounded });
    }
    return out;
  }

  parseSizeError(): { onSize?: Stmt[]; notOnSize?: Stmt[] } {
    const r: { onSize?: Stmt[]; notOnSize?: Stmt[] } = {};
    for (let k = 0; k < 2; k++) {
      if (this.isWord("ON") && this.isWord("SIZE", this.peek())) {
        this.next();
        this.next();
        this.expectWord("ERROR");
        r.onSize = this.parseBlock();
      } else if (this.isWord("SIZE") && this.isWord("ERROR", this.peek())) {
        this.next();
        this.next();
        r.onSize = this.parseBlock();
      } else if (this.isWord("NOT") && (this.isWord("SIZE", this.peek()) || (this.isWord("ON", this.peek()) && this.isWord("SIZE", this.peek(2))))) {
        this.next();
        this.accept("ON");
        this.next();
        this.expectWord("ERROR");
        r.notOnSize = this.parseBlock();
      }
    }
    return r;
  }

  parseCompute(start: Token): Stmt {
    const targets = this.parseTargets();
    if (this.isOp("=")) this.next();
    else this.expectWord("EQUAL");
    const expr = this.parseExpr();
    const se = this.parseSizeError();
    this.accept("END-COMPUTE");
    return this.newStmt(start, { kind: "compute", verb: "COMPUTE", targets, exprs: targets.map(() => expr), ...se });
  }

  parseArith(start: Token, verb: "ADD" | "SUBTRACT" | "MULTIPLY" | "DIVIDE"): Stmt {
    if (this.isWord("CORR") || this.isWord("CORRESPONDING")) {
      this.next();
      this.addManual(start, `${verb} CORRESPONDING`, `${verb} CORRESPONDING must be migrated by hand.`);
    }
    const operands: Expr[] = [];
    const stopWords = ["TO", "FROM", "BY", "INTO", "GIVING"];
    while (!this.eof && !(this.tok.t === "word" && stopWords.includes(this.tok.v)) && this.tok.t !== "period") operands.push(this.parseOperand());
    const sum = (xs: Expr[]): Expr => xs.reduce((a, b) => ({ k: "bin", op: "+", l: a, r: b }));
    let targets: Target[] = [];
    let exprs: Expr[] = [];
    let remainder: { ref: RefExpr; dividend: Expr; divisor: Expr } | undefined;
    const prep = this.tok.v;
    if (verb === "ADD") {
      if (this.accept("TO")) {
        const tgs = this.parseTargets();
        if (this.accept("GIVING")) {
          const giving = this.parseTargets();
          const all = sum([...operands, ...tgs.map((t) => t.ref)]);
          targets = giving;
          exprs = giving.map(() => all);
        } else {
          targets = tgs;
          exprs = tgs.map((t) => ({ k: "bin", op: "+", l: t.ref, r: operands.length === 1 ? operands[0] : sum(operands) }) as Expr);
        }
      } else {
        this.expectWord("GIVING");
        targets = this.parseTargets();
        exprs = targets.map(() => sum(operands));
      }
    } else if (verb === "SUBTRACT") {
      this.expectWord("FROM");
      const tgs = this.parseTargets();
      if (this.accept("GIVING")) {
        targets = this.parseTargets();
        const minuend = tgs[0].ref;
        exprs = targets.map(() => ({ k: "bin", op: "-", l: minuend, r: sum(operands) }) as Expr);
      } else {
        targets = tgs;
        exprs = tgs.map((t) => ({ k: "bin", op: "-", l: t.ref, r: sum(operands) }) as Expr);
      }
    } else if (verb === "MULTIPLY") {
      this.expectWord("BY");
      const tgs = this.parseTargets();
      if (this.accept("GIVING")) {
        targets = this.parseTargets();
        exprs = targets.map(() => ({ k: "bin", op: "*", l: operands[0], r: tgs[0].ref }) as Expr);
      } else {
        targets = tgs;
        exprs = tgs.map((t) => ({ k: "bin", op: "*", l: operands[0], r: t.ref }) as Expr);
      }
    } else {
      // DIVIDE
      if (prep === "INTO") {
        this.next();
        const tgs = this.parseTargets();
        if (this.accept("GIVING")) {
          targets = this.parseTargets();
          exprs = targets.map(() => ({ k: "bin", op: "/", l: tgs[0].ref, r: operands[0] }) as Expr);
          if (this.accept("REMAINDER")) remainder = { ref: this.parseRef(), dividend: tgs[0].ref, divisor: operands[0] };
        } else {
          targets = tgs;
          exprs = tgs.map((t) => ({ k: "bin", op: "/", l: t.ref, r: operands[0] }) as Expr);
        }
      } else {
        this.expectWord("BY");
        const divisor = this.parseOperand();
        this.expectWord("GIVING");
        targets = this.parseTargets();
        exprs = targets.map(() => ({ k: "bin", op: "/", l: operands[0], r: divisor }) as Expr);
        if (this.accept("REMAINDER")) remainder = { ref: this.parseRef(), dividend: operands[0], divisor };
      }
    }
    const se = this.parseSizeError();
    this.accept("END-" + verb);
    return this.newStmt(start, { kind: "compute", verb, targets, exprs, remainder, ...se });
  }

  parseIf(start: Token): Stmt {
    const cond = this.parseCond();
    this.accept("THEN");
    const then = this.parseBlock();
    let els: Stmt[] | undefined;
    if (this.accept("ELSE")) els = this.parseBlock();
    this.accept("END-IF");
    return this.newStmt(start, { kind: "if", cond, then, else: els });
  }

  parseEvaluate(start: Token): Stmt {
    let subject: Expr | "TRUE" | "FALSE";
    if (this.accept("TRUE")) subject = "TRUE";
    else if (this.accept("FALSE")) subject = "FALSE";
    else subject = this.parseExpr();
    if (this.isWord("ALSO")) {
      this.addManual(start, "EVALUATE ALSO", "EVALUATE with several subjects (ALSO) must be migrated by hand.");
      while (!this.eof && !this.isWord("END-EVALUATE") && this.tok.t !== "period") this.next();
      this.accept("END-EVALUATE");
      return this.newStmt(start, { kind: "unsupported", verb: "EVALUATE", text: "EVALUATE … ALSO", reason: "Multiple subjects" });
    }
    const whens: { objs: WhenObject[]; body: Stmt[] }[] = [];
    let other: Stmt[] | undefined;
    while (this.isWord("WHEN")) {
      this.next();
      if (this.accept("OTHER")) {
        other = this.parseBlock();
        continue;
      }
      const objs: WhenObject[] = [];
      for (;;) {
        objs.push(this.parseWhenObject(subject));
        if (this.isWord("WHEN") && !this.isWord("OTHER", this.peek())) {
          // Stacked WHENs: same body
          const save = this.pos;
          this.next();
          if (this.atStatementBoundary() || this.tok.t === "period") {
            this.pos = save;
            break;
          }
          continue;
        }
        break;
      }
      const body = this.parseBlock();
      whens.push({ objs, body });
    }
    this.accept("END-EVALUATE");
    return this.newStmt(start, { kind: "evaluate", subject, whens, other });
  }

  parseWhenObject(subject: Expr | "TRUE" | "FALSE"): WhenObject {
    if (this.accept("ANY")) return { kind: "any" };
    if (subject === "TRUE" || subject === "FALSE") return { kind: "cond", c: this.parseCond() };
    const not = this.accept("NOT");
    const v = this.parseExpr();
    if (this.accept("THRU") || this.accept("THROUGH")) return { kind: "value", v, thru: this.parseExpr(), not };
    return { kind: "value", v, not };
  }

  parsePerform(start: Token): Stmt {
    let target: { from: string; thru?: string } | undefined;
    const t = this.tok;
    const isData = t.t === "word" && this.fields.has(t.v);
    if (t.t === "word" && !VERBS.has(t.v) && !KEYWORDS.has(t.v) && !(isData && this.isWord("TIMES", this.peek()))) {
      target = { from: this.next().v };
      if (this.accept("THRU") || this.accept("THROUGH")) target.thru = this.next().v;
    }
    let testAfter = false;
    let times: Expr | undefined;
    let until: Cond | undefined;
    let varying: { ref: RefExpr; from: Expr; by: Expr } | undefined;
    if (this.accept("WITH") || this.isWord("TEST")) {
      this.accept("TEST");
      testAfter = this.next().v === "AFTER";
    }
    if ((this.tok.t === "num" || (this.tok.t === "word" && this.fields.has(this.tok.v))) && this.isWord("TIMES", this.peek())) {
      times = this.parseOperand();
      this.next();
    } else if (this.accept("UNTIL")) {
      until = this.parseCond();
    } else if (this.accept("VARYING")) {
      const ref = this.parseRef();
      this.expectWord("FROM");
      const from = this.parseOperand();
      this.expectWord("BY");
      const by = this.parseOperand();
      this.expectWord("UNTIL");
      until = this.parseCond();
      varying = { ref, from, by };
      if (this.isWord("AFTER")) {
        this.addManual(start, "PERFORM VARYING AFTER", "Nested VARYING … AFTER loops must be migrated by hand.");
        while (!this.eof && this.tok.t !== "period" && !this.atStatementBoundary()) this.next();
      }
    }
    let body: Stmt[] | undefined;
    if (!target) {
      body = this.parseBlock();
      if (!this.accept("END-PERFORM")) this.diag(this.tok, "Expected END-PERFORM.");
    }
    return this.newStmt(start, { kind: "perform", target, body, times, until, varying, testAfter });
  }

  parseCall(start: Token): Stmt {
    let program: string | null = null;
    let dynamic: string | undefined;
    if (this.tok.t === "str") program = this.next().v.toUpperCase();
    else {
      dynamic = this.next().v;
      this.addManual(start, "Dynamic CALL", `CALL ${dynamic}: the called program is only known at run time.`);
    }
    const using: { ref: Expr; mode: "REFERENCE" | "CONTENT" | "VALUE" }[] = [];
    if (this.accept("USING")) {
      let mode: "REFERENCE" | "CONTENT" | "VALUE" = "REFERENCE";
      while (!this.eof && this.tok.t !== "period" && !this.atStatementBoundary()) {
        if (this.accept("BY")) {
          mode = this.next().v as typeof mode;
          continue;
        }
        if (this.isWord("ADDRESS") || this.isWord("OMITTED")) {
          this.addManual(start, "CALL USING", "ADDRESS OF / OMITTED is not supported.");
          this.next();
          this.accept("OF");
          continue;
        }
        if (this.isWord("ON") || this.isWord("EXCEPTION") || this.isWord("OVERFLOW") || this.isWord("NOT") || this.isWord("RETURNING")) break;
        using.push({ ref: this.parseOperand(), mode });
      }
    }
    let onException: Stmt[] | undefined;
    for (let k = 0; k < 2; k++) {
      if (this.isWord("ON") && (this.isWord("EXCEPTION", this.peek()) || this.isWord("OVERFLOW", this.peek()))) {
        this.next();
        this.next();
        onException = this.parseBlock();
      } else if (this.isWord("EXCEPTION") || this.isWord("OVERFLOW")) {
        this.next();
        onException = this.parseBlock();
      } else if (this.isWord("NOT") && (this.isWord("ON", this.peek()) || this.isWord("EXCEPTION", this.peek()))) {
        this.next();
        this.accept("ON");
        this.next();
        this.parseBlock();
      }
    }
    this.accept("END-CALL");
    return this.newStmt(start, { kind: "call", program, dynamic, using, onException });
  }

  parseSql(): Stmt {
    const t = this.next();
    if (t.exec && t.exec !== "SQL") {
      const text = `EXEC ${t.exec} ${t.v.split(" ").slice(0, 4).join(" ")}`.trim();
      this.addManual(t, `EXEC ${t.exec}`, `${text}: ${t.exec === "CICS" ? "CICS transactions are" : "IMS DL/I calls are"} not supported.`);
      return this.newStmt(t, { kind: "unsupported", verb: `EXEC ${t.exec}`, text, reason: `EXEC ${t.exec} is not supported` });
    }
    return this.newStmt(t, { kind: "sql", sql: parseSql(t.v) });
  }
}

export function parseSql(text: string): SqlInfo {
  const up = text.toUpperCase();
  const op = (/^\s*([A-Z]+)/.exec(up)?.[1] ?? "SQL").toUpperCase();
  const tables: { name: string; mode: "R" | "W" }[] = [];
  const add = (name: string, mode: "R" | "W") => {
    const n = name.toUpperCase().replace(/[^A-Z0-9_.]/g, "");
    if (!n || ["DUAL", "SQLCA", "SYSIBM.SYSDUMMY1"].includes(n)) return;
    if (!tables.some((t) => t.name === n && t.mode === mode)) tables.push({ name: n, mode });
  };
  const hostVars = Array.from(text.matchAll(/:([A-Za-z0-9][A-Za-z0-9-]*)/g)).map((m) => m[1].toUpperCase());
  let into: string[] = [];
  let cursor: string | undefined;
  if (op === "SELECT") {
    const m = /\bINTO\s+(.+?)\s+FROM\b/i.exec(text);
    if (m) into = Array.from(m[1].matchAll(/:([A-Za-z0-9][A-Za-z0-9-]*)/g)).map((x) => x[1].toUpperCase());
  }
  if (op === "FETCH") {
    cursor = /^\s*FETCH\s+(?:NEXT\s+FROM\s+|FROM\s+)?([A-Za-z0-9_-]+)/i.exec(text)?.[1]?.toUpperCase();
    const m = /\bINTO\s+(.+)$/i.exec(text);
    if (m) into = Array.from(m[1].matchAll(/:([A-Za-z0-9][A-Za-z0-9-]*)/g)).map((x) => x[1].toUpperCase());
  }
  if (op === "DECLARE") cursor = /^\s*DECLARE\s+([A-Za-z0-9_-]+)/i.exec(text)?.[1]?.toUpperCase();
  if (op === "OPEN" || op === "CLOSE") cursor = /^\s*(?:OPEN|CLOSE)\s+([A-Za-z0-9_-]+)/i.exec(text)?.[1]?.toUpperCase();
  for (const m of text.matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z0-9_.]+)(?:\s+[A-Za-z0-9_]+)?(\s*,\s*[A-Za-z0-9_.]+(?:\s+[A-Za-z0-9_]+)?)*/gi)) {
    const list = m[0].replace(/^(FROM|JOIN)\s+/i, "").split(",");
    for (const part of list) add(part.trim().split(/\s+/)[0], op === "DELETE" ? "W" : "R");
  }
  if (op === "INSERT") {
    const m = /\bINTO\s+([A-Za-z0-9_.]+)/i.exec(text);
    if (m) add(m[1], "W");
  }
  if (op === "UPDATE") {
    const m = /^\s*UPDATE\s+([A-Za-z0-9_.]+)/i.exec(text);
    if (m) add(m[1], "W");
  }
  if (op === "DELETE") {
    const m = /\bFROM\s+([A-Za-z0-9_.]+)/i.exec(text);
    if (m) add(m[1], "W");
  }
  return { op, text, tables, into, hostVars, cursor };
}
