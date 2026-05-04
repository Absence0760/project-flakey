# Audit commands

Project-curated slash commands for running security and invariant audits across the project-flakey monorepo. Each is read-only by default — they report findings, they don't apply fixes without explicit confirmation.

Invoke from a Claude Code session as `/audit/<name>`.

## Index

### Security

| Command | What it checks |
|---|---|
| [/audit/auth](auth.md) | Every Express route is behind `requireAuth` and goes through `tenantQuery` / `tenantTransaction` (or has a documented reason not to) |
| [/audit/multi-tenant](multi-tenant.md) | RLS enabled on every table; cross-org reachability on live / storage routes; tenant context set per query |
| [/audit/storage-paths](storage-paths.md) | Filename sanitization on every upload path; path traversal / angle-bracket / control-char rejection; signed URL TTL |
| [/audit/secrets](secrets.md) | `JWT_SECRET` / `FLAKEY_ENCRYPTION_KEY` handling; secrets reachable from a client bundle; secrets in git history; `bt_*` localStorage usage |
| [/audit/xss](xss.md) | User-content rendering paths in the SvelteKit app — `{@html}`, error message / suite name rendering, DOMPurify usage |

### Invariants

| Command | What it checks |
|---|---|
| [/audit/migrations](migrations.md) | Migrations are idempotent; every table has `ENABLE ROW LEVEL SECURITY`; type drift between `backend/src/types.ts`, `frontend/src/lib/api.ts`, and the actual columns |
| [/audit/live-flow](live-flow.md) | Live-route invariants: test-row uniqueness, spec.finished doesn't undercount, screenshot/snapshot preservation across upload merge, heartbeat behavior, stale-run timing |
| [/audit/reporters](reporters.md) | Env-var consistency across reporter packages; peer-dep declarations; `exports` map; CJS-vs-ESM entry discipline |

### Health

| Command | What it checks |
|---|---|
| [/audit/deps](deps.md) | `npm audit` on backend, `pnpm audit` on frontend + package workspace; floating GitHub Actions refs |
| [/audit/infra](infra.md) | AWS Terraform stacks under `infra/` — IAM least-privilege, S3 / RDS encryption, secrets handling, per-env naming |
| [/audit/docs-drift](docs-drift.md) | `README.md`, `docs/*.md`, and per-package `CLAUDE.md` vs reality (endpoints, schema, env vars, streaming behavior) |

### Dispatcher

| Command | What it does |
|---|---|
| [/audit/all](all.md) | Spawns the full sweep in parallel and consolidates a report. Optional arg: `security` / `invariants` / `health` to limit scope. |

## Conventions

- Every audit is **read-only by default**. The deliverable is a findings report, not a diff.
- Findings are grouped by severity: **Critical / High / Medium / Low**.
- Each command is a **self-contained prompt** — runnable from a fresh session with no prior context.
- Findings cite the file the rule lives in (`backend/CLAUDE.md`, `frontend/CLAUDE.md`, root `CLAUDE.md`, `docs/architecture.md`) so a violation can be traced to the convention it breaks.

## Agent delegation

The Security and Invariants commands all delegate to the `flakey-auditor` agent (under `.claude/agents/`). That agent has the four trust boundaries baked in (DB↔caller, API↔caller, Storage↔paths, client-bundle↔runtime), the file layout, and the audit-area routing table — it picks up the project's conventions without re-reading them every run. `/audit/all` spawns one auditor instance per area in parallel.

`deps`, `infra`, and `docs-drift` use the `general-purpose` agent (or `Explore` for `docs-drift`) — they're tool-running / file-reading sweeps that don't need the auditor's domain context.

## When to run

- **Before tagging a release** — `/audit/all` once, fix Critical/High before tagging.
- **After a sweeping refactor** — at minimum `/audit/migrations` + `/audit/live-flow` + `/audit/auth`.
- **After a new migration** — `/audit/migrations` + `/audit/multi-tenant`.
- **After a new live-route endpoint** — `/audit/live-flow` + `/audit/auth` + `/audit/storage-paths`.
- **After a new reporter package or option** — `/audit/reporters` + `/audit/docs-drift`.
- **After a dependency major bump** — `/audit/deps` + `/audit/secrets`.
- **After editing anything under `infra/`** — `/audit/infra` before `terraform apply`.
- **Periodically (monthly)** — `/audit/all` to catch slow-moving drift.
