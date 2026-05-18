---
description: Verify spend safeguards across AWS, the <CMS>, <email-service>, and <payment-processor> — no single failure should produce a runaway bill
---

Audit every layer that bounds runaway spend across the stack. The realistic cost-vector accidents for this project: a leaked <email-service> / <CMS> API token, an unauthenticated Lambda burst from a botnet, a CloudFront egress flood, a <CMS> dataset overrun, a <payment-processor>-volume spike (legit or otherwise). Each one should be capped by **at least one** independent ceiling — none should run unbounded for hours before someone notices.

## Goal

The baseline cost at launch is **~R380/month** (per `docs/architecture.md` cost analysis — AWS + the <CMS> paid plan + domain). A finding is anything that lets the bill exceed that by an order of magnitude before any alarm fires. <payment-processor> is per-transaction (no monthly subscription), so it doesn't have a runaway-cost path the way a token-billed AI service does — but it still has a real cost per legitimate order, which means a botnet hammering `POST /orders` indirectly hits <payment-processor> volume too.

## What to check

### 1. Backend rate limiting

`backend/src/rate-limit.ts` is the in-memory per-IP fixed-window limiter applied to:

| Route | Window | Max per IP | Wired in |
|---|---|---|---|
| `POST /orders` | 15 min | 5 | `backend/src/routes/orders.ts` |
| `POST /enquiries` | 15 min | 5 | `backend/src/routes/enquiries.ts` |
| `GET /orders/:ref` | 1 min | 20 | `backend/src/routes/order-lookup.ts` |
| `POST /webhooks/<payment>-webhook` | 1 min | 60 | `backend/src/routes/<payment>-webhook.ts` |
| `POST /webhooks/cms-order` | 1 min | 60 | `backend/src/routes/cms-webhook.ts` |

