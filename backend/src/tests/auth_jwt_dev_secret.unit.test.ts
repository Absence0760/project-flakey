/**
 * Unit test for the JWT dev-fallback secret in auth.ts.
 *
 * The dev fallback used to be the published literal
 * `flakey-dev-secret-change-me`, hard-coded in
 * auth.ts and documented in docs/run-locally.md. Any non-production
 * instance (staging, preview, CI backend) that omits both JWT_SECRET
 * and NODE_ENV=production used that known constant, letting anyone who
 * read the repo forge JWTs. The fix generates a random per-cold-start
 * secret (crypto.randomBytes(32)) instead of a published constant.
 *
 * This pins three guarantees:
 *   1. The old published literal is never the active secret.
 *   2. The dev fallback is a 32-byte (64 hex char) random value.
 *   3. Two cold-starts produce different secrets (proves it's
 *      per-process random, not a new hard-coded constant).
 *
 * We import auth.ts in a fresh subprocess and print getJwtSecret(),
 * matching the subprocess-isolation pattern in encryption_key_boot —
 * the secret is computed once at module load, so a child process is
 * the only way to observe a fresh cold-start value.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

const OLD_PUBLISHED_LITERAL = "flakey-dev-secret-change-me"; // gitleaks:allow — the retired published constant we assert is gone

// Import auth.ts in isolation and print the resolved dev-fallback
// secret. NODE_ENV is forced to "test" and JWT_SECRET is unset so the
// random-fallback branch runs. The pool in db.ts is constructed at
// import but never queried, so the child exits cleanly without a DB.
function resolveDevSecret(): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {
      ...process.env,
      NODE_ENV: "test",
    } as Record<string, string>;
    delete env.JWT_SECRET;
    const code =
      'import("./auth.js").then(m => { process.stdout.write(m.getJwtSecret()); process.exit(0); });';
    const child = spawn("node", ["--import", "tsx", "--eval", code], {
      cwd: new URL("..", import.meta.url),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    once(child, "exit").then(([childCode]) => {
      if (childCode !== 0) {
        reject(new Error(`child exited ${childCode}: ${stderr}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

test("dev JWT fallback is NOT the old published literal", async () => {
  const secret = await resolveDevSecret();
  assert.notEqual(
    secret,
    OLD_PUBLISHED_LITERAL,
    "the dev fallback must not be the published constant — it lets anyone forge JWTs against a non-prod instance",
  );
});

test("dev JWT fallback is a 32-byte random hex value", async () => {
  const secret = await resolveDevSecret();
  assert.match(secret, /^[0-9a-f]{64}$/, "fallback must be 64 hex chars (crypto.randomBytes(32))");
});

test("two cold-starts produce different dev secrets (proves per-process randomness)", async () => {
  const [a, b] = await Promise.all([resolveDevSecret(), resolveDevSecret()]);
  assert.notEqual(a, b, "a fresh random secret per cold-start, not a new hard-coded constant");
});
