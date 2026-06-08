# `.claude/` — slash commands and agents for project-flakey

Project-curated extensions Claude Code loads when invoked from this repo:

- **Agents** (`.claude/agents/`) — specialised personas with their own tool allowlists. You don't invoke these directly; the slash commands delegate to them.
- **Slash commands** (`.claude/commands/`) — typed at the prompt as `/audit/<name>` (or `/<name>` at the top level). Each is a self-contained task that loads the file body as instructions.

This folder ships with:

- A suite of read-only audit commands under `/audit/*` (broad, periodic sweeps), driven by the `flakey-auditor` agent.
- A pre-commit gate `/check` and a coder ↔ reviewer loop `/safe-edit` (per-change, focused), driven by the `code-reviewer`, `test-gap-checker`, and `doc-hygiene-checker` agents.

All commands are read-only by default — they report findings or hand off to the user, they don't apply fixes without explicit confirmation.

---

## Per-change commands

Use these on the diff you're about to commit. They're cheaper and more focused than `/audit/*`.

| Command | Use when… | Cost |
|---|---|---|
| **`/check`** | Right before committing a non-trivial change. Spawns `code-reviewer` + `test-gap-checker` + `doc-hygiene-checker` in parallel, aggregates a single advisory report. Single pass — no fix-and-re-review loop. The user picks which gaps to land. | ~1x review cost |
| **`/safe-edit <task>`** | Implementing a security-sensitive, schema, live-flow, or reporter-package change you want a second pair of eyes on before commit. Coder → `code-reviewer` round 1 → fix → round 2 → ready-to-commit handoff. Hard cap at 2 review cycles. | ~2-3x edit cost |
| **`/polish-ui <target>`** | An index page or component whose layout doesn't fit the data — flat card list when it should be master/detail, missing filter tabs / URL state / friendly dates, drifting alignment, raw ISO leaks, redundant h1. Delegates to `ui-polisher` which audits, picks an archetype (table / master-detail / heatmap / bars / cards), edits, and verifies with `pnpm check` + screenshots + e2e. Does not commit. | ~2-3x edit cost (screenshot + e2e re-run + agent context) |

Skip all three on typos, comment-only edits, dep-version bumps, or any < ~10-line diff that touches no invariant — just edit those directly.

## Spot-audit-and-fix

`/audit-and-fix [area]` is the odd one out: it doesn't operate on an existing diff — it **picks an area** (whatever you name, or one it chooses by ranking under-covered × bug-prone × logic-dense modules), audits it for real correctness bugs, fixes the root cause, and ships unit/smoke/e2e coverage with the fix. Lands scoped commits (fix + tests separately); never pushes. Honest about non-findings — if the area is sound, the deliverable is the test-coverage gap it closed, not an invented fix. Reach for it as a proactive hardening pass over a corner of the app, not as a pre-commit gate (that's `/check`).

## Audit commands

Run from a Claude Code session in this repo. Each is a short prompt that ends with "delegate to the `flakey-auditor` agent" (or another agent type for non-security audits) — Claude reads the command, spawns the right agent, returns a findings report grouped by severity (Critical / High / Medium / Low), and lists `## Clean` for areas that came up empty.

The full index lives in [`.claude/commands/audit/README.md`](commands/audit/README.md). Quick reference:

### Dispatcher

| Command | Use when… |
|---|---|
| **`/audit/all`** | You want the full sweep. Optional arg `security` / `invariants` / `health` limits the scope. Spawns one agent per area in parallel and consolidates a single report. Run before tagging a release. |

### Security (5 commands)

| Command | Use when… | Key starting points it inspects |
|---|---|---|
| **`/audit/auth`** | After adding a new Express route or moving where `requireAuth` is applied. | `backend/src/index.ts` (router mounts), `backend/src/auth.ts` (`requireAuth`), `backend/src/db.ts` (`tenantQuery`/`tenantTransaction`) |
| **`/audit/multi-tenant`** | After a new migration that adds a tenant table, or after touching any policy. | `backend/migrations/`, RLS coverage, cross-org reachability on `:runId` handlers |
| **`/audit/storage-paths`** | After adding a new upload endpoint or changing the storage backend. | `backend/src/routes/uploads.ts`, `backend/src/routes/live.ts`, `backend/src/storage.ts` |
| **`/audit/secrets`** | After bumping deps, adding an integration, or before a release. Sweeps `JWT_SECRET`, `FLAKEY_ENCRYPTION_KEY`, `bt_*` localStorage, GitHub Actions env handling, and git history for committed secrets. | `backend/src/auth.ts`, `backend/src/crypto.ts`, `frontend/src/lib/auth.ts`, `.github/workflows/`, `.env*` |
| **`/audit/xss`** | After adding a new component that renders user-supplied content (suite names, error messages, run notes, manual-test descriptions). | `{@html}` callsites in `frontend/src/`, `ErrorModal.svelte`, helmet CSP setting |

