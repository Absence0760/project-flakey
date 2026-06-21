# Proposal: Failure triage workflow (the lifecycle Jira can't drive)

**Status:** Partially implemented — **all of 15.1 has shipped**: the assignee slice (`error_groups.assigned_to`, migration `063`; `POST /errors/:fingerprint/assign`; `assigned_to`/`assigned_to_email` on `GET /errors`; `GET /releases/:id/errors` so a release is the triage lens; shared `AssigneePicker`), plus the remainder — `target_date` / `priority` (migration `067`; `PATCH /errors/:fingerprint`, audited `error.triage_update`), the priority chip + due-date control on the errors detail pane, and the "assigned to me" / "overdue" list filters. **Not yet built:** 15.2–15.4.
**Area:** backend `error_groups` + `/errors` route, `quarantined_tests`, `failure_jira_issues`, the upload/ingest pipeline, the nightly retention pass; frontend `/errors` page (becomes the triage surface)
**Effort:** Medium, phased (15.1 small/additive → 15.4 introduces a new inbound trust boundary)

---

## Summary

Turn the **error group** into a first-class triage unit with ownership and an
automated lifecycle — *not* a Jira replacement. We already group automated
failures by a stable fingerprint, give each group a status, thread notes on it,
and link it to a Jira ticket. What's missing is everything that only makes sense
*because we hold the run data*: who owns this failure, when it was last seen,
whether a "fixed" failure **came back**, and whether a green test should
**close** the loop automatically.

The design rule (carried straight from the strategy discussion that motivated
this phase):

> **If a feature only makes sense because we have the run data — recurrence,
> auto-close-on-green, flake-rate-driven priority — build it. If it's generic
> issue tracking — sprints, boards, custom fields — integrate, don't rebuild.**

The system of record for a *bug* stays in the customer's tracker (Jira/GitHub/
Linear). Flakey owns the **test-health view and state machine** on top of it.

## Motivation

Triage today is a set of disconnected primitives with no lifecycle stitching
them together:

| Primitive | Where | What's missing |
|---|---|---|
| Error-group status (`open / investigating / known / fixed / ignored`) | `error_groups.status`, set via `PATCH /errors/:fingerprint/status` (`backend/src/routes/errors.ts:93`) | purely manual; nothing transitions it automatically |
| Quarantine | `quarantined_tests` (`migration 017`), `backend/src/routes/quarantine.ts` | **no expiry** — quarantines rot silently; not linked to a triage item |
| Jira linkage | `failure_jira_issues` keyed `(org_id, fingerprint)` (`migration 022`), `backend/src/integrations/jira.ts` | **one-way** — closing the ticket, or the test going green, does nothing |
| Per-test assignee | `release_test_session_results.assigned_to` (`migration 029`), `POST …/results/:testId/assign` (`releases.ts:1750`); **error-group owner** `error_groups.assigned_to` (`migration 063`), `POST /errors/:fingerprint/assign` | now both — automated failures can be assigned an owner (target_date / priority still pending) |
| Flaky detection | `GET /flaky` (`backend/src/routes/flaky.ts`), `flaky.detected` webhook | informational only — never feeds quarantine or triage |

So the day-to-day question — *"this test is red; who owns it, is it the same
failure as last week, and did the thing we 'fixed' just regress?"* — has no home.
Jira is a poor fit for it precisely because Jira can't see the runs: it can't
reopen a ticket because a fingerprint reappeared, and it can't close one because
the test went green for 20 runs. **We can.** That's the wedge.

## Design principle — the error group *is* the triage unit

We do **not** introduce a new "ticket" entity. The error group already has the
two properties a triage unit needs:

1. **Stable identity across runs** — `fingerprint = md5(error_message || '|' ||
   suite_name)` (`backend/src/routes/errors.ts`, `analyze.ts:55`). The same
   failure gets the same row regardless of run.
2. **A status field with a sensible enum** — `open / investigating / known /
   fixed / ignored` (`migration 044`, CHECK-constrained).

Every phase below **extends `error_groups`** (additive columns + new routes) and
reuses the existing `notes` thread and `failure_jira_issues` linkage. The
fingerprint key space is shared (md5-hex), so no new dedup scheme is introduced.

This keeps us off the "build a tracker" trap and on the data we uniquely hold.

## What this is NOT (by design)

Stated up front so scope doesn't creep into a Jira clone (mirrors the roadmap's
"What this will not do"):

- **No** sprints, boards, epics, story points, or custom fields.
- **No** general work items unrelated to a test failure. The triage unit is
  always anchored to an `error_groups.fingerprint`.