Verify:
- The limiter is wired into every public-facing route (`GET /products`, `/gallery`, `/testimonials`, and `/health` are intentionally unlimited — they're cacheable / unprivileged reads).
- The 5/15min limits for `POST /orders` and `POST /enquiries` match the documented value in `docs/security.md § Risk 2`.
- The 20/min limit on `GET /orders/:ref` lets a customer legitimately repeat-poll the tracking page without hitting the limit but caps a scripted enumeration attempt.
- The 60/min webhook limits are permissive enough that a legitimate <payment-processor> / <CMS> retry burst isn't rate-limited (<CMS>'s IPs are stable; <payment-processor>'s are well-known) but still bound a runaway loop.

**Caveat**: the limiter is per-Lambda-instance (in-memory). API Gateway's throttling is the cross-instance cap — see check 2 below.

### 2. API Gateway throttling

`infra/api_gateway.tf` should declare `throttling_burst_limit` and `throttling_rate_limit` on the `$default` route. The per-Lambda-instance rate limiter doesn't catch a distributed attack across many fresh Lambda cold-starts; API Gateway is the global cap.

- Limits set: green.
- Unbounded throttling on `$default`: flag as High (this is the single most important cost-runaway gate for this project given how low the legitimate traffic is).

### 3. AWS account budget

`infra/budget.tf` should declare an `aws_budgets_budget`:

- **`monthly_budget_limit_usd`** is reasonable — single-digit dollars/month given current scale. Anything over $50 without justification is suspicious for this project's traffic.
- **Three notifications minimum**: `ACTUAL > 50 %`, `ACTUAL > 100 %`, `FORECASTED > 100 %`. Forecasted is the only one that catches a runaway *during* the month — actual lags by up to 24 h. Missing forecasted → High.
- **`budget_alert_emails` non-empty** in `terraform.tfvars` (encrypted). A budget with zero subscribers is a no-op.

### 4. CloudWatch log retention

A static site with poor cache-hit ratio can be drained on egress; a chatty Lambda with infinite log retention bleeds money slowly. Check:

- Every `aws_cloudwatch_log_group` in `infra/*.tf` has `retention_in_days` ≤ 90 (default = forever = $0.50/GB/month forever).
- The Lambda log group specifically — `/aws/lambda/<function-name>` — has it set.
- (Historical: the Phase-0 EventBridge `pii_cleanup` schedule was deleted at the Day 8 cutover. PII retention is now handled by DynamoDB per-item TTL in `infra/dynamodb.tf`, which has no log group of its own. If you see this comment still mentioning a `pii_cleanup` schedule, that's the stale reference to flag.)

### 5. CloudFront cost guardrails

- `price_class = "PriceClass_100"` or `_200` (not `_All`). PriceClass_All bills from every edge location regardless of where users actually live, and the site's audience is South African.
- S3 lifecycle expiring non-current versions on the site bucket — missing = unbounded version growth at $0.023/GB/month forever.
- No WAF needed at current scale (over-engineering for the traffic level) — but if one's been added, confirm it's attached and the scope-down filter doesn't accidentally rate-limit legitimate users.

### 6. <email-service> quota

<email-service>'s free tier is 100 emails/day, 3,000/month. Customer-facing emails fire on:

- Order creation → owner notification + customer pending-payment (2 emails/order).
- ITN payment confirmation → customer "payment received" (1/order).
- Status change in <CMS> Studio → customer status email (1/transition; typically 2-3 transitions per order).

At ~50 orders/month, that's ~250 emails/month — comfortable within free tier.

Verify:
- The <email-service> client (raw `fetch` in `backend/src/email.ts`, per `backend/CLAUDE.md`) handles 429 responses gracefully — doesn't bomb the user-facing request, doesn't auto-retry into a loop.
- A burst of order failures (<CMS> write error) doesn't cascade-email the owner — `backend/src/routes/orders.ts` sends the owner notification AFTER the <CMS> write, so a <CMS> outage means no spam, but verify.
- If `<EMAIL_SERVICE>_API_KEY` ever leaks, the daily/monthly cap on the <email-service> console is the only thing standing between the attacker and a giant bill. Surface as a manual check: "confirm the <email-service> project has its monthly send cap set to a value matching expected legitimate volume (e.g. 1,000/month, not unlimited)."

### 7. <CMS> dataset growth

<CMS> charges per-dataset row count and asset storage on paid plans. At current scale we're on Growth ($15/month, comfortable). The migration to Free (per `docs/orders-pii-split-plan.md`) caps things differently — Free is 2 datasets, 20 user seats. Neither is hit at current scale.

Verify:
- No automated process is hammering <CMS> writes. (Phase 1+ note: there is no scheduled job touching <CMS> at all — PII retention is now DynamoDB-side TTL. Any EventBridge rule still targeting the backend Lambda is unexpected; flag.)
- The <CMS> webhook on order changes fires per-mutation — bounded by the operator's editing rate. Safe.
- Customer-facing surfaces (`POST /orders`) write one <CMS> doc per call. With backend rate limiting + API Gateway throttling in front of it, <CMS> write volume is bounded.

### 8. <payment-processor> volume

<payment-processor> charges per-transaction (~2.9% + R2). Cost scales with legitimate orders. The denial-of-wallet path here is: attacker hits `POST /orders` thousands of times → backend creates <CMS> order docs + <payment-processor> redirect URLs → no real charges because the attacker doesn't complete the redirect, BUT we've burned Lambda invocations + <CMS> rows + <email-service> emails.

The protections:

- Backend rate limiter (check 1) → caps per-IP per-window.
- API Gateway throttling (check 2) → caps cross-instance globally.
- <payment-processor>-side ITN sig verification (check 4 below) → ensures we never confirm a fake payment.

### 9. <payment-processor> ITN-side checks

If an attacker can fake an ITN callback, they can mark unpaid orders as `payment_received` and trigger downstream emails. Verify:

- `backend/src/routes/<payment>-webhook.ts` verifies the MD5 signature over the **raw body** (per `backend/CLAUDE.md`).
- `amount_gross` is cross-checked against the stored `amountZar` — mismatches rejected.
- Status state machine is idempotent — replaying an ITN against an already-confirmed order is a no-op, not a duplicate email.

### 10. Documentation matches reality

This audit's value depends on the docs being honest:

- `docs/security.md § Risk 8` (cost / spend) and `§ Risk 10` (<payment-processor> integrity) match the current code.
- `docs/architecture.md` cost table reflects the actual baseline (~R380/month or whatever the current configuration produces).
- The proposed `docs/orders-pii-split-plan.md` cost table (R77/month post-migration) is internally consistent.

## Report

- **Critical** — `aws_budgets_budget` missing entirely, API Gateway throttling unbounded on `$default`, <payment-processor> ITN signature not verified (already verified per code; flag if the diff weakens it), <email-service> API key in a path that auto-retries on 429.
- **High** — log retention infinite, AWS budget exists but no `FORECASTED` notification (catches runaway only after the fact), `budget_alert_emails` empty / placeholder, CloudFront `PriceClass_All` without justification, no per-IP rate limit on `POST /orders`.
- **Medium** — missing S3 lifecycle for non-current versions, <CMS> webhook handler does anything non-idempotent on status change, PII cleanup logs not captured.
- **Low** — doc drift between `docs/architecture.md` cost table and configured values, alarm exists but not subscribed to a real email, <email-service> console-side monthly cap unconfirmed.

For each finding: file:line + the concrete change. Don't apply fixes without explicit confirmation.

## Useful starting points

- `backend/src/rate-limit.ts` — the in-memory limiter
- `backend/src/routes/orders.ts`, `<payment>-webhook.ts`, `order-lookup.ts`, `cms-webhook.ts` — wired routes
- `infra/budget.tf` — account-wide spend ceiling
- `infra/api_gateway.tf` — request-rate cap
- `infra/lambda.tf` — log retention, runtime, reserved concurrency
- `infra/s3_cloudfront.tf` — CDN cost levers
- `docs/security.md § Risk 8` + `§ Risk 10` — risk register
- `docs/architecture.md` — cost projection these guards defend

## Delegate to

`general-purpose` agent with this file as the prompt body. Cross-cuts code + IaC + docs + provider-console gaps, so it doesn't fit one of the specialised auditors.

Read-only. Findings only. The audit must NOT mutate IaC, run `terraform plan`, hit AWS / <CMS> / <email-service> APIs, or load-test the backend — a load test against `POST /orders` is itself a small spend event.
