#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * mue — command-line interface.
 *
 *   mue analyze <dir> [--format md|json] [--out FILE]
 *   mue convert <dir> [--out DIR] [--rounding HALF_UP|HALF_EVEN] [--fix PROGRAM=MODE]
 *   mue verify  <dir> [--cases N] [--report-dir DIR] [--fix PROGRAM=MODE]
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { analysisMarkdown, analyze, explain, loadSources, transpile, verificationHtml, verificationMarkdown, verify, VERSION, type Conventions, type Overrides, type ProgramExplanation, type RecordedCase, type SystemAnalysis } from "../lib/index";

const HELP = `mue ${VERSION} — understand COBOL, rewrite it in Java, prove both behave the same.

Usage:
  mue analyze <dir> [options]   Inventory, call graph and business rules
      --format md|json          Output format (default: md)
      --out FILE                Write to a file instead of stdout

  mue convert <dir> [options]   Write the Java translation
      --out DIR                 Output directory (default: java)
      --program ID              Only this program (repeatable)

  mue verify <dir> [options]    Replay the same cases through COBOL and Java, compare
      --cases N                 Total cases per program (default: ~2,000 + edge cases)
      --seed N                  PRNG seed (default: derived from the program name)
      --program ID              Only this program (repeatable)
      --inputs FILE             JSON file of recorded inputs to replay, by program
      --report-dir DIR          Where to write the reports (default: mue-report)
      --format LIST             Report formats, comma-separated: md,html,json (default: all)
      --strict                  Also fail when a program had to be skipped

Conversion options (convert and verify):
      --rounding MODE           Rounding of ROUNDED: HALF_UP (COBOL-exact, default) or HALF_EVEN
      --overflow MODE           Size overflow: reproduce (COBOL-exact, default) or ignore
      --package NAME            Java package (default: com.example.bank)
      --fix PROGRAM=MODE        Per-program rounding override, e.g. --fix CALCINT=HALF_UP (repeatable)

Exit codes: 0 success, 1 mismatches found (or skipped programs with --strict), 2 usage error.
`;

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = paint(32);
const red = paint(31);
const yellow = paint(33);
const dim = paint(2);
const bold = paint(1);
const fmt = (x: number) => x.toLocaleString("en-US");

class UsageError extends Error {}

function main(argv: string[]): Promise<number> | number {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return command ? 0 : 2;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      format: { type: "string" },
      out: { type: "string" },
      program: { type: "string", multiple: true },
      cases: { type: "string" },
      seed: { type: "string" },
      inputs: { type: "string" },
      "report-dir": { type: "string" },
      strict: { type: "boolean" },
      rounding: { type: "string" },
      overflow: { type: "string" },
      package: { type: "string" },
      fix: { type: "string", multiple: true },
      quiet: { type: "boolean" },
    },
  });
  const dir = positionals[0];
  if (!dir) throw new UsageError(`Missing <dir>. Try: mue ${command} examples/banking`);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new UsageError(`Not a directory: ${dir}`);
  const sources = loadSources(dir);
  if (!sources.length) throw new UsageError(`No .cbl, .cob, .cpy or .jcl file found under ${dir}`);
  const system = analyze(sources);
  const conv = conversionOptions(values);
  switch (command) {
    case "analyze":
      return runAnalyze(system, values.format ?? "md", values.out);
    case "convert":
      return runConvert(system, conv, values.out ?? "java", values.program);
    case "verify":
      return runVerify(system, conv, {
        cases: values.cases !== undefined ? positiveInt(values.cases, "--cases") : undefined,
        seed: values.seed !== undefined ? positiveInt(values.seed, "--seed") : undefined,
        programs: values.program,
        inputs: values.inputs,
        reportDir: values["report-dir"] ?? "mue-report",
        formats: (values.format ?? "md,html,json").split(",").map((s) => s.trim().toLowerCase()),
        strict: !!values.strict,
        quiet: !!values.quiet,
      });
    default:
      throw new UsageError(`Unknown command "${command}". Run mue --help.`);
  }
}

function positiveInt(v: string, flag: string): number {
  const x = Number(v);
  if (!Number.isInteger(x) || x < 0) throw new UsageError(`${flag} expects a non-negative integer`);
  return x;
}

function conversionOptions(values: { rounding?: string; overflow?: string; package?: string; fix?: string[] }) {
  const conventions: Partial<Conventions> = {};
  if (values.rounding) {
    const r = values.rounding.toUpperCase();
    if (r !== "HALF_UP" && r !== "HALF_EVEN") throw new UsageError("--rounding expects HALF_UP or HALF_EVEN");
    conventions.rounding = r;
  }
  if (values.overflow) {
    if (values.overflow !== "reproduce" && values.overflow !== "ignore") throw new UsageError("--overflow expects reproduce or ignore");
    conventions.overflow = values.overflow;
  }
  if (values.package) {
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(values.package)) throw new UsageError("--package expects a Java package name such as com.example.bank");
    conventions.package = values.package;
  }
  const overrides: Record<string, Overrides> = {};
  for (const f of values.fix ?? []) {
    const m = /^([A-Z0-9#@$-]+)=(HALF_UP|HALF_EVEN)$/i.exec(f);
    if (!m) throw new UsageError(`--fix expects PROGRAM=HALF_UP or PROGRAM=HALF_EVEN, got "${f}"`);
    overrides[m[1].toUpperCase()] = { ...(overrides[m[1].toUpperCase()] ?? {}), rounding: m[2].toUpperCase() as "HALF_UP" | "HALF_EVEN" };
  }
  return { conventions, overrides };
}

async function runAnalyze(system: SystemAnalysis, format: string, out?: string): Promise<number> {
  const explanations = new Map<string, ProgramExplanation>();
  for (const p of system.programs) explanations.set(p.id, await explain(system, p.id));
  let text: string;
  if (format === "json") {
    const { asts, ...rest } = system;
    void asts;
    text = JSON.stringify({ ...rest, explanations: Object.fromEntries(explanations) }, null, 2) + "\n";
  } else if (format === "md" || format === "markdown") text = analysisMarkdown(system, explanations) + "\n";
  else throw new UsageError("--format expects md or json");
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, text);
    process.stderr.write(`Analysis written to ${out}\n`);
  } else process.stdout.write(text);
  return 0;
}

