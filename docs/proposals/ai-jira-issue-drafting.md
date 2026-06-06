# Proposal: AI-drafted Jira issues (with review)

**Status:** Proposed — not yet implemented
**Area:** frontend `/errors` page + Jira integration (no backend change for MVP)
**Effort:** Small (wiring; recycles the existing AI cache + an unwired route)

---

## Summary

From the `/errors` detail pane, let a user file a Jira issue for an error group
where the **title and description are pre-drafted** — facts from the error group,
prose from the AI analysis we already compute and cache — and **editable before
posting**. The editable fields are the human-in-the-loop review step.

No new LLM prompt, no new table, **no backend change**. The feature recycles
three things that already exist: the cached failure analysis (`ai_analyses`,
reached via `analyzeError`), the error-group fingerprint already in hand on the
`/errors` page, and the already-built-but-unwired `POST /jira/issues` route.

## Motivation

Today there are only two Jira paths:

1. **Auto-create** (`autoCreateIssuesForRun`, `backend/src/integrations/jira.ts:136`)
   — fire-and-forget after upload, static template, no review, **per failed test**.
2. **Copy-to-clipboard** (`buildSummary("jira")`, `frontend/src/routes/(app)/runs/[id]/+page.svelte:354`)
   — user copies Jira markup and pastes/edits in Jira by hand.

There's no "draft a good ticket for me, let me tweak it, then file it" path —
the high-value, low-risk slot for AI. The AI summary/suggested-fix text is
already generated and cached by `analyzeFailure`; it just never reaches a Jira
description.

## Design principle

**Deterministic facts, AI prose.** The LLM never emits a number, count, or link.
The description is:

- a templated facts block (suite / error code-block / affected tests + files /
  occurrence + run counts / link to the latest run), **plus**
- an `h2. Analysis` section filled from the cached `summary`, `suggested_fix`,
  and `classification`.

This keeps the dashboard's trustworthy-numbers invariant intact and sidesteps
hallucinated metrics.

## Why the surface is `/errors`, not the run page

This is the load-bearing design constraint, so it's stated up front:

- AI analysis and its cache (`ai_analyses`) are keyed by the **error-group
  fingerprint** `md5(error_message || '|' || suite_name)` (`backend/src/routes/analyze.ts:55`,
  `backend/src/routes/errors.ts:29`).
- The `/errors` list already sends that fingerprint **and** all the facts to the
  client on the `ErrorGroup` type (`fingerprint`, `error_message`, `suite_name`,
  `test_titles[]`, `file_paths[]`, `affected_tests`, `affected_runs`,
  `occurrence_count`, `latest_run_id` — `frontend/src/lib/api.ts:208`), and the
  page already calls `analyzeError(fingerprint)`.
- The **run detail page cannot** drive this: a failed `test` in the run payload
  carries no fingerprint, and the browser can't recompute the md5 one
  (`SubtleCrypto` has no MD5). Driving it from there would need a new backend
  endpoint — see Out of scope.

## Fingerprinting & dedup (the part most likely to be gotten wrong)

Two **incompatible** schemes coexist in the codebase:

| Scheme | Formula | Used by |
|---|---|---|
| Error-group | `md5(error_message \|\| '\|' \|\| suite_name)` (hex) | AI analysis, `ai_analyses` cache, `/errors` |
| Jira auto-create | `jira-` + `sha256(file_path::full_title)`[:16] (`integrations/jira.ts:317`) | `autoCreateIssuesForRun` → `failure_jira_issues` |

**MVP dedups on the error-group fingerprint.** `POST /jira/issues` accepts an
arbitrary `fingerprint` string and dedups on `(org_id, fingerprint)` in
`failure_jira_issues`, so passing the error-group md5 just works with no backend
change. The two key spaces never collide (md5-hex vs `jira-`-prefixed), so they
coexist in the table without false dedup.

**Accepted tradeoff:** a manually-filed error-group issue will **not** dedup
against an auto-created per-test issue for the same underlying failure (different
grouping + different key). Acceptable because (a) auto-create is off by default,
and (b) most orgs use one workflow or the other. Called out so it's a decision,
not an accident.

## Current building blocks (all already present)

| Piece | Location | Reused for |
|---|---|---|
| `analyzeFailure()` | `backend/src/ai.ts:108` | the prose (summary / suggested_fix / classification) |
| `POST /analyze/error/:fingerprint` (caches to `ai_analyses`) | `backend/src/routes/analyze.ts:27` | fetch-or-compute + cache the analysis |
| `analyzeError(fingerprint)` client | `frontend/src/lib/api.ts:566` | read the cache from the modal |
| `ErrorGroup` (fingerprint + all facts) | `frontend/src/lib/api.ts:208` | facts block + dedup key, already client-side |
| `POST /jira/issues` (admin-gated, dedups, audits) | `backend/src/routes/jira.ts:114` | create the issue — **currently no frontend caller** |
| static facts template | `backend/src/integrations/jira.ts:157` | shape for the facts block + fallback |

