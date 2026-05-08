import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { chromium, expect, type FullConfig } from "@playwright/test";

import { signIn } from "./helpers";
import { ALL_USERS } from "./users";

/**
 * Playwright globalSetup — runs once before any spec.
 *
 * For each seeded user, sign in via the UI and save the resulting
 * storage state (cookies + localStorage with `bt_token`,
 * `bt_user`, `bt_refresh`) to the path declared in users.ts.
 *
 * Spec files attach a state with:
 *
 *   import { ADMIN_USER } from "./fixtures/users";
 *   test.use({ storageState: ADMIN_USER.storageStatePath });
 *
 * For specs that need an unauthenticated context (the /login surface
 * itself), use:
 *
 *   test.use({ storageState: { cookies: [], origins: [] } });
 *
 * Why sign in via the UI rather than minting tokens directly:
 *   the auth singleton in src/lib/auth.ts owns the localStorage
 *   migration from `flakey_*` → `bt_*` and the refresh-on-401
 *   behaviour. Going through the form exercises the same code path
 *   real users hit, so a regression in `restoreAuth()` or the
 *   refresh handler fails the setup loudly rather than silently
 *   masking under hand-minted state.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL =
    config.projects[0]?.use.baseURL ?? "http://localhost:7777";

  const browser = await chromium.launch();
  try {
    for (const user of ALL_USERS) {
      mkdirSync(dirname(user.storageStatePath), { recursive: true });

      const context = await browser.newContext({ baseURL });
      const page = await context.newPage();

      try {
        await signIn(page, user);
        // The sign-in form's success handler navigates to /dashboard.
        // If the credentials were wrong (seed drift) we'd still be on
        // /login — fail the setup with a clear message rather than
        // letting authenticated specs fail one-by-one.
        await expect(
          page,
          `globalSetup could not sign in ${user.email}; check backend/src/seed.ts and the running backend`,
        ).toHaveURL(/\/dashboard/, { timeout: 15_000 });

        await context.storageState({ path: user.storageStatePath });
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

// Re-export the resolved storage dir so a follow-up cleanup task
// can wipe it without re-deriving the path.
export const STORAGE_DIR = resolve(import.meta.dirname, "..", ".auth");