function runConvert(system: SystemAnalysis, conv: ReturnType<typeof conversionOptions>, outDir: string, only?: string[]): number {
  const converted = transpile(system, conv);
  const ids = only?.map((p) => p.toUpperCase()) ?? [...converted.keys()];
  const written = new Set<string>();
  let todo = 0;
  for (const id of ids) {
    const c = converted.get(id);
    if (!c) throw new UsageError(`Program ${id} not found in the sources`);
    for (const f of c.files) {
      const pkg = f.kind === "runtime" ? "mue.runtime" : c.ir.conventions.package;
      const file = path.join(outDir, ...pkg.split("."), f.name);
      if (written.has(file)) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, f.content.endsWith("\n") ? f.content : f.content + "\n");
      written.add(file);
    }
    const blocking = c.todos.filter((t) => t.blocking);
    todo += blocking.length;
    const lines = c.files[0].content.split("\n").length;
    const status = blocking.length ? yellow(`${blocking.length} construct${blocking.length > 1 ? "s" : ""} to migrate by hand: ${[...new Set(blocking.map((b) => b.construct))].join(", ")}`) : green("fully converted");
    process.stdout.write(`${bold(id.padEnd(9))} → ${(c.className + ".java").padEnd(34)} ${dim(String(lines).padStart(4) + " lines")}  ${status}\n`);
  }
  process.stdout.write(`\n${written.size} files written to ${outDir}${todo ? dim(` (programs with manual work throw UnsupportedOperationException where code was not converted)`) : ""}\n`);
  return 0;
}

async function runVerify(
  system: SystemAnalysis,
  conv: ReturnType<typeof conversionOptions>,
  o: { cases?: number; seed?: number; programs?: string[]; inputs?: string; reportDir: string; formats: string[]; strict: boolean; quiet: boolean },
): Promise<number> {
  let extraCases: Record<string, RecordedCase[]> | undefined;
  if (o.inputs) {
    try {
      extraCases = JSON.parse(fs.readFileSync(o.inputs, "utf8"));
    } catch (e) {
      throw new UsageError(`Cannot read --inputs ${o.inputs}: ${(e as Error).message}`);
    }
  }
  const programs = o.programs?.map((p) => p.toUpperCase());
  for (const p of programs ?? []) if (!system.asts.has(p)) throw new UsageError(`Program ${p} not found in the sources`);
  const run = await verify(system, { ...conv, programs, cases: o.cases, seed: o.seed, extraCases });

  for (const p of run.programs) {
    const name = bold(p.program.padEnd(9));
    if (p.status === "skipped") {
      process.stdout.write(`${name} ${yellow("skipped")}   ${dim(p.reason ?? "")}\n`);
      continue;
    }
    const r = p.report!;
    const counts = `${fmt(r.identical).padStart(6)} / ${fmt(r.total).padEnd(6)} identical`;
    if (p.status === "equivalent") process.stdout.write(`${name} ${green("equivalent")} ${counts}\n`);
    else {
      process.stdout.write(`${name} ${red("MISMATCH")}   ${counts}  ${red(`${fmt(r.mismatches)} different`)}\n`);
      if (!o.quiet)
        r.groups.forEach((g, i) => {
          const ex = p.explanations[i];
          const sample = g.examples[0];
          process.stdout.write(`          ${dim("└─")} ${ex?.title ?? g.kind}: ${g.program} line ${g.line}, ${g.field}${sample ? dim(` (e.g. exact ${sample.raw ?? "?"} → COBOL ${sample.cobol}, Java ${sample.java})`) : ""}\n`);
          if (ex?.fix?.kind === "rounding") process.stdout.write(`             ${dim("fix:")} --fix ${ex.fix.program}=${ex.fix.value}\n`);
        });
    }
  }
  const t = run.totals;
  process.stdout.write(`\n${t.equivalent}/${t.programs} programs equivalent · ${fmt(t.identical)}/${fmt(t.cases)} cases identical${t.skipped ? ` · ${t.skipped} skipped` : ""}\n`);

  fs.mkdirSync(o.reportDir, { recursive: true });
  const written: string[] = [];
  if (o.formats.includes("md")) written.push(write(path.join(o.reportDir, "report.md"), verificationMarkdown(run) + "\n"));
  if (o.formats.includes("html")) written.push(write(path.join(o.reportDir, "report.html"), verificationHtml(run, { printBar: true })));
  if (o.formats.includes("json")) written.push(write(path.join(o.reportDir, "report.json"), JSON.stringify(run, null, 2) + "\n"));
  if (written.length) process.stdout.write(dim(`Reports: ${written.join(", ")}\n`));
  return t.mismatch || (o.strict && t.skipped) ? 1 : 0;
}

function write(file: string, content: string) {
  fs.writeFileSync(file, content);
  return file;
}

Promise.resolve()
  .then(() => main(process.argv.slice(2)))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    if (e instanceof UsageError || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      process.stderr.write(`mue: ${(e as Error).message}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`mue: ${(e as Error).stack ?? e}\n`);
      process.exitCode = 3;
    }
  });
