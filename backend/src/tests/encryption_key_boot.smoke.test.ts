/**
 * Boot-time validation for FLAKEY_ENCRYPTION_KEY.
 *
 * Previously the boot guard only checked PRESENCE — a key that was set
 * but malformed (wrong length, not hex or base64) passed the boot
 * check and then crashed crypto.ts on the first integration PATCH
 * with a generic 500. This test pins the cleaner failure mode: refuse
 * to boot with a clear message instead.
 *
 * The valid key fixture is 32 bytes (64 hex chars) — the existing
 * pattern across cors_prod / ssrf / http_security_baseline tests.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

function runWithKey(key: string | undefined, extraEnv: Record<string, string> = {}): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const env: Record<string, string> = {
      ...process.env,
      PORT: "3989",
      DB_USER: process.env.DB_USER ?? "flakey_app",
      DB_PASSWORD: process.env.DB_PASSWORD ?? "flakey_app",
      DB_NAME: process.env.DB_NAME ?? "flakey",
      JWT_SECRET: "boot-key-test",
      NODE_ENV: "test",
      FLAKEY_LIVE_TIMEOUT_MS: "60000",
      ...extraEnv,
    } as Record<string, string>;
    if (key !== undefined) env.FLAKEY_ENCRYPTION_KEY = key;
    else delete env.FLAKEY_ENCRYPTION_KEY;
    const child = spawn("node", ["--import", "tsx", "src/index.ts"], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    // Give the process up to 8 s to either crash or signal listening.
    const timer = setTimeout(() => { child.kill("SIGTERM"); }, 8000);
    once(child, "exit").then(([code]) => {
      clearTimeout(timer);
      resolve({ code: code as number | null, stderr });
    });
  });
}

test("boot REFUSES to start when FLAKEY_ENCRYPTION_KEY is set to a malformed value (wrong length)", async () => {
  // 16 bytes (32 hex chars) — neither hex/32B nor base64/32B; parseKey
  // throws. Previously this passed the presence check at boot and only
  // surfaced on first integration call.
  const { code, stderr } = await runWithKey("0123456789abcdef0123456789abcdef");
  assert.notEqual(code, 0, "server must exit non-zero on malformed key");
  assert.match(
    stderr,
    /FLAKEY_ENCRYPTION_KEY validation failed/,
    "stderr must explain the rejection reason, not surface a generic stack trace",
  );
});

test("boot REFUSES to start when FLAKEY_ENCRYPTION_KEY contains non-hex / non-base64 garbage", async () => {
  const { code, stderr } = await runWithKey("this-is-not-a-real-encryption-key-just-noise");
  assert.notEqual(code, 0);
  assert.match(stderr, /FLAKEY_ENCRYPTION_KEY validation failed/);
});

test("boot REFUSES to start when FLAKEY_ENCRYPTION_KEY_OLD (rotation companion) is malformed", async () => {
  // A typo in the rotation companion would silently break the decrypt
  // read-path until someone happened to hit a v1: ciphertext that
  // needed the old key. Validate both.
  const validKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const { code, stderr } = await runWithKey(validKey, { FLAKEY_ENCRYPTION_KEY_OLD: "garbage-typo" });
  assert.notEqual(code, 0);
  assert.match(stderr, /FLAKEY_ENCRYPTION_KEY validation failed/);
});
