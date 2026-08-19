---
description: Map every outbound personal-data hop into a sub-processor list ready for the Privacy Policy
---

Audit every outbound flow of personal data to a third-party processor. Output is the input to a GDPR Art 30 Record of Processing Activities and the sub-processor list of a Privacy Policy.

## Goal

A regulator's first ask in any incident is "show me your sub-processor list". A user's most-clicked Privacy Policy section is "who does my data go to?". Both need the same artefact: a table of provider × data × purpose × region × DPA + opt-out path. This audit produces it by walking the codebase.

## What to check

1. **Provider inventory.** Grep for every outbound endpoint by base URL:
   - `strava.com`, `connect.garmin.com`, `parkrun.com`
   - `api.anthropic.com`, `api.openai.com` (or `OPENAI_BASE_URL` for local Ollama)
   - `api.revenuecat.com`, `api.stripe.com`
   - `api.maptiler.com`, `*.tiles.mapbox.com` if any
   - `sentry.io`, `*.ingest.sentry.io`
   - an external weather API (`api.open-meteo.com` — elevation for route builder)
   - Google APIs (`googleapis.com`, `accounts.google.com`)
   - Apple (`appleid.apple.com`)
   - AWS endpoints (S3, CloudFront, Lambda, KMS, Route 53) — surfaced via Terraform
   - the auth/data platform
   - <hosted-worker-platform> (your worker host) — Go worker + the routing service internal
2. **Per-flow analysis.** For each:
   - What user data leaves? (email, IP, sensor data, payment intent, prompt text, error stack — list yours)
   - From where? (web client, backend route, Go worker, mobile native)
   - To which region? (US east-1, EU west-1, ap-southeast-2)
   - DPA / SCC URL?
   - Opt-out mechanism if any? (user disconnects integration, disables session-replay (if used), etc.)
   - Legal basis? (consent / contract / legitimate interest)
3. **Tiles.** the map provider logs the requesting IP + viewport coordinates. Every web map render → the map provider log. Treat tile fetches as a personal-data hop.
4. **Coach prompts.** `an AI-call entrypoint (e.g. an LLM streaming endpoint)` + the Lambda variant build a prompt that includes <sensitive-data summary built for the AI call>. That's HEALTH data sent to the AI provider. Confirm:
   - JWT-gated (only owner's data goes out)
   - Region of the API endpoint
   - the AI provider's data-retention statement
   - alternate-provider fallback (if used) data-retention statement
5. **the error monitor.** the error monitor sees `user_id` (pseudonymous uuid), URL paths, error stack traces. Replay (if enabled) sees DOM. Confirm replay is OFF by default + opt-in.
6. **Third-party webhook payloads.** A third-party service POSTs event ids to our webhook endpoint. Each event triggers a fetch of the full activity. The data goes from external service → backend worker → the data platform. The flow direction is *inbound*, but it creates a *retention* obligation here that mirrors the upstream source.
7. **OAuth handoffs.** social OAuth ID tokens are presented to the auth provider, which validates against the provider. Personal data exposed = email + uid + provider profile fields. Confirm the validation flow doesn't log the token.
8. **Email.** Local dev uses the local mail capture tool. Prod uses the email provider — confirm which (<email-service>? another transactional email provider? in-house?). Each is a sub-processor.
9. **Sub-sub-processors.** AWS uses sub-processors of its own (CloudFront edge nodes by region). The project's Privacy Policy needs to point users to AWS's sub-processor list rather than enumerate it.

## Report

Output two artefacts:

### (A) Sub-processor table

| Provider | Data | Region | Purpose | DPA / SCC | Opt-out |
|---|---|---|---|---|---|

One row per flow. The user pastes this into the Privacy Policy.

### (B) Findings

- **Critical** — a sub-processor on the list that the user does not currently disclose anywhere.
- **High** — a flow that bypasses an opt-out the user has asserted in Settings (e.g. user disabled the error monitor but it still fires).
- **Medium** — missing region detail or unclear data-retention period.
- **Low** — undocumented sub-sub-processor chain.

End with a **clean** section: outbound endpoints in the codebase where you confirmed no personal data leaves.

## Delegate to

Use the `compliance-auditor` agent: `"Map every outbound personal-data flow in this monorepo into a sub-processor list."`

Read-only. Output the table + findings. Don't recommend a default Privacy Policy — that's `intl-legal-doc-reviewer`'s job once the user drafts one.
