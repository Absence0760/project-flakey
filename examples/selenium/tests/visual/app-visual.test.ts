/**
 * Visual regression tests using driver.takeScreenshot() + pixelmatch.
 *
 * Baselines are stored in tests/visual/baselines/. Set UPDATE_VISUAL_BASELINES=true
 * to regenerate. Hard-fail threshold is 1% pixel difference (VISUAL_DIFF_THRESHOLD).
 */

import { describe, it, before, after } from "mocha";
import { expect } from "chai";
import { WebDriver } from "selenium-webdriver";
import { createDriver, url } from "../helpers.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const BASELINE_DIR = join(process.cwd(), "tests/visual/baselines");
const CURRENT_DIR = join(process.cwd(), "reports/visual/current");
const DIFF_DIR = join(process.cwd(), "reports/visual/diffs");
const THRESHOLD = Number(process.env.VISUAL_DIFF_THRESHOLD ?? "0.01");
const UPDATE = process.env.UPDATE_VISUAL_BASELINES === "true";

type DiffResult = {
  name: string;
  status: "passed" | "failed" | "new";
  diff_pct: number;
  baseline_path: string;
  current_path: string;
  diff_path: string;
};

async function captureAndCompare(driver: WebDriver, name: string): Promise<DiffResult> {
  for (const dir of [BASELINE_DIR, CURRENT_DIR, DIFF_DIR]) mkdirSync(dir, { recursive: true });
  const baselinePath = join(BASELINE_DIR, `${name}.png`);
  const currentPath = join(CURRENT_DIR, `${name}.png`);
  const diffPath = join(DIFF_DIR, `${name}-diff.png`);
  const data = await driver.takeScreenshot();
  writeFileSync(currentPath, Buffer.from(data, "base64"));
  if (UPDATE || !existsSync(baselinePath)) {
    writeFileSync(baselinePath, Buffer.from(data, "base64"));
    console.log(`  [visual] Baseline saved: ${baselinePath}`);
    return { name, status: "new", diff_pct: 0, baseline_path: baselinePath, current_path: currentPath, diff_path: "" };
  }
  const baselineImg = PNG.sync.read(readFileSync(baselinePath));
  const currentImg = PNG.sync.read(readFileSync(currentPath));
  const { width, height } = baselineImg;
  const diffImg = new PNG({ width, height });
  const numMismatch = pixelmatch(baselineImg.data, currentImg.data, diffImg.data, width, height, { threshold: 0.1 });
  const diff_pct = numMismatch / (width * height);
  writeFileSync(diffPath, PNG.sync.write(diffImg));
  const status = diff_pct > THRESHOLD ? "failed" : "passed";
  console.log(`  [visual] ${name}: ${(diff_pct * 100).toFixed(2)}% diff — ${status}`);
  return { name, status, diff_pct, baseline_path: baselinePath, current_path: currentPath, diff_path: diffPath };
}

describe("Visual regression — todo app", () => {
  let driver: WebDriver;
  const manifest: DiffResult[] = [];
  before(async () => { driver = await createDriver(); });
  after(async () => {
    mkdirSync("reports/visual", { recursive: true });
    writeFileSync("reports/visual/manifest.json", JSON.stringify({ diffs: manifest }, null, 2));
    console.log(`\n  [visual] Manifest written to reports/visual/manifest.json`);
    await driver?.quit();
  });

  it("todos page should match baseline", async () => {
    await driver.get(url("#todos"));
    await driver.sleep(400);
    const result = await captureAndCompare(driver, "todos-page");
    manifest.push(result);
    if (result.status === "failed") {
      expect.fail(`Visual diff for "${result.name}" is ${(result.diff_pct * 100).toFixed(2)}% — exceeds threshold of ${(THRESHOLD * 100).toFixed(2)}%`);
    }
  });

  it("login page should match baseline", async () => {
    await driver.get(url("#login"));
    await driver.sleep(400);
    const result = await captureAndCompare(driver, "login-page");
    manifest.push(result);
    if (result.status === "failed") {
      expect.fail(`Visual diff for "${result.name}" is ${(result.diff_pct * 100).toFixed(2)}% — exceeds threshold of ${(THRESHOLD * 100).toFixed(2)}%`);
    }
  });
});
