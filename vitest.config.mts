import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  // The suite runs in a few seconds; a test that takes longer than this is a regression.
  test: { include: ["tests/**/*.test.ts"], testTimeout: 20000 },
});