### Invariants (3 commands)

| Command | Use when… | Key starting points it inspects |
|---|---|---|
| **`/audit/migrations`** | After adding a migration. Verifies `IF NOT EXISTS` idempotency, RLS-on-every-tenant-table, and type drift between `backend/src/types.ts`, `frontend/src/lib/api.ts`, and the actual columns. | `backend/migrations/*.sql`, `backend/src/types.ts`, `frontend/src/lib/api.ts` |
| **`/audit/live-flow`** | After touching the live-event path, the upload merge, or `LiveClient` / `LiveEventBus`. Verifies uniqueness fences, `spec.finished` recompute, screenshot/snapshot preservation across the upload merge in **both** `/runs` and `/runs/upload`, heartbeat behavior. | `backend/src/routes/live.ts`, `routes/runs.ts`, `routes/uploads.ts`, `run-merge.ts`, `live-events.ts`, `packages/flakey-live-reporter/src/` |
| **`/audit/reporters`** | After adding a reporter package or changing env-var resolution / `exports` map / peer deps. | `packages/*/package.json`, `packages/*/src/index.ts`, `packages/*/CLAUDE.md` |

### Health (3 commands)

| Command | Use when… | Notes |
|---|---|---|
| **`/audit/deps`** | After bumping a major dependency, before a release, or periodically. Runs `npm audit` (backend) and `pnpm audit` (frontend + workspace). Also flags floating GitHub Actions refs (`@v1`) on workflows that touch secrets. | Spawns a `general-purpose` agent — no domain conventions needed. |
| **`/audit/infra`** | Before any `terraform apply` or after editing anything under `infra/`. Walks the AWS Terraform stacks for OIDC trust hardening, IAM least-privilege, RDS / S3 / ECS / ECR / CloudFront / Secrets Manager hygiene, per-env naming. | `general-purpose` agent. Does **not** run `terraform plan` — read-only. |
| **`/audit/docs-drift`** | After a sweep of code changes (especially endpoint, schema, or env-var changes). Surveys `README.md`, `docs/*.md`, and per-package `CLAUDE.md` for stale references. | Spawns an `Explore` agent (broad read-only scan). |

---

## How to invoke

At the prompt, type `/audit/<name>`. Some examples:

```
/audit/all                          # full sweep, parallel
/audit/all security                 # security subset only
/audit/migrations                   # after a new migration
/audit/live-flow                    # after touching the live path
/audit/auth                         # after adding a new route
```

Output shape (per command):

```
## Critical (N)
- [audit/<area>] file:line — <one-line>

## High (N)
...

## Clean
- audit/<area> — no findings
```

`/audit/all` consolidates findings across every area into a single report with the same shape, plus a "Recommended order" of fixes.

---

## When to run which

| Situation | Audits to run |
|---|---|
| **Before tagging a release** | `/audit/all` |
| **After a sweeping refactor** | `/audit/migrations` + `/audit/live-flow` + `/audit/auth` |
| **After a new migration** | `/audit/migrations` + `/audit/multi-tenant` |
| **After a new live-route endpoint** | `/audit/live-flow` + `/audit/auth` + `/audit/storage-paths` |
| **After a new reporter package or option** | `/audit/reporters` + `/audit/docs-drift` |
| **After a dependency major bump** | `/audit/deps` + `/audit/secrets` |
| **After editing anything under `infra/`** | `/audit/infra` (before `terraform apply`) |
| **Periodically (monthly)** | `/audit/all` |

---

## The agents

### `flakey-auditor`

[`.claude/agents/flakey-auditor.md`](agents/flakey-auditor.md) — read-only auditor with the project's conventions baked in:

