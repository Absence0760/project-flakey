// Validates user-supplied reference URLs (e.g. `manual_test_requirements.ref_url`,
// `release_test_session_results.known_issue_ref`). Rejects `javascript:`,
// `data:`, `vbscript:`, `file:`, etc. — anything that turns into a stored XSS
// when rendered as an `<a href>` on the dashboard.
//
// Returns the canonicalised URL string on success or `null` on rejection.
// `allowPlainKey: true` returns the trimmed input unchanged when it doesn't
// parse as a URL — for fields that legitimately accept either a plain
// identifier (e.g. `JIRA-123`) or a URL.
export function validateRefUrl(
  input: unknown,
  opts: { allowPlainKey?: boolean } = {},
): { ok: true; value: string | null } | { ok: false; reason: string } {
  if (input === null || input === undefined || input === "") {
    return { ok: true, value: null };
  }
  if (typeof input !== "string") {
    return { ok: false, reason: "ref must be a string" };
  }
  const trimmed = input.trim();
  if (trimmed === "") return { ok: true, value: null };

  // If the string looks like a URL (has a scheme), enforce http(s).
  // The regex matches `<scheme>:` at the start. URL.parse won't reject
  // `javascript:alert(1)` on its own, so the gate has to be on the
  // protocol property after parsing.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return { ok: false, reason: "ref is not a valid URL" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, reason: "ref URL must use http or https" };
    }
    return { ok: true, value: parsed.toString() };
  }

  // No scheme — either reject or accept as a plain key, depending on caller.
  if (opts.allowPlainKey) return { ok: true, value: trimmed };
  return { ok: false, reason: "ref must be an http or https URL" };
}
