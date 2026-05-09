import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the CLI entry from this test file, regardless of the test
// runner's CWD. We invoke through `tsx` so we don't require `pnpm build`
// to have run first.
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(HERE, "..", "index.ts");

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      ["--import", "tsx", CLI_ENTRY, ...args],
      {
        env: { ...process.env, ...env, FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("`flakey-cli <unknown-subcommand>` prints help and exits non-zero", async () => {
  const { code, stderr } = await runCli(["does-not-exist"]);
  assert.notEqual(code, 0, "unknown subcommand must exit with non-zero status");
  assert.match(
    stderr,
    /Unknown subcommand|Available:/,
    "should mention the subcommand routing in its error output",
  );
});

test("`flakey-cli coverage` without --run-id prints a usage line and exits non-zero", async () => {
  const { code, stderr } = await runCli(["coverage"]);
  assert.notEqual(code, 0);
  assert.match(stderr, /Usage: flakey-cli coverage/);
});

test("`flakey-cli a11y` without args prints a11y usage and exits non-zero", async () => {
  const { code, stderr } = await runCli(["a11y"]);
  assert.notEqual(code, 0);
  assert.match(stderr, /Usage: flakey-cli a11y/);
});

test("`flakey-cli visual` without args prints visual usage and exits non-zero", async () => {
  const { code, stderr } = await runCli(["visual"]);
  assert.notEqual(code, 0);
  assert.match(stderr, /Usage: flakey-cli visual/);
});

test("`flakey-cli ui-coverage` without --suite prints usage and exits non-zero", async () => {
  const { code, stderr } = await runCli(["ui-coverage"]);
  assert.notEqual(code, 0);
  assert.match(stderr, /Usage: flakey-cli ui-coverage/);
});

test("`flakey-cli upload --report-dir <missing>` exits with a 'no report files' error", async () => {
  const { code, stderr } = await runCli(
    [
      "upload",
      "--report-dir",
      "/tmp/definitely-not-a-real-dir-xyz",
      "--suite-name",
      "unit-test",
      "--reporter",
      "mochawesome",
    ],
    { FLAKEY_API_KEY: "dummy" },
  );
  assert.notEqual(code, 0, "missing report dir → non-zero exit");
  assert.match(
    stderr,
    /No report files found/,
    "should explain that the reporter dir is empty / missing",
  );
});
