# Integrations & Automation

Flakey's Settings → Integrations page configures four separate backend
integrations that hook into the upload flow or run on a schedule:

| Integration | Triggered by | Purpose |
|---|---|---|
| Jira | Run upload (if auto-create enabled) or manual button | Auto-create or open Jira issues for test failures |
| Jira two-way sync | Error-group transition (outbound) / Jira issue event (inbound, flag-gated) | Reflect fixed/regressed onto the linked issue; reflect a Jira-close back to `fixed` |
| PagerDuty | Run upload (if auto-trigger enabled) | Fire on-call incidents for failing runs |
| Coverage gating | Coverage upload | Post pass/fail PR commit status based on a threshold |
| Scheduled reports | Internal scheduler tick (every 30 min) | Deliver daily/weekly test digests via email, Slack, or webhook |

All four are org-scoped. Every read and write respects Postgres RLS, and
audit-log entries are written for any mutation.

---

## Secrets encryption

Jira API tokens and PagerDuty integration keys are **encrypted at rest**
when `FLAKEY_ENCRYPTION_KEY` is set. The format is a `v1:iv:tag:ct` prefixed
string produced by AES-256-GCM. Unencrypted legacy values (from before the
key was introduced) pass through unchanged, so enabling encryption is
non-disruptive: new writes get encrypted, old reads still work.

### Generating a key

```bash
# 32 random bytes as base64
openssl rand -base64 32

# or as hex
openssl rand -hex 32
```

Set it before starting the backend:

```bash
FLAKEY_ENCRYPTION_KEY="$(openssl rand -base64 32)" npm run dev
```

In production (ECS / Kubernetes / etc.) pass it as a secret environment
variable — never commit it to the repo. If you lose the key, any
previously-encrypted values become unreadable, so back it up in your
secrets manager.

### Rotation

Rotation uses a dual-key window: the running backend can decrypt under
either a primary or secondary key, so there is never a point where stored
secrets are unreadable. A script then re-encrypts every row under the new
primary, after which the old key can be dropped.

1. **Generate a new key** and deploy the backend with both keys set:

   ```bash
   FLAKEY_ENCRYPTION_KEY="<new>"        # primary — used for new writes
   FLAKEY_ENCRYPTION_KEY_OLD="<old>"    # secondary — used only as a read fallback
   ```

   At this point both old and new ciphertexts are readable. New writes
   use the primary key automatically.

2. **Re-encrypt existing secrets** under the new primary:

   ```bash
   cd backend
   FLAKEY_ENCRYPTION_KEY="<new>" \
     FLAKEY_ENCRYPTION_KEY_OLD="<old>" \
     npm run rotate-keys
   ```

   Preview changes first with `-- --dry-run`. The script walks every
   org's encrypted columns (Jira token, PagerDuty key), decrypts under
   whichever key works, and writes back a fresh ciphertext produced by
   the new primary. It's idempotent — re-running against already-current
   values is a no-op.

3. **Drop the old key** from the env and redeploy. `FLAKEY_ENCRYPTION_KEY_OLD`
   should be unset once rotation completes, so an attacker who later
   obtains the old key alone cannot decrypt anything in the database.

The `v1:` prefix is preserved across rotations; the on-disk format does
not change, only the key that authenticates the GCM tag.

### Leaving it unset

If you do not set `FLAKEY_ENCRYPTION_KEY`, encrypt/decrypt become no-ops
and secrets are stored as plaintext. This is intentional — local
development works out of the box, and a dev environment that never holds
real credentials does not need the ceremony.

---

## Jira

### 1. Create a Jira API token