- **No** migrating the system of record off the customer's tracker. Two-way Jira
  sync (15.4) *reflects* state; Jira stays authoritative for the bug itself.
- **No** new permission model — reuse the existing `owner/admin/viewer` roles and
  `requireAuth` gating.

---

## Phase 15.1 — Ownership & lifecycle foundation *(small, fully additive)*

Make an error group something a person owns and a date you're accountable to.

> **Built so far (assignee slice):** migration `063_error_group_assignee.sql`
> added `error_groups.assigned_to INT REFERENCES users(id) ON DELETE SET NULL`
> (partial index, RLS inherited). `POST /errors/:fingerprint/assign` mirrors the
> `release.session_result_assign` IDOR guard (org-member validation, viewer 403,
> upsert + audit `error.assign`). `GET /errors` returns `assigned_to` +
> `assigned_to_email`; new `GET /errors/{fingerprint}/assign` is in `openapi.yaml`.
> `GET /releases/:id/errors` derives a release's failures from its linked runs so
> assignment can happen in the release context. Frontend: a shared
> `inputs/AssigneePicker.svelte` (extracted from the release session picker) on
> the errors detail pane and a "Failures to triage" section on the release page.
> **Still to build below:** `target_date`, `priority`, and the list filters.

**Migration** — additive columns on `error_groups`:

- ~~`assigned_to INTEGER REFERENCES users(id)` (nullable)~~ — **done** (migration `063`).
- `target_date DATE` (nullable) — when it should be resolved (the SLA hook).
- `priority TEXT CHECK (priority IN ('low','medium','high','critical'))`
  (nullable) — manual for now; *derived* default in 15.2.

`error_groups` is already RLS-enforced and org-scoped (`migration 013`), so no
new policy is needed — additive columns inherit it. **No** core-table change.

**Routes** (extend `backend/src/routes/errors.ts`, mirror the proven
`release.session_result_assign` shape at `releases.ts:1750`):

- `POST /errors/:fingerprint/assign` — `{ user_id: number | null }`; validate the
  user is an org member before writing; supports un-assign. Audit `error.assign`.
- `PATCH /errors/:fingerprint` — set `target_date` / `priority`. Audit
  `error.triage_update`. (Keep the existing `PATCH …/status` route as-is.)

**Type-sync** (no codegen — guard rail in root CLAUDE.md): add `assigned_to`,
`assigned_to_name`, `target_date`, `priority` to the `ErrorGroup` interface
(`frontend/src/lib/api.ts:208`) and `backend/src/types.ts`. `/errors` is not yet
in `openapi.yaml`, so no spec edit — but add it to the spec opportunistically.

**Frontend** — the `/errors` page becomes the triage surface: an assignee
picker, due-date, and priority chip in the detail pane; an "assigned to me" /
"overdue" filter on the list. Reuse existing components
(`inputs/`, `status/`). Hide mutating controls for `viewer`.

**Tests:** smoke for the two routes (org-member validation, un-assign, audit
row); the list/filter logic is a pure helper → vitest.

---

## Phase 15.2 — Data-native automation *(the actual moat)*

This is the part no SaaS tracker can replicate, because it requires the run
stream. Two automatic transitions on top of the existing status enum.

**(a) Recurrence detection → auto-reopen.** *(shipped — migration `068`.)* Extend
the enum with one value: `regressed` (migration `068_error_group_automation.sql`
replaces the CHECK to add it). On **ingest**, in the upload pipeline where
failures are recorded, after computing a failure's fingerprint: if an
`error_groups` row for that fingerprint is currently `fixed`, transition it to
`regressed`, bump a new `recurrence_count INTEGER NOT NULL DEFAULT 0`, and stamp
`last_recurred_at TIMESTAMPTZ`. Emit a webhook (`error.regressed`) reusing the
existing dispatcher (`backend/src/webhooks.ts`). The hook is the single
`recordErrorRecurrence` path, called from inside both upload transactions
(`routes/runs.ts` + `routes/uploads.ts`). *A failure we declared fixed coming
back is the single highest-signal triage event, and today it's invisible.*

**(b) Auto-close-on-green.** A failure is "green" when its fingerprint has not
reappeared for a configurable window. Add a nightly sweep **in the existing
retention pass** (`backend/src/retention.ts` already runs nightly per org — no
new scheduler): for each `open`/`investigating`/`regressed` group whose
`last_seen` is older than `org.triage_autoclose_days` (new org setting, default
**off / null** to stay conservative), transition to `fixed` and write an audit
row + `error.autoclosed` webhook. Default off because silently flipping state is
the kind of "trust the numbers" risk the dashboard guards against — opt-in per
org, and always logged.