- The four trust boundaries: DB↔caller (RLS via `tenantQuery`), API↔caller (`requireAuth`), Storage↔paths, client-bundle↔runtime
- Repo layout: `backend/` npm, `frontend/` pnpm-not-workspace, `packages/*` pnpm workspace, `infra/` Terraform
- The "Flakey" UI / `@flakeytesting/*` npm-scope / `project-flakey` repo-dir naming layers (intentional, not drift — won't be flagged)
- The existing legitimate `pool.query` callsites (auth, integrations, retention, scheduled-reports, badge, connectivity, coverage settings, health) — won't be false-flagged for cross-org reads

You don't invoke this agent directly; the audit commands do. If you want to write a new audit, model it on one of the existing files — they all follow the same shape (frontmatter description → goal → "what to check" numbered list → severity rubric → starting points → "delegate to" line).

### `code-reviewer`

[`.claude/agents/code-reviewer.md`](agents/code-reviewer.md) — review-only agent invoked by `/safe-edit` (in a fix loop) and by `/check` (single pass). Reads `git diff`, cross-references the project's invariants (the four trust boundaries, live-flow rules, reporter-package shape, Svelte 5 runes, Flakey rebrand layers, house style), outputs concrete numbered file:line findings the coder should apply. Read-only — never edits. Strict output format that the orchestrator parses (`Status: CLEAN | NEEDS_CHANGES`, capped at 5 findings).

### `test-gap-checker`

[`.claude/agents/test-gap-checker.md`](agents/test-gap-checker.md) — invoked by `/check`. Reads the working diff and reports which `*.unit.test.ts` / `*.smoke.test.ts` should ship with each modified backend source file. Frontend has pure-helper vitest unit tests (`frontend/src/**/*.test.ts`); the agent does not flag missing frontend component/render tests. Skips trivial diffs. Reports only — does not write tests.

### `doc-hygiene-checker`

[`.claude/agents/doc-hygiene-checker.md`](agents/doc-hygiene-checker.md) — invoked by `/check`. Surveys the project's doc set (`README.md`, `docs/architecture.md`, `docs/overview.md`, `docs/run-locally.md`, `docs/roadmap.md`, root + per-app + per-package `CLAUDE.md`) against the diff and reports which docs need updating. Reports only — does not edit docs.

### `ui-polisher`

[`.claude/agents/ui-polisher.md`](agents/ui-polisher.md) — invoked by `/polish-ui`. Edits one page or component to the project's UI quality bar (the same bar set by `/manual-tests`, `/`, `/flaky`, `/slowest`, `/errors`, `/releases`). Bakes in the design language: data-archetype → layout (table / master-detail / heatmap / bars / cards), natural-width tables, status accent stripes, at-risk pinned bands, `relativeDate()` everywhere, modal create flows, URL-bookmarkable filters, Svelte 5 runes only. Captures before/after screenshots via Playwright, type-checks with `pnpm check`, and updates any e2e selectors the redesign moves. Edits files; never commits.

---

## Conventions

- **Read-only by default.** The deliverable is a findings report, not a diff. Don't apply fixes without explicit confirmation.
- **Findings cite the rule's source.** When a finding violates a documented convention, the report names the file (`backend/CLAUDE.md`, `frontend/CLAUDE.md`, `docs/architecture.md`) so you can trace what rule got broken.
- **No emojis. No comments. No preemptive abstractions.** Root `CLAUDE.md` rules apply to anything the auditor (or a fix you make based on its report) writes.
- **Severity rubric** (consistent across audits):
  - **Critical** — known-exploited or trivially exploitable; multi-tenant data crossing org boundaries; secret in git history; deploy-time blast radius.
  - **High** — privileged work without auth; private data reachable by unauthenticated caller; broken invariant that corrupts run data.
  - **Medium** — overscoped policy or missing input validation; principle-of-least-privilege violation with no concrete leak today.
  - **Low** — undocumented intent, defence-in-depth gap behind a working primary control, drift between docs and code.

---

## Adding a new audit

1. Create `.claude/commands/audit/<name>.md` with the same shape as an existing one (frontmatter → goal → checks → severity → starting points → delegate line).
2. Add the row to `.claude/commands/audit/README.md` under the right category.
3. Add the row to this file's [Audit commands](#audit-commands) table.
4. If `/audit/all` should pick it up, add it to the right area block in `.claude/commands/audit/all.md`.
5. If the audit is truly novel (i.e. doesn't fit `flakey-auditor`'s trust-boundary table), update the agent file with the new area in the routing table — otherwise the agent will say "not my lane."

## Choosing between `/check`, `/safe-edit`, and `/audit/*`

| Situation | Reach for |
|---|---|
| About to commit any non-trivial change | `/check` |
| Implementing a security-sensitive / schema / live-flow / reporter-package change | `/safe-edit <task>` (also produces a clean status by the time you'd run `/check`, so don't double up) |
| An index page or modal that doesn't use real estate, leaks ISO dates, or lacks the project's filter / sort / search / URL-state pattern | `/polish-ui <route or component>` |
| Periodic broad sweep over the whole repo against one trust boundary | `/audit/<name>` |
| Proactively harden one corner of the app — audit it, fix real bugs, ship tests | `/audit-and-fix [area]` |
| Pre-release confidence pass | `/audit/all` |
| Typo / comment / single-line dep bump | none — just commit |
