---
description: WCAG 2.2 AA + EU EAA + ADA pass on the SvelteKit app
---

Audit accessibility across the SvelteKit app — the only user-facing surface this project ships. EU EAA in force from 2025-06-28 made WCAG 2.2 AA a legal requirement for consumer apps sold in the EU.

## Goal

EAA + ADA + state laws (Colorado Privacy Act §6-1-1305, NY Human Rights Law §296) all converge on WCAG 2.2 AA. The audit's job is to find every place we miss the bar.

## What to check

### Web (SvelteKit)

1. **Semantic HTML.** `<button>` vs `<div onClick>`. Every interactive icon-only button needs `aria-label` or visually-hidden text. Walk `frontend/src/lib/components/` (grouped `charts/`, `media/`, `inputs/`, `overlays/`, `panels/`, `status/`) + `frontend/src/routes/`.
2. **Focus management.** Modals (`.modal-backdrop`) trap focus inside the dialog and restore on close. `:focus-visible` ring on every focusable. `tabindex="-1"` on non-interactive elements only.
3. **Colour contrast.** ≥ 4.5:1 on text, ≥ 3:1 on UI components. Walk `app.css` and any inline styles. Dark + light themes both.
4. **Keyboard nav.** Every flow reachable without pointer. Row-click navigation on the run / test tables is the classic offender here — a clickable `<tr>` needs a real focusable control, not just a mouse handler.
5. **Form labels.** Every input has a `<label>` (visible or `aria-labelledby`).
6. **Live regions.** Toasts (`components/overlays/Toasts.svelte`) need `role="status"` / `aria-live="polite"`. Errors `aria-live="assertive"`.
7. **Skip link.** `skip to main content` at top of `+layout.svelte`.
8. **Motion-reduce.** `@media (prefers-reduced-motion: reduce)` honoured for live-run pulse indicators, chart transitions, and every animated state change.
9. **Headings.** One `<h1>` per page; descending order without skips.
10. **Charts + status colour.** Trend charts, flake heatmaps, and pass/fail/flaky badges must not carry meaning by hue alone (1.4.1) and need ≥ 3:1 non-text contrast (1.4.11). Every chart needs a text or table equivalent of the same data.

## Report

- **Critical** — flow is unreachable without sight or without pointer (image-only signup, modal that traps focus on the close button).
- **High** — WCAG 2.2 AA fail that's clearly testable (contrast ratio < 4.5:1, missing aria-label, no keyboard alt).
- **Medium** — best practice gap (no skip link, headings out of order, missing live region on a toast).
- **Low** — polish (focus ring style, motion-reduce on non-critical animation).

For each: file/line, the success criterion (e.g. WCAG 2.4.7 Focus Visible, 1.4.3 Contrast Minimum), and the fix.

End with a **clean** list of surfaces you confirmed pass.

This command **reports only**. `/a11y-hunt` is its fix side — it takes these findings, computes each threshold, fixes the root cause, and lands a guard.

## Delegate to

Use the `compliance-auditor` agent: `"Audit accessibility across the SvelteKit app per WCAG 2.2 AA / EU EAA / ADA. Write the report to reviews/accessibility.md."`

Read-only on the codebase. The deliverable is the findings report written to **`reviews/accessibility.md`** (the agent returns a short summary of it).
