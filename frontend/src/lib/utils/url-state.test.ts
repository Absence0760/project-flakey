import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted, so the spy has to come from vi.hoisted.
const { goto } = vi.hoisted(() => ({ goto: vi.fn(() => Promise.resolve()) }));
vi.mock("$app/navigation", () => ({ goto }));

import { replaceUrl } from "./url-state.ts";

describe("replaceUrl", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { location: { href: "http://app.test/runs/7?status=failed" } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    goto.mockClear();
  });

  it("does a shallow, replacing goto when the URL changes", () => {
    const url = new URL("http://app.test/runs/7?status=passed");
    replaceUrl(url);
    expect(goto).toHaveBeenCalledWith(url, { shallow: true, replace: true });
  });

  // An unconditional goto from a mount-time effect raced a back navigation
  // and left the release page unrendered (SvelteKit 3 migration).
  it("does nothing when the URL is unchanged", () => {
    replaceUrl(new URL("http://app.test/runs/7?status=failed"));
    expect(goto).not.toHaveBeenCalled();
  });
});
