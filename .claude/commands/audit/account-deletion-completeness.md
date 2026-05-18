---
description: Verify GDPR Art 17 erasure — every personal-data table + Storage object + third-party link is cleared by delete-account
---

Audit the account-deletion path for completeness. When a user invokes "delete my account", nothing personal should remain.

## Goal

GDPR Art 17 (right to erasure) requires us to erase personal data on request. Apple + Google both *mandate* an in-app account-deletion route for any app that supports account creation — failure is a store-rejection blocker. The internal risk is orphaned rows: a AI-conversation tables row pointing at a deleted `auth.users.id`, a `run-photos` Storage object that survived the auth-user delete because the prefix walker missed `thumbs/`, a an external service token still queueing webhook events for a user that no longer exists.

## What to check

1. **Handler.** `the account-deletion backend route`. Read it. Map every step to an asset class (DB row / Storage prefix / third-party link).
2. **Foreign keys.** Walk every `the backend app/supabase/migrations/*.sql` for `references auth.users` and `references public.user_profiles`. Each one needs either `on delete cascade` (preferred, deletes automatically) or an explicit delete in the handler. Flag any that have neither.
3. **Personal-data tables.** From `compliance-auditor.md`'s list: `runs`, `routes`, `route_reviews`, `clubs` (the user as owner), `club_members`, `events` (as host), `event_attendees`, `club_posts`, `training_plans`, `plan_weeks`, `plan_workouts`, `user_settings`, `user_device_settings`, `event_results`, `race_sessions`, `race_pings`, `user_coach_usage`, `device_tokens`, `fitness_snapshots`, `personal_records`, AI-conversation tables, `user_follows` (both directions), `run_kudos`, `run_comments`, `run_photos`, `saved_routes`, `segments` (as creator), `segment_efforts`, `notifications` (recipient + actor), `run_matched_tracks`, `gear`, `run_gear`, session-event tables, `route_history`, `heatmap_points`. Each one must drain.
4. **Two-sided relations.** `user_follows` has `(follower_id, followed_id)` — both halves must drop. `run_kudos` and `run_comments` reference both the *author* and the *run owner* — if the user deletes, their authored rows must drop AND their runs' kudos must drop. `event_attendees` similar.
5. **Storage prefixes.** Buckets: `runs` (`{user_id}/*.json.gz`, `{user_id}/exports/*`), `run-photos` (`{user_id}/<run_id>/<photo>.jpg` + `{user_id}/<run_id>/thumb.webp`), `avatars` (`{user_id}/*`). The Storage walker in `delete-account/index.ts` must traverse each. Per ADR `decisions §33`, `recursive Storage prefix walk` was added to drain `{user_id}/exports/`; verify it also handles `run-photos` thumbnail subprefix.
6. **Third-party revocations.**
   - **an external service**: revoke the OAuth token via `https://www.strava.com/oauth/deauthorize` before deleting the row in `integrations`. Otherwise the next webhook event still maps to the (now deleted) user.
   - **the subscription provider**: subscriber id outlives our row. Per the subscription provider docs, call `purchases.deleteCustomerInfo` or the equivalent server API.
   - **FCM / APNs**: invalidate every row in `device_tokens` so push notifications stop. Worth telling FCM the token is dead (otherwise we keep wasting send budget).
   - **the error monitor**: purge user via `https://docs.sentry.io/api/projects/delete-a-projects-user/` or accept that the error monitor retains pseudonymised event metadata under their DPA. Document the choice.
   - **the AI provider**: per their data-retention policies, prompts are retained 30 days (the AI provider) and not used for training. No revocation API; document.
7. **Order.** The auth user must be the last thing deleted. If we delete the auth row first, every subsequent owner-scoped query fails RLS. Verify.
8. **Confirmation.** The UI confirmation should require typing the email or password — Apple specifically flags one-tap deletions as a UX risk. Verify the web + mobile confirmation flow.
9. **Auditability.** A pseudonymised log of the deletion (`user_id`, timestamp, deletion-result-set) is *helpful* for legal-hold but *not allowed* to be PII. If we log anything, confirm it's hashed.
10. **Re-signup.** If the same email signs up later, do we create a fresh account or recover the deleted one? GDPR Art 17 implies fresh-only. Verify.
11. **Test coverage.** Is there an end-to-end deletion test? `the backend app/supabase/tests/` is the home for pgtap suites — look for one that creates a user, populates every personal-data table, calls `delete-account`, and asserts every table is empty.

## Report

- **Critical** — a personal-data table is not drained AND has no cascade. Trivially reproducible orphan after deletion.
- **High** — Storage prefix not walked, or third-party link not revoked.
- **Medium** — order issue (auth user deleted too early), missing audit log, no end-to-end test.
- **Low** — UX confirmation too easy, re-signup recovery instead of fresh.

For each: the `<table>` or `<bucket>/<prefix>` or third-party + where the handler would change.

End with a **clean** list of tables / buckets / third-party links that are fully covered.

## Delegate to

Use the `compliance-auditor` agent: `"Audit the delete-account handler for completeness per GDPR Art 17 + Apple/Play account-deletion mandates."`

Read-only. Findings only.
