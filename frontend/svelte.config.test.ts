import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Structural guard for the CSP directives in svelte.config.js.
 *
 * Artifacts and API data are served from the API origin — a DIFFERENT
 * origin from the SPA (api.* vs the CloudFront host in prod; :3000 vs :7778
 * in dev). The browser silently blocks any resource an origin isn't
 * allow-listed for, per directive:
 *   - connect-src omits it → every fetch fails → blank dashboard (fixed once
 *     in 7375c69 as a "regression").
 *   - img-src omits it → every screenshot is a broken image (the twin of the
 *     above that 7375c69 missed; fixed in d962133).
 *   - media-src omits it → failure videos won't play.
 *
 * Each of those was a hardcoded `'self'`-only directive that no test
 * covered, because the suite asserts the artifact INGESTION contract
 * (upload → DB key → API response) and never RENDERS an artifact in a
 * browser. This test guards the whole class structurally: every directive
 * that loads from the API must carry the API origin, and the per-origin
 * env extensions (PUBLIC_CSP_*_SRC) must flow through.
 */

const API = "https://api.test.example";

async function loadDirectives(
  env: Record<string, string> = {},
): Promise<Record<string, string[]>> {
  vi.resetModules();
  const saved = { ...process.env };
  process.env.VITE_API_URL = API;
  // Clear any inherited PUBLIC_CSP_* so each case starts from a known state.
  delete process.env.PUBLIC_CSP_CONNECT_SRC;
  delete process.env.PUBLIC_CSP_IMG_SRC;
  delete process.env.PUBLIC_CSP_MEDIA_SRC;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try {
    const mod = await import("./svelte.config.js");
    // @ts-expect-error — kit.csp.directives is loosely typed in the config.
    return mod.default.kit.csp.directives as Record<string, string[]>;
  } finally {
    process.env = saved;
  }
}

describe("svelte.config.js CSP directives", () => {
  afterEach(() => vi.resetModules());

  // The core invariant: every API-loading directive carries the API origin.
  for (const directive of ["connect-src", "img-src", "media-src"] as const) {
    it(`${directive} includes the API origin`, async () => {
      const directives = await loadDirectives();
      expect(directives[directive]).toContain(API);
    });
  }

  it("img-src / media-src keep their self + data/blob bases", async () => {
    const directives = await loadDirectives();
    expect(directives["img-src"]).toEqual(
      expect.arrayContaining(["'self'", "data:", "blob:"]),
    );
    expect(directives["media-src"]).toEqual(
      expect.arrayContaining(["'self'", "blob:"]),
    );
  });

  it("PUBLIC_CSP_*_SRC extensions flow into their directives", async () => {
    const directives = await loadDirectives({
      PUBLIC_CSP_IMG_SRC: "https://cdn.example",
      PUBLIC_CSP_MEDIA_SRC: "https://media.example",
      PUBLIC_CSP_CONNECT_SRC: "https://analytics.example",
    });
    expect(directives["img-src"]).toContain("https://cdn.example");
    expect(directives["media-src"]).toContain("https://media.example");
    expect(directives["connect-src"]).toContain("https://analytics.example");
    // The API origin is still present alongside the extension.
    expect(directives["img-src"]).toContain(API);
  });
});