## Build

### 1. Draft assembly — pure helper (the load-bearing piece)

`buildJiraIssueDraft(group: ErrorGroup, analysis?: AIAnalysis) -> { title, description }`,
in `frontend/src/lib/utils/`.

- `title` → deterministic, e.g. `[${group.suite_name}] ${group.test_titles[0]}`
  (or the error's first line when there are many tests).
- `description` → facts block from `group` + the `analysis` fields **when
  present**. When `analysis` is `undefined`, the Analysis section simply isn't
  rendered — that *is* the fallback, no special-casing.

Pure function → unit-testable in vitest. Cases: with-analysis, without-analysis,
single vs many affected tests, Jira-markup escaping of the error message.

### 2. Wire the existing route

Add `createJiraIssue({ summary, description, fingerprint })` to
`frontend/src/lib/api.ts` → POSTs to the existing `/jira/issues`, passing the
error-group `fingerprint`. **No backend change.**

### 3. Review modal (the human-in-the-loop)

A "Create Jira issue" action in the `/errors` detail pane. Opens an overlay
(`frontend/src/lib/components/overlays/`) with **editable** Title + Description
fields pre-filled from `buildJiraIssueDraft`. User edits → Create → toast with
the issue link. The editable fields satisfy both the org "confirm before
creating tickets" rule and guard-rail #6.

Hide the action for `viewer` (the route is admin-gated; don't show a button that
will 403).

### 4. How prose reaches the modal (cost-aware)

- Analysis already cached for this fingerprint → pre-fill prose instantly,
  **zero LLM cost** (`analyzeError` returns the cache; the page may already have
  it in `aiResults`).
- Not cached + AI enabled → a **"Draft with AI"** button in the modal calls
  `analyzeError` (one call, then cached), mirroring the existing "Analyze with
  AI" UX.
- AI disabled or the call fails → modal works with the facts-only template.
  **Issue creation is never blocked.**

## Out of scope (MVP)

- **Per-test filing from the run page.** Needs a new backend endpoint that
  resolves analysis by test identity (server computes the md5) and would dedup on
  the `jira-` fingerprint to match auto-create. Deferred — it's strictly more
  work for a second surface.
- **AI on the auto-create path.** Fire-and-forget in the upload pipeline with no
  review; an inline LLM call there could block uploads and has no review step.
  (Stretch: enrich its template with cached analysis *only if already present*.)
- **AI-generated titles.** Deterministic for MVP — most likely to drift from
  reader expectations. Cheap to add later from the cached summary.

## Compliance / data egress

No new boundary. Error message + test code already reach the configured AI
provider via `analyzeError`, and errors already land in Jira via auto-create.
This feature only reuses both. It does make shipping error text to Jira + the
LLM easier/more visible, so note it in the integrations doc. Loop in the CISO
only if the AI provider is a cloud endpoint rather than local Ollama (SOC 2 /
GovRAMP scope).

## Tests (guard rail 3)

- **Unit (vitest, frontend):** `buildJiraIssueDraft` — the real logic.
- **Backend smoke:** `POST /jira/issues` with a mocked Jira `fetch`; add it if
  the route lacks coverage.
- **No live-Jira e2e:** Jira is external with no local stub, so a live
  round-trip isn't local-first. Test the assembly helper + route boundary
  instead — stated, not silently skipped.

## Docs (guard rail 12)

- `backend/docs/integrations.md` (Jira section) — document the draft-and-review
  create flow + cache reuse, in the same commit as the change.

## Acceptance criteria

- [ ] From the `/errors` detail pane, a user can open a "Create Jira issue" modal
      with pre-filled, editable title + description.
- [ ] When analysis is cached, the description includes the AI prose with no new
      LLM call.
- [ ] When AI is off/unavailable, the modal still creates an issue from the
      facts-only template.
- [ ] Created issues dedupe on the error-group fingerprint via
      `failure_jira_issues` and write an audit row (existing route behavior).
- [ ] The action is hidden for `viewer`.
- [ ] `buildJiraIssueDraft` has unit coverage; `POST /jira/issues` has smoke
      coverage.
- [ ] `backend/docs/integrations.md` updated.

## Open questions

- Accept the dedup tradeoff vs auto-create (per-error-group manual issues don't
  dedup against per-test auto issues), or unify the schemes first? MVP accepts it.
- Title format when an error group spans many tests — first test title, or the
  error's first line?
