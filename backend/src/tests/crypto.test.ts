import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  encryptSecret,
  decryptSecret,
  rotateSecret,
  isEncrypted,
  _resetKeyCache,
} from "../crypto.js";

function newKey(): string {
  return crypto.randomBytes(32).toString("base64");
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  _resetKeyCache();
  try {
    return fn();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    _resetKeyCache();
  }
}

test("encrypt/decrypt round-trips under a single key", () => {
  withEnv({ FLAKEY_ENCRYPTION_KEY: newKey(), FLAKEY_ENCRYPTION_KEY_OLD: undefined }, () => {
    const ct = encryptSecret("hunter2");
    assert.ok(ct && isEncrypted(ct));
    assert.equal(decryptSecret(ct), "hunter2");
  });
});

test("no key set — passthrough", () => {
  withEnv({ FLAKEY_ENCRYPTION_KEY: undefined, FLAKEY_ENCRYPTION_KEY_OLD: undefined }, () => {
    assert.equal(encryptSecret("plain"), "plain");
    assert.equal(decryptSecret("plain"), "plain");
  });
});

test("decrypt falls back to old key when primary cannot authenticate", () => {
  const oldKey = newKey();
  const newerKey = newKey();

  // Encrypt with what will become the "old" key.
  const stored = withEnv(
    { FLAKEY_ENCRYPTION_KEY: oldKey, FLAKEY_ENCRYPTION_KEY_OLD: undefined },
    () => encryptSecret("sekrit")
  );
  assert.ok(stored);

  // Rotate env: primary is new, old is secondary. Decrypt should still work.
  withEnv({ FLAKEY_ENCRYPTION_KEY: newerKey, FLAKEY_ENCRYPTION_KEY_OLD: oldKey }, () => {
    assert.equal(decryptSecret(stored), "sekrit");
  });
});

test("decrypt fails when neither key authenticates", () => {
  const writeKey = newKey();
  const wrongA = newKey();
  const wrongB = newKey();

  const stored = withEnv(
    { FLAKEY_ENCRYPTION_KEY: writeKey, FLAKEY_ENCRYPTION_KEY_OLD: undefined },
    () => encryptSecret("nope")
  );
  assert.ok(stored);

  withEnv({ FLAKEY_ENCRYPTION_KEY: wrongA, FLAKEY_ENCRYPTION_KEY_OLD: wrongB }, () => {
    assert.throws(() => decryptSecret(stored), /Decryption failed/);
  });
});

test("rotateSecret re-encrypts values written under the old key", () => {
  const oldKey = newKey();
  const newerKey = newKey();

  const originalCt = withEnv(
    { FLAKEY_ENCRYPTION_KEY: oldKey, FLAKEY_ENCRYPTION_KEY_OLD: undefined },
    () => encryptSecret("my-token")!
  );

  withEnv({ FLAKEY_ENCRYPTION_KEY: newerKey, FLAKEY_ENCRYPTION_KEY_OLD: oldKey }, () => {
    const { value, rotated } = rotateSecret(originalCt);
    assert.equal(rotated, true);
    assert.ok(value && value !== originalCt);
    // New ciphertext should decrypt under the new key only — and still produce "my-token".
    assert.equal(decryptSecret(value), "my-token");
  });

  // The rotated value must NOT decrypt under the old key alone anymore.
  withEnv({ FLAKEY_ENCRYPTION_KEY: oldKey, FLAKEY_ENCRYPTION_KEY_OLD: undefined }, () => {
    const rotated = withEnv(
      { FLAKEY_ENCRYPTION_KEY: newerKey, FLAKEY_ENCRYPTION_KEY_OLD: oldKey },
      () => rotateSecret(originalCt).value!
    );
    assert.throws(() => decryptSecret(rotated), /Decryption failed/);
  });
});

test("rotateSecret is a no-op for values already current", () => {
  const key = newKey();
  withEnv({ FLAKEY_ENCRYPTION_KEY: key, FLAKEY_ENCRYPTION_KEY_OLD: undefined }, () => {
    const ct = encryptSecret("already-current")!;
    const { value, rotated } = rotateSecret(ct);
    assert.equal(rotated, false);
    assert.equal(value, ct);
  });
});

test("rotateSecret is a no-op for null and plaintext values", () => {
  const key = newKey();
  withEnv({ FLAKEY_ENCRYPTION_KEY: key, FLAKEY_ENCRYPTION_KEY_OLD: undefined }, () => {
    assert.deepEqual(rotateSecret(null), { value: null, rotated: false });
    assert.deepEqual(rotateSecret(""), { value: null, rotated: false });
    assert.deepEqual(rotateSecret("legacy-plaintext"), { value: "legacy-plaintext", rotated: false });
  });
});