1. Go to [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Click **Create API token** and give it a name like "Flakey"
3. Copy the generated token

### 2. Configure Flakey

1. Sign in as an org owner or admin
2. Go to **Settings → Integrations**
3. Fill in the Jira section:
   - **Base URL** — your Atlassian instance, e.g. `https://acme.atlassian.net`
   - **Email** — the Atlassian account that owns the token
   - **API token** — the token you just generated
   - **Project key** — e.g. `QA` (issues will be created in this project)
   - **Issue type** — defaults to `Bug`; must match a valid issue type in
     the target project
   - **Auto-create for new failures** — if enabled, the upload flow will
     automatically open an issue for each failing test (deduped per
     fingerprint so re-runs do not spam Jira), up to **20 issues per run** so a
     catastrophic run can't flood the project. Failures beyond that cap still
     appear in the PR comment and the dashboard — they just don't get an
     auto-filed ticket, and the overflow is logged server-side.
4. Click **Save**, then **Test credentials** to verify — it hits
   `/rest/api/2/myself` and reports the HTTP status

### 3. How dedup works

The first time a given failure fingerprint (hash of `spec_file ::
full_title`) creates an issue, Flakey stores the issue key in the
`failure_jira_issues` table. Subsequent failures with the same fingerprint
reuse the existing issue — the API returns the same `{key, url}` pair
rather than creating duplicates.

This holds under concurrency too: parallel CI shards (or a manual
`POST /jira/issues` racing the auto-create pass) that all hit the same
fingerprint at once still produce exactly one ticket — first-time creation is
serialized per `(org, fingerprint)` so only one caller posts to Jira and the
rest reuse its result.

### 4. Manual issue creation

Even without auto-create enabled, you can open a ticket for any failure:

```bash
curl -X POST http://localhost:3000/jira/issues \
  -H "Authorization: Bearer $FLAKEY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "summary": "[checkout] Cart total wrong with expired coupon",
    "description": "Error: expected 90.00, got 100.00\n\nRun: http://localhost:7778/runs/42",
    "fingerprint": "checkout-cart-expired-coupon-v1"
  }'
```

Passing a `fingerprint` makes the request idempotent — the same
fingerprint returns the same issue.

### 5. Listing tracked issues

```bash
curl http://localhost:3000/jira/issues \
  -H "Authorization: Bearer $FLAKEY_API_KEY"
```

Returns every fingerprint → issue mapping the org has created.

### 6. Two-way sync (Phase 15.4)

Once a failure is linked to a Jira issue (auto-created or via `POST
/jira/issues`), Flakey keeps the issue in step with the failure's triage
lifecycle in **both** directions.

#### Outbound (Flakey → Jira) — on by default once Jira is configured

Whenever an error group's status transitions, Flakey reflects it onto the
linked issue (best-effort: a Jira outage logs + continues, it never breaks
ingest or the nightly sweep):

| Flakey transition | Jira action | Audit action |
|---|---|---|
| → `fixed` (manual `PATCH /errors/:fp/status`, or the 15.2 auto-close-on-green sweep) | drive the issue through the **resolve** transition + comment "Flakey: …" | `jira.issue.transition` (`direction: fixed`) |
| → `regressed` (the 15.2 ingest-time auto-reopen) | drive the issue through the **reopen** transition + comment "Flakey: …" | `jira.issue.transition` (`direction: regressed`) |

The reopen-on-regression is the one Jira can't do itself — it has no run data.

The transition **names** are configurable per org (Jira workflows name their
done/todo columns differently). Set them on `PATCH /jira/settings`:

```bash
curl -X PATCH http://localhost:3000/jira/settings \
  -H "Authorization: Bearer $FLAKEY_API_KEY" -H "Content-Type: application/json" \
  -d '{ "resolve_transition": "Done", "reopen_transition": "To Do" }'
```

They default to **"Done"** / **"To Do"** when unset. A transition that isn't
currently available on the issue (e.g. it's already in that state) is a no-op —
Flakey still leaves the comment.

#### Inbound (Jira → Flakey) — **flag-gated OFF by default**

`POST /jira/webhook` accepts Jira issue events and, on an issue moving into the
**done** status category, flips the linked error group to `fixed`.

This is a **new external trust boundary**, so it is **disabled unless an
operator explicitly turns it on after security sign-off**:

- **`FLAKEY_JIRA_WEBHOOK_ENABLED`** (default `false`). When unset/false the
  route returns a clean **404** — same kill-switch shape as
  `FLAKEY_SSO_ENABLED`. **Enabling it requires CISO / Security-analyst sign-off**
  (inbound webhooks that transition our triage state from a customer's external
  system are a SOC 2 / GovRAMP-relevant change to an integration's egress/ingress
  posture).
- **HMAC-verified, fail closed.** Every request must carry
  `X-Hub-Signature: sha256=<hex HMAC-SHA256 of the raw body>` keyed by the org's
  webhook secret. Missing / malformed / mismatched / wrong-length signature →
  **401**. No secret configured for the resolved org → **401** (can't verify ⇒
  reject). The compare is constant-time over the **exact raw bytes**.
- **Never trusts the payload's org.** The owning org is resolved **server-side**
  from the issue key via the `failure_jira_issues` link (a narrow
  `SECURITY DEFINER` lookup, the same pattern as SCIM token auth), and the HMAC
  is checked against **that** org's secret. An attacker who knows an issue key
  but not the secret can't forge a request. An unlinked issue is a benign 204.
- **Rate-limited** at the mount (`JIRA_WEBHOOK_RATE_LIMIT_MAX`, default 120/min).
- The status flip and an `jira.webhook.issue_closed` audit row run under the
  resolved org's RLS context.

Configure the shared secret (encrypted at rest, like the API token):

```bash
curl -X PATCH http://localhost:3000/jira/settings \
  -H "Authorization: Bearer $FLAKEY_API_KEY" -H "Content-Type: application/json" \
  -d '{ "webhook_secret": "a-long-random-string" }'
```

Then in Jira, register a webhook pointing at
`https://<your-flakey-host>/jira/webhook` and configure it to sign with the same
secret (Jira's webhook "secret" → `X-Hub-Signature`). Only enable the
`FLAKEY_JIRA_WEBHOOK_ENABLED` flag in the backend environment **after** security
review.

---

## PagerDuty

### 1. Create a PagerDuty integration

1. In PagerDuty, open the service you want Flakey to page
2. **Integrations** tab → **Add another integration** → **Events API v2**
3. Copy the **Integration Key** (a 32-char hex string)

### 2. Configure Flakey

1. Go to **Settings → Integrations**
2. Fill in the PagerDuty section:
   - **Integration key** — paste it (stored encrypted)
   - **Severity** — `info`, `warning`, `error`, or `critical`
   - **Trigger on run failure** — toggle on to auto-fire incidents
3. Click **Save**, then **Send test event** to verify — the UI reports
   the PagerDuty API HTTP status and dedup key

### 3. How dedup works

Every triggered incident uses a dedup key of the form
`flakey-<orgId>-<suite>/<branch>` (the suite and branch are each
URL-encoded so a `-` inside either name can't make two distinct
`(suite, branch)` pairs collide). This means a suite that fails
repeatedly on the same branch will not create a pile of separate
incidents — PagerDuty groups them into the same open incident. When the
suite starts passing again, resolve the incident in PagerDuty manually
(automatic resolution on green is a future enhancement).

---

## Scheduled reports

Scheduled reports deliver daily or weekly test-summary digests via email,
Slack, or a generic webhook.

### 1. Create a report

1. Go to **Settings → Integrations** → **Scheduled reports**
2. Fill in the form:
   - **Name** — free-form label
   - **Cadence** — `Daily` or `Weekly`
   - **Day of week** — (weekly only) 0=Sun through 6=Sat
   - **Hour UTC** — `0`–`23`; the dispatcher will deliver on or after
     this hour on the scheduled day
   - **Channel** — `email`, `slack`, or `webhook`
   - **Destination** — an email address for `email`, an incoming webhook
     URL for `slack` / `webhook`
   - **Suite filter** — optional; limits the digest to a single suite
3. Click **Add**

### 2. What each channel sends

- **Email**: plain-text summary using the configured SMTP server
  (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM`)
- **Slack**: formatted message with a header block, a code block summary,
  and an "Open dashboard" button; post to any Slack incoming webhook
- **Webhook**: JSON POST with `{event, title, body, cadence,
  dashboard_url, summary}` — suitable for any generic consumer

### 3. Testing a report

Each row has a **Run now** button that:

1. Clears `last_sent_at` (so the scheduler treats it as due)
2. Calls `runScheduledReports()` immediately

This bypasses the normal "every 30 min" tick for verification.

### 4. Scheduler behavior in multi-replica deployments

The dispatcher takes a transaction-scoped Postgres advisory lock
(`pg_try_advisory_xact_lock(0x666c616b79)`) at the top of every run.
Because the lock is transaction-scoped, Postgres releases it
automatically when the transaction ends — no explicit `pg_advisory_unlock`
is needed. This means:

- **Only one replica** dispatches reports at a time
- A replica that fails to acquire the lock returns immediately (no work)
- If a replica crashes mid-dispatch, Postgres releases the lock
  automatically when the transaction tears down on connection close

No coordination service or locking table is needed. Just run as many
backend replicas as you want.

---

## Coverage PR gating

### 1. Enable gating

1. Go to **Settings → Integrations** → **Code coverage gating**
2. Toggle **Gate PRs on coverage**
3. Set **Minimum %** — any value 0–100
4. Click **Save**

### 2. How it works

Gating reuses the same git provider configuration as PR comments
(configured under **Settings → Connections**). When a coverage upload
arrives via `POST /coverage`, if gating is enabled the backend:

1. Looks up the run's `commit_sha` and `suite_name`
2. Calls the configured git provider to post a commit status:
   - **success** if `lines_pct >= threshold`
   - **failure** if `lines_pct < threshold`
3. The status context is `flakey/coverage/<suite>` so it does not
   collide with the main test-result commit status (`flakey/<suite>`)
4. The target URL points to the Flakey run detail page

Because this uses commit statuses rather than PR comments, coverage
gating works even before a PR exists — the status attaches to the
commit and is picked up whenever a PR is opened.

## GitHub Checks annotations (per-failure, inline on the diff)

On top of the PR comment + commit status, a GitHub-configured org also gets
**inline annotations** on the PR diff — each failed test is pinned to the file
and line it threw at, via the GitHub Checks API. This is GitHub-only (the Checks
API has no GitLab/Bitbucket equivalent); those providers omit it.

**How it works.** When a run is uploaded, `postPRComment` (`src/git-providers/index.ts`)
also calls the provider's `postChecksAnnotations` (when present). It creates a
**completed check-run** on `meta.commit_sha` with conclusion `failure`/`success`,
and one annotation per failed test built by `buildCheckAnnotations`
(`src/git-providers/annotations.ts`):

- The file + line are **best-effort**, derived from whatever the reporter
  captured — Playwright's `metadata.location`, or Cypress's source-map-resolved
  `failure_context.code_frame` (Phase 13). Reporters that carry no location
  (mochawesome / JUnit) still show in the PR comment but produce no inline
  annotation, and a known file with no line falls back to line 1.
- Annotations are **capped at 100** per run and **batched 50/request** (the
  Checks API limit) — the first 50 on the create call, the rest PATCHed onto the
  same check-run.
- It's **fire-and-forget**: like the commit status, any error is logged and
  never blocks the upload response.

**Token scope.** The Checks API needs `checks:write`, which a classic
repo-scoped PAT does **not** grant — use a fine-grained PAT (Checks: read/write)
or a GitHub App installation token. Without it the create returns **403**, which
surfaces as a logged `Checks annotations error` and is otherwise harmless (the
comment + status still post).

## AI fix PRs (elevated WRITE / PR scope)

`POST /analyze/fix-pr` asks the configured AI provider to rewrite the file that
owns a failing test and opens a pull/merge request with the proposed change. It
reuses the same git provider configuration as PR comments — **but it writes to
the repo**, so it needs a token with an *elevated* scope beyond what PR-comment,
commit-status, and Checks posting require.

**Fix PRs are always opened as DRAFT for human review — never auto-merged.** The
PR body carries an explicit "AI-generated — review before merging" banner and a
link back to the failing test in Flakey. A human reviews and merges; Flakey only
proposes.

**Required token scope, per provider** — the PR-comment / Checks token in use
today may be read-only, so this is an additional, opt-in grant:

| Provider | Scope needed for fix PRs |
|---|---|
| **GitHub** | `contents:write` (create branch + commit a file) **and** `pull_requests:write` (open the draft PR). A fine-grained PAT with Contents + Pull requests = read/write, or a GitHub App installation token. A read-only or comment-only token fails at branch/commit time. |
| **GitLab** | A token with `api` scope (or `write_repository` + the merge-request API) — it must be able to create a branch, commit a file, and open a draft MR. A read-only `read_api` token is not enough. |
| **Bitbucket** | An app password / access token with **Repositories: Write** *and* **Pull requests: Write**. Read-only repo access can post commit statuses but cannot push a branch or open a PR. |

**Safety guards** (all enforced server-side, independent of provider):

- **Draft-only, never auto-merged** — see above.
- **Size cap** — a target file over 40 000 chars is refused (`413`) rather than
  truncated; committing a truncated file would break the repo.
- **No empty / no-op PRs** — if the model returns empty or unchanged content,
  no PR is opened (`{ created: false, reason: "no change" }`).
- **Truncation guard** — output under half the original file size is treated as
  a model truncation and rejected (`422`), not committed.
- **Idempotent** — while a fix PR for the same `(org, target)` is still open, a
  repeat call returns the existing PR (`{ created: false, reason: "exists" }`)
  rather than opening a duplicate. Tracked in the `ai_fix_prs` table.
- **No provider detail leaks** — a mid-flow provider/model failure returns a
  fixed `502`; the underlying error (which can carry tokens) is logged
  server-side only.

The route is **contributor+** (it both calls the model and writes the repo);
viewers get a `403`. It needs an AI provider configured (`503` otherwise) — and
that provider can be a fully local, **air-gapped** Ollama (see below). It also
needs a git provider configured to open the PR against (`409 "No git provider
configured"` otherwise).

## Air-gapped AI

The AI-assisted features — failure root-cause analysis, flaky-test analysis,
root-cause **clustering** (`POST /analyze/clusters`), and the **draft fix PRs**
above — all call the instance-configured AI provider. Point that provider at a
**local model and no data leaves the box**:

```bash
# backend/.env.development.local
AI_PROVIDER=openai
AI_BASE_URL=http://localhost:11434/v1   # local Ollama (pnpm ai:up), OpenAI-compatible
```

With this set, prompts (error messages, stack traces, source files) go only to
your local Ollama — there is no outbound call to a hosted LLM. AI is
**instance-wide** (not per-org): once configured, `isAIEnabled()` is true for
every org. Leave it unset and the generation routes return `503` while cached
results still read, and clustering still works (its similarity grouping is
deterministic and model-free).

## Uploading coverage from CI

Use the CLI subcommand from a post-test step in your pipeline:

```bash
# after running tests with nyc / c8 / jest --coverage / cypress code-coverage
npx flakey-cli coverage \
  --run-id "$RUN_ID" \
  --file coverage/coverage-summary.json \
  --api-key "$FLAKEY_API_KEY"
```

`$RUN_ID` comes from the response of the main run upload earlier in the
pipeline. See [packages/flakey-cli/docs/uploading-results.md](../../packages/flakey-cli/docs/uploading-results.md#uploading-quality-metrics)
for the full format reference.

---

## CI ship gate

Once test results are uploaded, a CI job often needs a single yes/no answer:
**is this run shippable?** Rather than have every pipeline re-derive that from
the raw `failed` / `aborted` / `finished_at` fields (and get it subtly wrong —
a live or aborted run can sit at `failed = 0`), Flakey exposes one consolidated
signal.

### `GET /runs/status` — consolidated ship signal

Authenticated (`Authorization: Bearer $FLAKEY_API_KEY`). Identify the run by
either its CI run id or its suite:

```bash
# By the CI run id you tagged the upload with (the specific run):
curl -H "Authorization: Bearer $FLAKEY_API_KEY" \
  "http://localhost:3000/runs/status?ci_run_id=$CI_RUN_ID"

# Or by suite (the latest run for that suite, whatever state it's in):
curl -H "Authorization: Bearer $FLAKEY_API_KEY" \
  "http://localhost:3000/runs/status?suite=checkout-e2e"
```

Pass both to disambiguate a `ci_run_id` that spans multiple suites. The
response:

```json
{
  "status": "passed",
  "run_id": 42,
  "suite_name": "checkout-e2e",
  "total": 120,
  "passed": 118,
  "failed": 0,
  "skipped": 2,
  "finished_at": "2026-06-05T20:31:00Z",
  "aborted": false
}
```

`status` is exactly one of:

| status | meaning | ship? |
|---|---|---|
| `passed` | finished, not aborted, no failures, every test accounted for | ✅ |
| `failed` | one or more tests failed | ❌ |
| `aborted` | run was killed mid-flight (CI cancel / OOM / network drop) | ❌ |
| `incomplete` | still in progress, **or** finished with pending (un-run) tests | ❌ |

Only `passed` means shippable. The precedence when more than one could apply is
`failed` → `aborted` → `incomplete` → `passed`, so the most actionable signal
wins (a run with failures reports `failed` even if it was also aborted).

**Fail-closed by design.** A `ci_run_id` / `suite` with no matching run returns
**404**, not a fake "pending" — a missing run should fail your gate loud. A
naive `jq -r '.status'` against the 404 body reads `null`, which is `!= passed`,
so even a script that ignores the HTTP code holds the release.

**Agrees with the badge and PR comment.** The SVG badge
(`GET /badge/:orgSlug/:suiteName`, public, no auth), the PR/MR comment Flakey
posts on pull requests, and this endpoint all derive from the same classifier,
so the badge is green and the PR comment reads **Passed** **exactly when**
`status` is `passed`. A run with un-run (pending) tests reads `incomplete`
everywhere — the PR comment shows ⚠️ **Incomplete**, never a false-green
**Passed**. Use the badge for a human-readable widget, the comment for an
at-a-glance PR verdict, this endpoint for a machine gate.

### Gating a pipeline

```bash
status=$(curl -s -H "Authorization: Bearer $FLAKEY_API_KEY" \
  "$FLAKEY_URL/runs/status?ci_run_id=$CI_RUN_ID" | jq -r '.status')

if [ "$status" != "passed" ]; then
  echo "Run not shippable (status: ${status:-unknown}) — holding release."
  exit 1
fi
echo "Run passed — proceeding."
```

Poll this only after the final upload (the last shard, end-of-run). An
in-progress run correctly reports `incomplete`, so a premature check holds
rather than ships — but it also won't flip to `passed` until every shard has
reported.

### `GET /runs/check` — mid-run early cancel (distinct)

`/runs/status` is the *post-run* gate. For the opposite question — *"have
enough tests already failed that I should cancel this run early?"* — use
`GET /runs/check?ci_run_id=X&suite=&threshold=N`, which returns
`{ should_cancel, failed, ... }`. It is the only signal that reads **live**
failures (from the per-test rows) rather than the post-merge aggregate, so it
works mid-run. Call it from each shard before doing expensive work; call
`/runs/status` once at the end to decide whether to ship.

---

## Audit trail

Every integration mutation writes an entry to the `audit_log` table:

- `jira.settings.update` — settings saved
- `jira.issue.create` — issue opened (manually or auto)
- `jira.issue.transition` — outbound two-way sync moved a linked issue (`direction`: `fixed` | `regressed`; `trigger`: `manual` | `autoclose` | `ingest`)
- `jira.webhook.issue_closed` — inbound webhook flipped a linked error group to `fixed`
- `pagerduty.settings.update`
- `coverage.settings.update`
- `coverage.upload`
- `scheduled_report.create` / `.update` / `.delete`

Account and data-lifecycle events are audited too:

- `auth.login` / `auth.logout` — successful authentication / sign-out (token
  refresh is deliberately *not* audited; it fires every ~15 min per session)
- `auth.password_reset_requested` / `auth.password_reset` — reset email
  requested (known email) / password actually changed
- `auth.api_key.create` / `auth.api_key.delete` — API-key issuance / revocation
- `org.member.remove` / `org.member.role_change`
- `run.delete` — a run (and its specs, tests, artifacts) removed
- `quarantine.auto` — a test auto-quarantined at run finalization (system-initiated, no acting user; detail carries the suite, reason, flip_count, total_runs)

View the audit log under **Settings → Audit log**, or query it directly:

```sql
SELECT created_at, action, detail
FROM audit_log
WHERE action LIKE 'jira%' OR action LIKE 'pagerduty%'
ORDER BY created_at DESC
LIMIT 50;
```
