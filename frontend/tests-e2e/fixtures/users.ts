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

/**
 * Worker tenants for parallel Playwright execution.
 *
 * Each Playwright worker (parallelIndex 0..N-1) signs in as the
 * matching WORKER_USERS[parallelIndex] and operates exclusively on
 * its dedicated org (`acme-w<i>`). The seed (`npm run seed` in
 * backend/) creates the same playground data inside each worker org
 * that Acme has, so any spec can run against any worker tenant.
 *
 * Source of truth: the WORKER_TENANT_COUNT loop in backend/src/seed.ts.
 * Adjust E2E_WORKER_TENANTS (seed) AND playwright.config.ts workers
 * in lockstep — they must match.
 *
 * `name` mirrors the seed: `Worker <i> Admin`. `role` is 'admin' so
 * specs that exercise admin-only paths (settings, releases, manual
 * tests) work without needing the original ADMIN_USER. Worker admins
 * are NOT a substitute for VIEWER_USER (which carries org_members.role
 * = 'viewer'); use VIEWER_USER for role-403 assertions as before.
 */
export const WORKER_TENANT_COUNT = 4;

export const WORKER_USERS: SeededUser[] = Array.from(
  { length: WORKER_TENANT_COUNT },
  (_, i): SeededUser => ({
    email: `admin+w${i}@example.com`,
    password: `worker${i}123`,
    name: `Worker ${i} Admin`,
    orgSlug: `acme-w${i}`,
    role: "admin",
    storageStatePath: resolve(STORAGE_DIR, `worker-${i}.json`),
  }),
);

/** Every seeded user, primary + worker tenants. Used by globalSetup. */
export const ALL_SEEDED_USERS: SeededUser[] = [...ALL_USERS, ...WORKER_USERS];
