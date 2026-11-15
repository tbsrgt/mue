// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Records docs/demo.gif from a running Mue Studio (Understand → Convert → Verify → Fix).
 *
 *   npm run seed && npm run build && npx next start -p 3112 &
 *   npm i --no-save playwright-core && npx playwright install chromium-headless-shell
 *   STUDIO_URL=http://localhost:3112 npm run demo:gif
 *
 * Needs ffmpeg on the PATH. CHROME can point to a specific Chromium binary.
 * The recording applies a fix in the example project: run `npm run seed` afterwards.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  console.error("playwright-core is required: npm i --no-save playwright-core");
  process.exit(1);
}

const BASE = process.env.STUDIO_URL ?? "http://localhost:3112";
const OUT = path.resolve(process.env.OUT ?? "docs/demo.gif");
const FPS = 8;
const frames = fs.mkdtempSync(path.join(os.tmpdir(), "mue-gif-"));
let n = 0;

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 1 });

async function caption(text) {
  await page.evaluate((t) => {
    let el = document.getElementById("demo-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "demo-caption";
      el.style.cssText = "position:fixed;right:24px;bottom:22px;z-index:9999;background:#41c79d;color:#06120e;font:600 18px/1.2 system-ui,sans-serif;padding:10px 16px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.45)";
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
}

async function shoot(seconds = 1 / FPS) {
  const count = Math.max(1, Math.round(seconds * FPS));
  const file = path.join(frames, `f${String(n).padStart(4, "0")}.png`);
  await page.screenshot({ path: file });
  n++;
  for (let i = 1; i < count; i++) fs.copyFileSync(file, path.join(frames, `f${String(n++).padStart(4, "0")}.png`));
}

async function scrollTo(y, seconds = 1) {
  const from = await page.evaluate(() => window.scrollY);
  const steps = Math.round(seconds * FPS);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await page.evaluate((v) => window.scrollTo(0, v), from + (y - from) * ease);
    await shoot();
  }
}

const top = (selector) => page.evaluate((s) => document.querySelector(s)?.getBoundingClientRect().top + window.scrollY - 90, selector);

// 0. Dashboard
await page.goto(`${BASE}/projects/1`, { waitUntil: "networkidle" });
await caption("A COBOL banking system, imported");
await shoot(1.6);

// 1. Understand
await page.goto(`${BASE}/projects/1/programs/CALCINT?view=understand`, { waitUntil: "networkidle" });
await caption("1 · Understand: business rules, with their source line");
await shoot(0.8);
await scrollTo(await top(".rules"), 1.1);
await shoot(1.8);

// 2. Convert
await page.goto(`${BASE}/projects/1/programs/CALCINT?view=convert`, { waitUntil: "networkidle" });
await caption("2 · Convert: readable Java, BigDecimal");
await shoot(0.8);
await scrollTo(await top(".split"), 1.1);
const cobolLine = page.locator('.split .codebox:first-child [data-l="46"]');
await cobolLine.hover();
await cobolLine.click();
await page.waitForTimeout(700);
await caption("2 · The team convention says HALF_EVEN…");
await shoot(2.2);

// 3. Verify
await page.goto(`${BASE}/projects/1/programs/CALCINT?view=verify`, { waitUntil: "networkidle" });
await caption("3 · Verify: same cases through COBOL and Java");
await shoot(1.2);
await scrollTo(await top(".cause"), 1.1);
await caption("3 · Mismatch found, traced to line 46, explained");
await shoot(2.4);

// 4. Fix and replay
await caption("Fix: RoundingMode.HALF_UP, convert again, replay");
await shoot(0.8);
await Promise.all([page.waitForURL(/ok=/, { timeout: 60_000 }), page.getByRole("button", { name: "Apply the fix and replay" }).click()]);
await page.waitForLoadState("networkidle");
await page.evaluate(() => window.scrollTo(0, 0));
await caption("Proven equivalent: every case identical");
await scrollTo(await top(".big3"), 0.8);
await shoot(2.8);

await browser.close();

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const scale = "fps=" + FPS + ",scale=920:-1:flags=lanczos";
execFileSync("ffmpeg", ["-y", "-v", "error", "-framerate", String(FPS), "-i", path.join(frames, "f%04d.png"), "-vf", `${scale},palettegen=max_colors=64:stats_mode=diff`, path.join(frames, "palette.png")]);
execFileSync("ffmpeg", ["-y", "-v", "error", "-framerate", String(FPS), "-i", path.join(frames, "f%04d.png"), "-i", path.join(frames, "palette.png"), "-lavfi", `${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, OUT]);
fs.rmSync(frames, { recursive: true, force: true });
console.log(`${OUT}: ${n} frames, ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)} MB`);
