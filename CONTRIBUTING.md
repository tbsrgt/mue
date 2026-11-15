# Contributing to Mue

Thanks for your interest. Mue lives or dies by how faithfully it reproduces COBOL semantics, so the most valuable contributions are **COBOL programs that Mue gets wrong**, with what the real compiler does.

## Development setup

Requires Node.js 22.13 or later (Mue Studio uses the built-in `node:sqlite`).

```bash
npm install
npm test            # vitest, a few seconds
npm run lint
npm run typecheck
npm run build       # library + CLI (dist/) and Mue Studio
npm run mue -- verify examples/banking
npm run studio      # http://localhost:3000
```

## Reporting a semantic bug

Open an issue with the "COBOL semantics" template and include:

- a minimal program (fixed or free format) and the input values;
- the expected result and where it comes from (IBM Enterprise COBOL with its compiler options, GnuCOBOL, Micro Focus…);
- what Mue reports (`npm run mue -- verify <dir> --inputs cases.json`).

Never paste production code or real customer data. Rewrite the logic with fictional names and values.

## Pull requests

- Keep changes focused, and add a test. Semantic changes need a case in `tests/semantics.test.ts` that runs **both** engines (the interpreter and the Java model) and checks they agree.
- The Java text and the Java execution model must stay in sync: they are both produced from the IR in `lib/java/ir.ts`. If you change how a statement is rendered, change `lib/java/executor.ts` too (and the other way round).
- Never make Mue guess. A construct that is not fully supported must be reported (`addManual` in the parser, a blocking `todo` in the transpiler), so that `verify` skips the program instead of declaring it equivalent.
- New source files start with `// SPDX-License-Identifier: AGPL-3.0-only`.
- Run `npm test`, `npm run lint` and `npm run typecheck` before pushing; CI runs them along with the build.

## Recording the demo

`scripts/demo-gif.mjs` regenerates `docs/demo.gif` from a running Studio (it needs `playwright-core` and `ffmpeg`; instructions at the top of the file).

## License of contributions

Mue is licensed under AGPL-3.0-only. By submitting a contribution, you agree that it is licensed under the same terms.
