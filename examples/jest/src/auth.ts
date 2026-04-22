/**
 * Pure utility functions mirroring the sample app's auth logic.
 * No network calls — safe to test in-process.
 */

export interface Credentials {
  email: string;
  password: string;
}

const VALID_EMAIL = "admin@test.com";
const VALID_PASSWORD = "password";

export type LoginResult =
  | { success: true; token: string }
  | { success: false; error: string };

export function login(creds: Credentials): LoginResult {
  if (!creds.email) return { success: false, error: "Email is required" };
  if (!creds.password) return { success: false, error: "Password is required" };
  if (creds.email !== VALID_EMAIL || creds.password !== VALID_PASSWORD) {
    return { success: false, error: "Invalid credentials" };
  }
  // Deterministic stub token — not real auth
  return { success: true, token: `stub-token-${creds.email}` };
}

export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function parseToken(token: string): { email: string } | null {
  const match = token.match(/^stub-token-(.+)$/);
  return match ? { email: match[1] } : null;
}
