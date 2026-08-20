---
description: Run rounds of accessibility hunting across the SvelteKit app — fan out read-only hunters, triage against WCAG 2.2 AA, compute every contrast/size claim, then fix the real violations with a guard in the same commit. The "find and kill a11y violations" loop.
argument-hint: [surface or area — optional; e.g. "the run detail page", "the dashboard cards", "the settings forms". Omit to let the command pick a surface.]
---

Hunt for **accessibility violations** on a surface of the SvelteKit app, then fix the real ones — each verified against the WCAG threshold (computed, not eyeballed), with a guard in the same commit. Target: `$ARGUMENTS` (if empty, pick a route that hasn't been swept recently and say which before hunting).

This is the **rule-driven** sibling of `/ux-hunt`: where `ux-hunt` is judgment (layout, affordance, anti-patterns), a11y-hunt is **measurable** — contrast ratios, target sizes, text-scaling overflow, semantics/labels — held to WCAG 2.2 AA / EU EAA. **hunt → triage → compute the number → fix → pin with a guard → commit per piece → report.** It is the **fix side** of the read-only `/audit/accessibility` reporter: that command finds and reports, this loop fixes and guards.

## When to use this command

**Right fit:**
- "Find and fix accessibility problems" with latitude to choose surfaces.
- Sweeping a route or component cluster for WCAG violations: low-contrast text, sub-minimum targets, content that overflows at 200% text scale, missing labels / roles / alt text, focus-order or keyboard-trap problems.
- Following up the read-only `/audit/accessibility` reporter, or the `persona-accessibility-user` walkthrough — this loop is their fix side.

**Wrong fit — do something else instead:**
- A *judgment* call about whether a layout is good / a flow is confusing → `/ux-hunt` (no objective threshold to compute).
- A correctness bug or perf problem → `/bug-hunt` / `/perf-hunt`.
- A new capability → `/improve-round`.
- Purely visual polish against the project's UI bar → `/polish-ui`.
- Just want a *report*, not fixes → `/audit/accessibility`.

## What counts as an a11y violation (the triage bar)

A finding is worth fixing when it **fails a specific WCAG 2.2 AA success criterion you can name and measure**:
- **1.4.3 Contrast (text)** — < 4.5:1 (normal) / 3:1 (large ≥ 18pt or 14pt bold).
- **1.4.11 Non-text contrast** — < 3:1 for UI component boundaries, icons that carry meaning, chart data colours, focus indicators. This app is dense with status colour (pass/fail/flaky badges, trend charts, at-risk strips) — that's where this criterion bites.
- **2.5.8 Target size** — interactive targets < 24×24 CSS px (aim for the 44–48 px touch norm). Table row actions and icon-only buttons are the usual offenders.
- **1.4.4 / 1.4.10 Reflow + text scale** — content lost or clipped at 200% text / 320 CSS px width. The natural-width tables are the thing to check.
- **1.1.1 / 4.1.2 Name, role, value** — an icon-only button with no label, an image with no alt, a custom control with no role/state, a form field with no associated label.
- **2.4.7 / 2.1.x Focus + keyboard** — invisible focus, a keyboard trap (watch the overlay/modal components), an unreachable control.

Reject, and don't burn a commit on: "feels cramped" (that's `ux-hunt`), a contrast ratio you *guessed* without computing, or a target you didn't actually measure. **Never trade one violation for another** — the classic regression is a contrast "fix" that changes a shared token and breaks the *other* theme, because it was never checked in both.

## Before you start

- **Colour lives in shared tokens.** A bad value is usually wrong everywhere it's used, not just where you found it. Fix the token, then verify the cascade (step 3) — a status colour feeds badges, charts, and the at-risk strips at once.
- **Reuse known-good resolved values** rather than re-deriving them: if a token has already been tuned to clear AA, match it instead of inventing a new one.
- Components live in `frontend/src/lib/components/` grouped by kind (`charts/`, `media/`, `inputs/`, `overlays/`, `panels/`, `status/`). A violation in a shared component is one fix for every route that mounts it — prefer that over a per-route patch. Svelte 5 runes only.

## The loop

### 1. Pick the surface (if `$ARGUMENTS` is empty or vague)

Choose one bounded surface (a route under `frontend/src/routes/` plus the components it mounts) and say which + why.

### 2. Fan out read-only hunters (in parallel)

Spawn hunters in a single message — `general-purpose` agents pointed at the surface's markup + its style tokens — each instructed to find **WCAG 2.2 AA violations** with the criterion named. Have them report, per finding: `file:line`, the criterion (e.g. "1.4.3"), the **measured value** (the two colours / the px size / the scale at which it clips), and the threshold it misses. `/audit/accessibility` is the specialist if you want a deeper single-pass sweep first; `persona-accessibility-user` is available for an assistive-tech walkthrough of the flow.

### 3. Compute every numeric claim before touching code

This is the step that stops one violation becoming another:
- **Contrast**: compute the actual ratio from the two resolved colours (resolve CSS custom properties to hex first) for **both light and dark themes**. A token that passes in one mode can fail in the other — check both.
- **Target size**: measure the real rendered box (padding included), not the glyph.
- **Reflow/scale**: confirm the clip at 200% text / 320 px, don't assume.
- Check whether the token is **shared across surfaces** — fixing it fixes (or breaks) all of them; verify you didn't regress a sibling.

### 4. Fix at the root + pin it, one fix per commit

Each fix is its own commit with its guard in the **same** commit:
- **Fix the root cause** at the shared token or shared component where there is one, not per-call-site — but verify the cascade first (step 3).
- **Pin it.** Add or extend a guard so the regression can't silently return:
  - a **Playwright e2e** assertion in `frontend/tests-e2e/` for focus order, keyboard reachability, accessible name, or reflow at a set viewport;
  - a **source-scan / unit guard** for a class of mistake (every icon-only button carries a label, a token's computed ratio clears AA). Compute the asserted ratio in the test — don't hard-code a number you didn't derive.
  - Per the root `CLAUDE.md`: never satisfy a guard with a sleep, an inflated timeout, or a loosened assertion. Wait on a real signal.
- A fix with no guard is not done. A verified-but-deferred violation gets a tracked follow-up (guard rail 13) — not an unguarded commit and not a passing mention in the report.

**Commit discipline (root `CLAUDE.md` guard rails):**
- Always path-scoped: `git commit -m "…" -- path1 path2 …`. `git add <new-file>` for new files only; never `git add -A`/`-u`, never a bare `git commit`.
- One fix = one commit. `git status` before each; confirm every path is yours.
- No AI attribution / `Co-Authored-By` / robot footer. Commit only — **never `git push`**.

### 5. Report

Short summary: a list of violations fixed (file → criterion → before value vs threshold → after value, both themes where relevant), each with its guard; what was **deferred** and where it's tracked; and any finding dismissed because the computed value actually passed. End with a one-line offer to hunt another surface.

## Tone

- Don't narrate the fan-out — the user reads the diffs.
- **Show the number.** "Text was `#9aa0a6` on `#fff` = 2.6:1, fails 1.4.3; moved to `#5f6368` = 4.6:1" beats "improved contrast". Always state the computed ratio, both themes.
- Lead with the shared-token fix where one exists; name the cascade you verified. 1–2 sentence end-of-turn summary; let the commits speak.
