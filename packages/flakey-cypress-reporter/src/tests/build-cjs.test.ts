/**
 * scripts/build-cjs.cjs converts the ESM-compiled reporter to CJS so
 * Cypress's `reporter:` field can `require()` it.
 *
 * The script's correctness depends on a single regex that has to handle
 * every import shape `tsc` might emit:
 *   1. Named:        `import { a, b as c } from "mod";`
 *   2. Multi-line:   `import {\n  a,\n  b,\n} from "mod";`
 *   3. Default:      `import foo from "mod";`
 *   4. Default + named: `import foo, { a, b } from "mod";`
 *   5. Namespace:    `import * as foo from "mod";`
 *
 * Earlier the script hardcoded the stdlib import list. Adding a new
 * import to reporter.ts silently produced a broken .cjs whose missing
 * binding crashed Cypress with a generic TypeError that the
 * surrounding try/catch swallowed. This test pins the rewriter so that
 * regression cannot re-emerge.
 *
 * The script reads `dist/reporter.js` and writes `dist/reporter.cjs`,
 * resolved relative to its CWD. We point CWD at a temp dir, write a
 * synthetic dist/reporter.js into it, run the script, and read the
 * resulting dist/reporter.cjs back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT = resolve(__dirname, "../../scripts/build-cjs.cjs");

function buildCjs(input: string): string {
  const dir = mkdtempSync(join(tmpdir(), "build-cjs-test-"));
  try {
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist/reporter.js"), input, "utf8");
    const result = spawnSync("node", [SCRIPT], { cwd: dir, encoding: "utf8" });
    assert.equal(
      result.status,
      0,
      `build-cjs.cjs exited ${result.status}: ${result.stderr}`,
    );
    return readFileSync(join(dir, "dist/reporter.cjs"), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("rewrites a single-line named import to require with destructuring", () => {
  const out = buildCjs(`import { writeFileSync } from "node:fs";\nconsole.log("body");\n`);
  assert.match(out, /const\s*\{\s*writeFileSync\s*\}\s*=\s*require\("node:fs"\)/);
  // Original import line must be stripped.
  assert.doesNotMatch(out, /^import\s/m);
  // Body must be preserved.
  assert.match(out, /console\.log\("body"\);/);
});

test("rewrites a multi-line named import block (the original regression that prompted the rewrite)", () => {
  const src =
    `import {\n  readFileSync,\n  writeFileSync,\n  existsSync,\n} from "node:fs";\nconst x = 1;\n`;
  const out = buildCjs(src);
  // All three bindings must end up on the require destructure.
  assert.match(out, /readFileSync/);
  assert.match(out, /writeFileSync/);
  assert.match(out, /existsSync/);
  assert.match(out, /require\("node:fs"\)/);
  assert.doesNotMatch(out, /^import\s/m);
});

test("rewrites `as` aliases to property:alias destructure form", () => {
  const out = buildCjs(`import { writeFileSync as wfs } from "node:fs";\n`);
  // tsc-style alias must survive — `wfs` is what the body references.
  assert.match(out, /writeFileSync\s*:\s*wfs/);
});

test("rewrites a default import with the `.default ?? mod` interop fallback", () => {
  // CJS modules whose `module.exports = X` need the fallback or
  // `.default` is undefined and the body crashes.
  const out = buildCjs(`import foo from "some-cjs-mod";\n`);
  assert.match(
    out,
    /const\s+foo\s*=\s*require\("some-cjs-mod"\)\.default\s*\?\?\s*require\("some-cjs-mod"\);/,
  );
});

test("rewrites a default + named import in one statement", () => {
  const out = buildCjs(`import path, { join, resolve } from "node:path";\n`);
  assert.match(out, /const\s+path\s*=\s*require\("node:path"\)\.default\s*\?\?\s*require\("node:path"\);/);
  assert.match(out, /\{\s*join\s*,\s*resolve\s*\}\s*=\s*require\("node:path"\)/);
});

test("rewrites a namespace import to a single require assignment", () => {
  const out = buildCjs(`import * as fs from "node:fs";\n`);
  assert.match(out, /const\s+fs\s*=\s*require\("node:fs"\);/);
});

test("handles a mixed import set without dropping any binding", () => {
  // Realistic shape — one of each variant in a single file. A
  // regression that re-anchored the regex too tightly used to drop
  // every-other import here.
  const src = [
    `import { test } from "node:test";`,
    `import assert from "node:assert/strict";`,
    `import * as fs from "node:fs";`,
    `import path, { join } from "node:path";`,
    `import {`,
    `  spawn,`,
    `  spawnSync,`,
    `} from "node:child_process";`,
    `module.exports = function () {};`,
    "",
  ].join("\n");
  const out = buildCjs(src);
  assert.match(out, /\{\s*test\s*\}\s*=\s*require\("node:test"\)/);
  assert.match(out, /const\s+assert\s*=\s*require\("node:assert\/strict"\)\.default\s*\?\?\s*require\("node:assert\/strict"\);/);
  assert.match(out, /const\s+fs\s*=\s*require\("node:fs"\);/);
  assert.match(out, /const\s+path\s*=\s*require\("node:path"\)\.default\s*\?\?\s*require\("node:path"\);/);
  assert.match(out, /\{\s*join\s*\}\s*=\s*require\("node:path"\)/);
  assert.match(out, /\{\s*spawn\s*,\s*spawnSync\s*\}\s*=\s*require\("node:child_process"\)/);
  // Body — `module.exports = ...` — must survive untouched.
  assert.match(out, /module\.exports\s*=\s*function/);
});
