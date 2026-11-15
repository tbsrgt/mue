// SPDX-License-Identifier: AGPL-3.0-only
// Bundles the core library and the CLI into dist/ (decimal.js stays an external dependency).
import { build } from "esbuild";

const common = { bundle: true, platform: "node", format: "esm", target: "node22", packages: "external", logLevel: "info" };
await build({ ...common, entryPoints: ["lib/index.ts"], outfile: "dist/index.js" });
await build({ ...common, entryPoints: ["cli/mue.ts"], outfile: "dist/cli.js" });