**(c) Derived priority.** When `priority` is unset, compute a default at read
time from data we already have — `occurrence_count`, `affected_runs`, and the
flaky rate from `GET /flaky`. Never overwrites a human-set priority. Keep it a
**read-time derivation**, not a stored value, so it can't drift.

**Tests:** these are deterministic and unit-testable — exactly the seam the
project's "no untestable" rule wants. Smoke: ingest a fixed-then-failing
fingerprint → asserts `regressed` + `recurrence_count`. Unit: the autoclose
window predicate and the derived-priority function (pure). The reporter-payload
replay CLI (Phase 13) can drive the ingest path without the full stack.

---

## Phase 15.3 — Quarantine lifecycle *(close the rot gap)*

Quarantine today has no expiry (`quarantined_tests`, `migration 017`) — a muted
test stays muted forever and nobody notices. Wire it into triage.

- **Migration `061_*`:** add `expires_at TIMESTAMPTZ` (nullable) and
  `error_fingerprint TEXT` (nullable, links a quarantine to its triage group) to
  `quarantined_tests`.
- `POST /quarantine` (`backend/src/routes/quarantine.ts:65`) accepts an optional
  `expires_at` and `fingerprint`. The nightly sweep (15.2's retention hook)
  removes expired quarantines and writes `quarantine.expired` audit rows.
- **Auto-quarantine *suggestion*, not action.** The `flaky.detected` signal
  surfaces a "Quarantine?" suggestion in the triage view; a human confirms. We do
  **not** auto-mute — that would let the dashboard hide a real regression behind a
  quarantine, violating the trust invariant. Suggest, human decides.
- Surface "muted, expiring in N days" and "muted with no expiry" in the triage
  view so quarantines stop rotting silently.

**Tests:** smoke for expiry-on-sweep and the fingerprint link; the
"is-expired" / "expiring-soon" predicate is pure → vitest.

---

## Phase 15.4 — Two-way Jira sync *(last; new inbound trust boundary)*

Today Jira is auto-create only (`backend/src/integrations/jira.ts`). Close the
loop in both directions.

**Outbound (low risk — reuse existing client):**

- On `15.2` auto-close-on-green or manual `→ fixed`: if the group has a row in
  `failure_jira_issues`, transition the Jira issue (configurable target status)
  and comment "Flakey: test green for N runs — auto-resolving." Audit
  `jira.issue.transition`.
- On `15.2` `→ regressed`: reopen/comment the linked issue. *Jira cannot do this
  itself — it has no run data. This is the demo-able "wow."*

**Inbound (higher risk — new boundary, hence last):**

- A `POST /jira/webhook` receiver that, on issue-closed, sets the linked
  `error_groups.status` to `fixed`. **This is a new external trust boundary** and
  must follow the repo's webhook conventions: verify a shared secret / HMAC, fail
  closed, rate-limit, and never trust the payload's org — resolve org via the
  `failure_jira_issues` linkage. Document it in `backend/docs/integrations.md`.

**Compliance note:** inbound webhooks + transitioning customer Jira issues is a
SOC 2 / GovRAMP-relevant change to an external integration. **Loop in the CISO /
Security Analyst before landing 15.4** (per org policy + root guard rails), and
confirm before any write to a customer's Jira (org connector rule).

**Tests:** smoke both directions with a mocked Jira `fetch` (the existing Jira
tests already mock it); HMAC-verification unit test on the inbound receiver.
No live-Jira e2e (external, no local stub — stated, not silently skipped).

---

## Build order & dependencies

```
15.1 ownership/lifecycle  ──►  15.2 automation  ──►  15.3 quarantine lifecycle
  (additive, low risk)         (the moat)            (depends on 15.2 sweep)
                                   │
                                   └──►  15.4 two-way Jira sync
                                          (outbound low-risk; inbound = new boundary, CISO sign-off)
```

15.1 ships value alone (ownership + due dates on real failures). 15.2 is the
differentiator and the reason to do this at all. 15.3 and 15.4 are independent
follow-ons; 15.4's inbound half is the only piece gated on security review.

## Compliance / data egress

- 15.1–15.3 are internal (own DB, own audit log) — no new egress boundary.
- 15.4 outbound reuses the existing Jira egress; 15.4 **inbound** is a *new*
  ingress boundary → CISO sign-off + HMAC + fail-closed, as above.
- Every transition writes an `audit_log` row (`migration 008`) — strengthens the
  SOC 2 audit story rather than weakening it.

## Tests (guard rail 3)

Each phase ships with coverage in the same session: pure helpers (priority
derivation, autoclose/expiry predicates, list filters) → vitest; route + ingest
behavior → backend smoke; recurrence via the Phase-13 replay CLI. No phase is
"untestable" — the data-driven transitions are the most testable part.

## Docs (guard rail 12)

- `docs/roadmap.md` — Phase 15 entry pointing here (landed with this proposal).
- `backend/docs/integrations.md` — two-way Jira sync + the inbound webhook (15.4).
- `frontend/CLAUDE.md` — the `/errors` page's new role as the triage surface.
- `backend/CLAUDE.md` — the ingest-time recurrence hook and the retention-pass
  autoclose/expiry sweep, so the next session doesn't add a second path.

## Acceptance criteria

- [x] **15.1** An error group can be assigned to an org member (org-member
      validated, viewer-gated, audited `error.assign`), surfaced on the `/errors`
      detail pane and per-release via `GET /releases/:id/errors`.
- [x] **15.1** (remaining) due date + priority on an error group
      (`target_date` / `priority`, migration `067`; `PATCH /errors/:fingerprint`,
      viewer-gated + audited `error.triage_update`); "assigned to me" / "overdue"
      list filters on the `/errors` page (pure `applyTriageFilter` helper).
- [x] **15.2** A fixed fingerprint reappearing on ingest auto-transitions to
      `regressed`, bumps `recurrence_count`, and fires `error.regressed`
      (migration `068`; `recordErrorRecurrence` in `src/error-recurrence.ts`,
      called from both upload transactions; only the `fixed→regressed` edge
      counts). Smoke: `error_recurrence.smoke.test.ts`.
- [x] **15.2** With `triage_autoclose_days` set, a stale open/investigating/
      `regressed` group auto-closes on the nightly retention pass with an
      `error.autoclosed` audit row + webhook; default-off when unset
      (`autocloseStaleErrorGroups` in `src/retention.ts`; pure window predicate
      `isAutocloseEligible`). Smoke: `error_autoclose.smoke.test.ts`.
- [x] **15.2** Unset priority derives from occurrence/affected-runs/flaky data at
      read time in `GET /errors` (`deriveErrorPriority`, never stored, never
      overwrites a human value); the response carries `priority_source`
      (`'manual'|'derived'`) and the `/errors` page renders a derived value
      distinctly. Unit: `error_automation.unit.test.ts`.
- [ ] **15.3** Quarantines support `expires_at`, expire on the nightly sweep, link
      to a fingerprint, and surface "expiring/no-expiry" in the triage view; flaky
      signal *suggests* (never auto-applies) quarantine.
- [x] **15.4 (build)** Manual/auto fix transitions and regressions reflect onto the
      linked Jira issue (outbound, best-effort, audited `jira.issue.transition`); an
      HMAC-verified, fail-closed inbound `POST /jira/webhook` reflects Jira-close back
      to `fixed` (org resolved server-side via the link, never the payload). Both
      directions are smoke-tested with a mocked Jira; HMAC verification is unit-tested.
      Migration `070`.
- [x] **15.4 (inbound flag-gated OFF)** The inbound webhook receiver ships **disabled
      by default** behind `FLAKEY_JIRA_WEBHOOK_ENABLED` (route 404s when unset), so the
      code can merge safely without any live external call until enabled.
- [ ] **15.4 (operator gate)** **CISO / Security-analyst sign-off recorded BEFORE
      `FLAKEY_JIRA_WEBHOOK_ENABLED` is turned on in any environment** (inbound webhook
      transitioning customer Jira state is a SOC 2 / GovRAMP-relevant ingress). The
      build is merge-safe with the flag off; enabling it is the operator's call.

## Open questions

- **Auto-close default window** if an org opts in — 30 runs green, or N days since
  `last_seen`? Leaning days-since-`last_seen` (no per-test green signal exists for
  an *error group*, only its absence). Confirm with a design partner.
- **`regressed` vs reusing `open`** — a distinct value is higher-signal but adds an
  enum state every consumer must handle. Recommend distinct; it's the whole point.
- **Inbound Jira mapping** — only issue-*closed* → `fixed` for MVP, or full status
  mapping? MVP: closed → fixed only, to bound the boundary surface.
