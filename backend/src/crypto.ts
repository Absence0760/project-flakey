import crypto from "crypto";

/**
 * Symmetric envelope encryption for secrets stored in the database.
 *
 * Ciphertext format (string):
 *   v1:<base64 iv>:<base64 authTag>:<base64 ciphertext>
 *
 * The "v1:" prefix lets us tell encrypted values apart from legacy plaintext.
 *
 * Keys are 32 raw bytes supplied via env (base64 or hex):
 *   FLAKEY_ENCRYPTION_KEY      — primary key. Used for all new writes.
 *   FLAKEY_ENCRYPTION_KEY_OLD  — optional previous key. Only used for reads,
 *                                as a fallback when the primary key fails
 *                                to authenticate the ciphertext.
 *
 * If both env vars are unset, encryption is a no-op — encrypt() returns the
 * input and decrypt() passes it through. This keeps local dev working.
 */
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const PREFIX = "v1:";

function parseKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  const buf = Buffer.from(raw, "base64");
  if (buf.length === 32) return buf;
  throw new Error("Encryption key must be 32 bytes (base64 or hex)");
}

let cachedPrimary: Buffer | null | undefined;
let cachedOld: Buffer | null | undefined;

function primaryKey(): Buffer | null {
  if (cachedPrimary === undefined) cachedPrimary = parseKey(process.env.FLAKEY_ENCRYPTION_KEY);
  return cachedPrimary;
}

function oldKey(): Buffer | null {
  if (cachedOld === undefined) cachedOld = parseKey(process.env.FLAKEY_ENCRYPTION_KEY_OLD);
  return cachedOld;
}

/** Reset cached keys. For tests that mutate process.env between runs. */
export function _resetKeyCache(): void {
  cachedPrimary = undefined;
  cachedOld = undefined;
}

export function encryptSecret(plaintext: string | null | undefined): string | null {
  if (plaintext == null || plaintext === "") return null;
  const k = primaryKey();
  if (!k) return plaintext;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, k, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + iv.toString("base64") + ":" + tag.toString("base64") + ":" + ct.toString("base64");
}

function tryDecrypt(k: Buffer, iv: Buffer, tag: Buffer, ct: Buffer): string | null {
  try {
    const decipher = crypto.createDecipheriv(ALGO, k, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function decryptSecret(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  if (!value.startsWith(PREFIX)) return value; // legacy plaintext — return as-is

  const primary = primaryKey();
  const old = oldKey();
  if (!primary && !old) {
    throw new Error("Encrypted value present but no FLAKEY_ENCRYPTION_KEY is set");
  }

  const [, ivB64, tagB64, ctB64] = value.split(":");
  if (!ivB64 || !tagB64 || !ctB64) throw new Error("Malformed encrypted value");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");

  if (primary) {
    const plain = tryDecrypt(primary, iv, tag, ct);
    if (plain !== null) return plain;
  }
  if (old) {
    const plain = tryDecrypt(old, iv, tag, ct);
    if (plain !== null) return plain;
  }
  throw new Error("Decryption failed under all configured keys");
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/**
 * Re-encrypt a value under the primary key. Used by the rotation script.
 * Returns `{ value, rotated }`:
 *   - value: the (possibly-updated) stored value
 *   - rotated: true if the value was decrypted-and-re-encrypted, false if
 *     it was left alone (null/empty, plaintext passthrough, or already
 *     encrypted under the primary key)
 */
export function rotateSecret(value: string | null | undefined): { value: string | null; rotated: boolean } {
  if (value == null || value === "") return { value: null, rotated: false };
  if (!value.startsWith(PREFIX)) return { value, rotated: false };

  const primary = primaryKey();
  if (!primary) throw new Error("Cannot rotate: FLAKEY_ENCRYPTION_KEY is not set");

  const [, ivB64, tagB64, ctB64] = value.split(":");
  if (!ivB64 || !tagB64 || !ctB64) throw new Error("Malformed encrypted value");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");

  // If the primary already decrypts this cleanly, it's already current — no-op.
  if (tryDecrypt(primary, iv, tag, ct) !== null) {
    return { value, rotated: false };
  }

  const old = oldKey();
  if (!old) {
    throw new Error(
      "Value is not readable under the primary key and FLAKEY_ENCRYPTION_KEY_OLD is not set"
    );
  }
  const plain = tryDecrypt(old, iv, tag, ct);
  if (plain === null) throw new Error("Decryption failed under both primary and old keys");

  return { value: encryptSecret(plain), rotated: true };
}
