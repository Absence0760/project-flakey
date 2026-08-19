---
description: Audit the project's GDPR posture — lawful basis, consent, DSAR, retention, transfers, age gate, breach plan
---

Audit the GDPR / UK GDPR posture of this monorepo. The goal is a punch list the user can fix before opening signup to EU / UK / EEA users.

## Goal

GDPR fines are calibrated to global revenue, not local impact. The headline numbers (€20M or 4% of global turnover) get the press; the actual launch risk is reviewer rejection by Apple / Google Play if no in-app privacy policy + account-deletion + age-gate exist. Find every gap.

## What to check

1. **Privacy policy + Terms of Service.** Do `/privacy` and `/terms` routes exist in `the frontend routes directory`? Are they linked from the signup form, the marketing footer, and the iOS / Android in-app surface? Without them, both stores reject.
2. **Lawful basis (Art 6) per data category.** For each personal-data column the user listed in `compliance-auditor.md`, what lawful basis would the user claim? Consent / contract / legitimate interest are the three plausible ones. Health data (HR, <sensitive data categories — list yours>) probably needs Art 9 explicit consent. Flag every column that has no obvious basis.
3. **Consent capture.** No cookie / SDK consent banner today on the web app — confirm. Document what would need to fire only after consent on an EU IP (the error monitor, the map provider, the subscription-SDK, AI streaming endpoint).
4. **DSAR endpoints.**
   - **Export (Art 20)**: `the data-export worker` (primary) and `the data-export backend route` (rollback). Are they wired to a UI surface? Is the output machine-readable JSON or CSV (Art 20 requires "structured, commonly used, machine-readable")?
   - **Erasure (Art 17)**: `the account-deletion backend route`. Does the UI expose it on every platform (web, Android, iOS, watches that have account state)?
   - **Rectification (Art 16)**: edit-profile flow. Verify it.
   - **Access (Art 15)**: same surface as export, usually.
   - **Restriction (Art 18) + objection (Art 21)**: do we honour an "object to processing" flow at all today? Probably not.
5. **Retention.** Are there documented retention periods? Stale session-event tables, abandoned AI-conversation tables, half-finished signups in the user-auth table? Without auto-deletion this is a "keep forever" posture, which is hard to defend.
6. **Cross-border transfers (Chapter V).** each processor's region (data platform, cloud regions, AI provider, etc.)? (third-party providers have their own regions). Every flow from an EU data subject to a non-EU processor needs SCCs or an adequacy decision. List the flows + their required mechanism.
7. **DPO + EU representative (Art 27).** If we have no establishment in the EU and offer goods/services to EU residents, we need an EU rep listed in the Privacy Policy. Do we?
8. **Children (Art 8).** Member-state age of consent ranges from 13 (BE) to 16 (most of EU). The app does not collect age and has no age gate. Apple requires age gating in App Store Connect; Play requires the Data Safety form to declare "targets children?" If we're not children-targeted, we still need to discourage <16 signups for EU.
9. **Breach notification (Art 33/34).** Is there an on-call runbook for a personal-data breach? 72-hour clock to the supervisory authority. Probably not documented anywhere today.
10. **Records of processing (Art 30).** Do we maintain a Record of Processing Activities (the RoPA)? It's a sub-processor list + lawful basis matrix. The output of `/audit/third-party-data-flows` is essentially this — confirm we have a static copy.
11. **Cookie / ePrivacy.** ePrivacy Directive (still in force; the GDPR did not replace it) requires consent for non-essential cookies + scripts. Audit the load order of every third-party SDK on the web entry.
12. **DPIA (Art 35).** Continuous location + biometric data are explicitly named in EDPB guidance as "high-risk processing" requiring a DPIA before launch. Is there one?

## Report

- **Critical** — store-rejection blockers (no in-app privacy policy, no account-deletion UI, no age gate where required).
- **High** — required by GDPR for any EU user signup (no consent banner before SDK load, no DSAR UI, no SCCs for US processors).
- **Medium** — best-practice gap (no retention policy, no RoPA, no DPIA on live-location).
- **Low** — defence-in-depth (no admin-access audit log, no per-request data-handling log).

For each: regime cite (GDPR Art X / UK ICO guidance / EDPB op-N) + concrete fix scope (file or "policy doc + product change").

End with a **clean** list of GDPR areas that look fine.

## Delegate to

Use the `compliance-auditor` agent: `"Audit the GDPR / UK GDPR posture of this monorepo."`

Read-only. Findings only. Always end legal claims with "ask counsel if unsure" — this is not legal advice.
