import { describe, it, expect, vi, beforeEach } from "vitest";

// artifactSrc resolves the auth token via getToken() from the auth singleton.
// We can't exercise the real singleton (it touches localStorage), so we mock
// the auth module and drive getToken()'s return per-test. authFetch is also
// exported from that module and imported by api.ts, so the factory must
// provide it too (even though artifactSrc never calls it).
// vi.mock is hoisted above module-level declarations, so the mock fn must be
// created via vi.hoisted to be available inside the (also-hoisted) factory.
const { getToken } = vi.hoisted(() => ({ getToken: vi.fn<() => string | null>() }));
vi.mock("./stores/auth", () => ({
  getToken,
  authFetch: vi.fn(),
}));

import { artifactSrc, UPLOADS_URL } from "./api.js";

describe("artifactSrc", () => {
  beforeEach(() => {
    getToken.mockReset();
  });

  it("returns '' for null/undefined/empty input", () => {
    getToken.mockReturnValue("tok");
    expect(artifactSrc(null)).toBe("");
    expect(artifactSrc(undefined)).toBe("");
    expect(artifactSrc("")).toBe("");
  });

  it("passes absolute http(s) URLs through untouched", () => {
    getToken.mockReturnValue("tok");
    const presigned =
      "https://bucket.s3.amazonaws.com/runs/42/screenshots/foo.png?X-Amz-Signature=abc";
    expect(artifactSrc(presigned)).toBe(presigned);
    expect(artifactSrc("http://cdn.example/img.png")).toBe(
      "http://cdn.example/img.png",
    );
  });

  it("appends ?token= to a relative path when logged in", () => {
    getToken.mockReturnValue("my-token");
    expect(artifactSrc("runs/42/screenshots/foo.png")).toBe(
      `${UPLOADS_URL}/runs/42/screenshots/foo.png?token=my-token`,
    );
  });

  it("appends &token= when the path already carries a query string", () => {
    getToken.mockReturnValue("my-token");
    expect(artifactSrc("runs/42/video.mp4?v=2")).toBe(
      `${UPLOADS_URL}/runs/42/video.mp4?v=2&token=my-token`,
    );
  });

  it("URL-encodes the token", () => {
    getToken.mockReturnValue("a/b+c=d");
    expect(artifactSrc("runs/1/x.png")).toBe(
      `${UPLOADS_URL}/runs/1/x.png?token=a%2Fb%2Bc%3Dd`,
    );
  });

  it("omits the token entirely when logged out", () => {
    getToken.mockReturnValue(null);
    expect(artifactSrc("runs/42/screenshots/foo.png")).toBe(
      `${UPLOADS_URL}/runs/42/screenshots/foo.png`,
    );
  });

  it("builds against the configured uploads base", () => {
    // UPLOADS_URL is derived from API_URL (default http://localhost:3000 in test).
    expect(UPLOADS_URL.endsWith("/uploads")).toBe(true);
    getToken.mockReturnValue(null);
    expect(artifactSrc("runs/7/a.png").startsWith(`${UPLOADS_URL}/`)).toBe(true);
  });
});
