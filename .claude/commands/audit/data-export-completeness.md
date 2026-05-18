---
description: Verify every personal-data column + Storage object is included in the GDPR Art 20 / CCPA right-to-know export
---

Audit the data-export endpoint for completeness. Every personal-data row in this project must be reachable via the user's export.

## Goal

GDPR Art 20 (portability) and CCPA right-to-know both require the export to be **complete and machine-readable**. The risk is silent drift: someone adds a new table or column holding user data, forgets to extend the exporter, and three months later a DSAR comes in and we hand back a partial archive — that's a notifiable incident.

## What to check

1. **Walker.** The primary export is `the data-export worker` (HTTP `POST /v1/export`). The rollback is `the data-export backend route`. Read both. List every table + column the exporter pulls.
2. **Schema.** Walk every `the backend app/supabase/migrations/*.sql` `create table` + `add column` statement. Filter to tables that hold user-data per `compliance-auditor`'s "personal data this project handles" list. Diff against the exporter's coverage.
3. **Storage.** Buckets `runs`, `run-photos`, `avatars`, plus the export-output bucket itself. The exporter must enumerate `{user_id}/*` for each (including subprefixes like `run-photos/<user>/<run>/<thumb>.webp`). Verify.
4. **Third-party-linked state.**
   - an external service tokens → not user content, but the *fact* of the integration is. Include `integrations` row (sans the encrypted token).
   - the subscription provider subscriber id + tier → include.
   - parkrun athlete number → include.
   - Coach chat history → AI-conversation tables is the largest under-the-radar PII pile. Verify.
   - Notifications, kudos, comments (both as author and as recipient) — confirm both halves of the relation appear.
5. **Derived data.** Personal records, fitness snapshots, training-load curves are derived. GDPR doesn't strictly require derived data in the export, but UX-wise it's expected. Note any gap.
6. **Format.** Output should be JSON or CSV bundled in a zip (current state). NDJSON for very large run tables. Confirm UTC timestamps, ISO 8601, units explicit (m / s / bpm).
7. **Authentication.** Exporter must use JWT-verified `user.id`; never trust a caller-supplied `user_id` field. Confirm the Go handler.
8. **Rate limit + size.** At >5 years of daily runs (~1,800 runs * ~50 KB tracks = 90 MB compressed) the request needs to be async with signed-URL pickup. Confirm that's how it's structured.
9. **Joining tables.** `run_kudos`, `run_comments`, `run_photos`, `segment_efforts`, `event_attendees`, `club_members`, `user_follows`, `run_gear`, `route_reviews` — confirm coverage. Each is small but losing it leaves the export incomplete.
10. **Two-direction relations.** A run that the user commented on but didn't author: should it appear? Strictly the user's own data is their comment row only. Be explicit about what we ship vs not.

## Report

- **Critical** — a table on the user-data list is not exported at all.
- **High** — a column on an exported table is missing (e.g. `runs.metadata.bpm_samples` but not `runs.metadata.workout_step_results`).
- **Medium** — Storage prefix not walked, or walked non-recursively where it should be.
- **Low** — format issues (timestamps without tz, units ambiguous, missing schema_version stamp).

For each: the `<table>.<column>` or `<bucket>/<prefix>`, where the exporter would change.

End with a **clean** list of tables / buckets / third-party state that are fully covered.

## Delegate to

Use the `compliance-auditor` agent: `"Audit the data-export endpoint for completeness per GDPR Art 20 + CCPA right-to-know."`

Read-only. Findings only.
