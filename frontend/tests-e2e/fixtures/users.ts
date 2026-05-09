import { resolve } from "node:path";

/**
 * Seeded users referenced by Playwright specs.
 *
 * Source of truth: `backend/src/seed.ts`. If the seed changes, update
 * these constants in lockstep — typos fail loudly at the assertion
 * site (e.g. "rejected sign-in") rather than silently as "wrong row".
 *
 * `storageStatePath` is populated by globalSetup (fixtures/auth.ts)
 * and consumed by spec files via `test.use({ storageState: ... })`.
 * The path is absolute so it resolves identically regardless of
 * Playwright's cwd.
 */

export type SeededUser = {
  email: string;
  password: string;
  /** Display name from the seed — useful for asserting nav chrome. */
  name: string;
  /** Org slug from the seed — useful for asserting tenant scope. */
  orgSlug: string;
  role: "admin" | "viewer";
  storageStatePath: string;
};

// .auth/ lives next to playwright.config.ts (one level up from this
// fixtures/ directory). Resolved once at module load.
const STORAGE_DIR = resolve(import.meta.dirname, "..", ".auth");

export const ADMIN_USER: SeededUser = {
  email: "admin@example.com",
  password: "admin",
  name: "Admin",
  orgSlug: "acme",
  role: "admin",
  storageStatePath: resolve(STORAGE_DIR, "admin.json"),
};

export const DEMO_USER: SeededUser = {
  email: "demo@example.com",
  password: "demo123",
  name: "Demo User",
  orgSlug: "demo-team",
  role: "viewer",
  storageStatePath: resolve(STORAGE_DIR, "demo.json"),
};

/**
 * Genuine viewer-role member of Acme Corp (the seed gives ADMIN_USER
 * `owner` and DEMO_USER `owner` of their own org — so prior to this
 * fixture there was no real viewer to assert role-403 enforcement
 * against). Use VIEWER_USER for any "admin-only endpoint must 403 a
 * viewer" assertion.
 */
export const VIEWER_USER: SeededUser = {
  email: "viewer@example.com",
  password: "viewer123",
  name: "Viewer",
  orgSlug: "acme",
  role: "viewer",
  storageStatePath: resolve(STORAGE_DIR, "viewer.json"),
};

export const ALL_USERS: SeededUser[] = [ADMIN_USER, DEMO_USER, VIEWER_USER];
