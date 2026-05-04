---
description: Sweep user-content rendering paths in the SvelteKit app for XSS-prone patterns
---

Audit the frontend for unsafe HTML rendering of user-supplied content.

## Goal

Test reports are user content. Suite names, full test titles, error messages, error stacks, command logs, run notes, manual-test step descriptions — anything a customer pastes through their reporter or types into the UI flows back into Svelte components. A single `{@html badField}` is a stored-XSS surface for any other tenant who views that run.

## What to check

1. **`{@html ...}` callsites.** Grep `frontend/src/` for `{@html`. Every callsite needs to either:
   - Render a string the app itself produced (e.g. server-rendered markdown), OR
   - Pipe through `DOMPurify.sanitize(...)` from `isomorphic-dompurify` (already a dep)

   The CLAUDE.md or component header should say *why* the raw HTML is needed. Naked `{@html test.error_message}` style is a finding.

2. **User-content fields.** The shape of what's rendered: open `frontend/src/lib/api.ts` and list the string-typed fields on `Run`, `Spec`, `TestResult`, `TestDetail`, `RunDetail`. The risky set:
   - `error_message`, `error_stack` — currently rendered as text inside `<pre>` (good) and inside an inline `.test-error-bar` (also text). Confirm no `{@html}` on these anywhere.
   - `full_title`, `title`, `suite_name` — text content
   - `command_log` (JSON object array) — confirm rendering is per-field, not stringified-and-htmlized
   - `metadata.error_snippet` (Playwright) — has ANSI / source-code formatting; if it's being syntax-highlighted, confirm the highlighter doesn't interpret HTML

3. **Markdown rendering.** Anywhere `mdsvex` or a markdown renderer is used (the dep is in `frontend/package.json`), confirm the input is either statically authored (`.md` files in the repo) or sanitized. User-typed run notes / manual test descriptions rendered as markdown are XSS surfaces unless the renderer strips HTML.

4. **`href` / `src` injection.** Any computed `href={...}` or `src={...}` from user input must reject `javascript:` and `data:` schemes (other than safe `data:image/...`). The Jira / GitHub / GitLab issue-link rendering takes a URL from org config — if that's rendered as `<a href={org.jira_base_url + ...}>`, a malicious `javascript:` URL pasted into the integration settings would fire on render.

5. **CSP.** `backend/src/index.ts` has `app.use(helmet({ contentSecurityPolicy: false }))` — CSP is currently disabled. Flag this as a defence-in-depth gap (Medium): even if the app's sanitization is perfect, CSP would catch a future regression. The reason CSP is off is probably the SSE / inline-script chain — if so, document it in the CLAUDE.md.

6. **SVG uploads.** Any path that accepts an upload should refuse `image/svg+xml` if the file gets served back inline (browsers execute `<script>` tags inside SVG when the response is rendered as HTML, not when it's `Content-Disposition: attachment`). Cross-reference `audit/storage-paths` step 6.

7. **Iframe / object embeds.** Search for `<iframe`, `<object`, `<embed` in components — none should receive a user-supplied URL.

## Report

- **Critical** — `{@html userField}` without sanitization; computed `href` accepts `javascript:` / unsafe `data:`.
- **High** — markdown renderer enabled on user-supplied content without HTML stripping.
- **Medium** — CSP disabled with no documented reason; SVG upload returned with `Content-Type: image/svg+xml` for inline rendering.
- **Low** — undocumented intent on a sanitized `{@html}` callsite.

For each: file:line + the field rendered + the resulting payload that fires.

## Useful starting points

- `frontend/src/` — `grep -rn "{@html" frontend/src`
- `frontend/src/lib/api.ts` — type definitions, the catalog of "what's user content"
- `frontend/src/lib/components/ErrorModal.svelte` — the most user-content-heavy component (renders error_message, error_stack, command_log, screenshots, video)
- `frontend/src/routes/(app)/runs/[id]/+page.svelte` — the inline error bar (currently text-only after issue #22 fix; confirm it stayed that way)
- `backend/src/index.ts` — CSP setting
- `frontend/package.json` — verifies `isomorphic-dompurify` is the sanitizer

## Delegate to

Use the `flakey-auditor` agent: `"Audit user-content rendering paths in the SvelteKit app for XSS-prone patterns."` Read-only.
