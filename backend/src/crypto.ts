import crypto from "crypto";

/**
 * Symmetric envelope encryption for secrets stored in the database.
 *
 * Ciphertext format (string):
 *   v1:<base64 iv>:<base64 authTag>:<base64 ciphertext>
 *
 * The "v1:" prefix lets us tell encrypted values apart from legacy plaintext
 * and supports future key-rotation / algorithm changes.
 *
 * The key is derived from FLAKEY_ENCRYPTION_KEY (32 raw bytes, base64 or hex).
 * If the env var is unset, encryption is a no-op — encrypt() returns the
 * input and decrypt() passes it through. This keeps local dev working.
 */
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const PREFIX = "v1:";

function getKey(): Buffer | null {
  const raw = process.env.FLAKEY_ENCRYPTION_KEY;
  if (!raw) return null;
  // Accept either base64 (44 chars with padding) or hex (64 chars).
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  try {
    const buf = Buffer.from(raw, "base64");
    if (buf.length === 32) return buf;
  } catch {
    /* fall through */
  }
  throw new Error("FLAKEY_ENCRYPTION_KEY must be 32 bytes (base64 or hex)");
}

let cachedKey: Buffer | null | undefined;
function key(): Buffer | null {
  if (cachedKey === undefined) cachedKey = getKey();
  return cachedKey;
}

export function encryptSecret(plaintext: string | null | undefined): string | null {
  if (plaintext == null || plaintext === "") return null;
  const k = key();
  if (!k) return plaintext;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, k, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + iv.toString("base64") + ":" + tag.toString("base64") + ":" + ct.toString("base64");
}

export function decryptSecret(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  if (!value.startsWith(PREFIX)) return value; // legacy plaintext — return as-is
  const k = key();
  if (!k) {
    // We have encrypted data but no key; refuse rather than returning garbage.
    throw new Error("Encrypted value present but FLAKEY_ENCRYPTION_KEY is not set");
  }
  const [, ivB64, tagB64, ctB64] = value.split(":");
  if (!ivB64 || !tagB64 || !ctB64) {
    throw new Error("Malformed encrypted value");
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const decipher = crypto.createDecipheriv(ALGO, k, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}
