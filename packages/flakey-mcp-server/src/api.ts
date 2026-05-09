/**
 * Backend API helper for the MCP server.
 *
 * Extracted from index.ts so the URL + key are parameters (instead of
 * module-level constants read from process.env at import time). That
 * makes the helper testable: a unit test can spin a fresh `Api` with
 * mock fetch and assert request shapes without reaching for env-var
 * gymnastics.
 */

export type Api = (path: string, opts?: RequestInit) => Promise<unknown>;

export function createApi(url: string, apiKey: string): Api {
  const baseUrl = url.replace(/\/$/, "");
  return async function api(path: string, opts?: RequestInit): Promise<unknown> {
    const res = await fetch(`${baseUrl}${path}`, {
      ...opts,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...opts?.headers,
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Flakey API ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  };
}
