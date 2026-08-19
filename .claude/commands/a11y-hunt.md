---
description: Run rounds of accessibility hunting across whatever surfaces the project ships — fan out read-only hunters, triage against WCAG 2.2 AA, compute every contrast/size claim, then fix the real violations with a guard in the same commit. The "find and kill a11y violations" loop.
argument-hint: [surface or area — optional; e.g. "the detail view", "the dashboard cards", "the settings forms". Omit to let the command pick a surface.]
---

Hunt for **accessibility violations** on a surface, then fix the real ones — each verified against the WCAG threshold (computed, not eyeballed), with a guard in the same commit. Target: `$ARGUMENTS` (if empty, pick a surface that hasn't been swept recently and say which before hunting).

This is the **rule-driven** sibling of `/ux-hunt`: where `ux-hunt` is judgment (layout, affordance, anti-patterns), a11y-hunt is **measurable** — contrast ratios, tap-target sizes, text-scaling overflow, semantics/labels, RTL — held to WCAG 2.2 AA / EU EAA. **hunt → triage → compute the number → fix every surface → pin with a guard → commit per piece → report.** It is the **fix side** of the read-only `/audit/accessibility` reporter: that command finds and reports, this loop fixes and guards.

## When to use this command

**Right fit:**
- "Find and fix accessibility problems" with latitude to choose surfaces.
- Sweeping a screen/route for WCAG violations: low-contrast text, sub-minimum tap targets, content that overflows at 200% text scale, missing labels / roles / alt text, focus-order or keyboard-trap problems, an RTL layout that mirrors wrong.
- Following up the read-only `/audit/accessibility` reporter — this loop is its fix side.

**Wrong fit — do something else instead:**
- A *judgment* call about whether a layout is good / a flow is confusing → `/ux-hunt` (no objective threshold to compute).
- A correctness bug or perf problem → `/bug-hunt` / `/perf-hunt`.
- A new capability → `/improve-round`.
- Just want a *report*, not fixes → `/audit/accessibility`.

## What counts as an a11y violation (the triage bar)

A finding is worth fixing when it **fails a specific WCAG 2.2 AA success criterion you can name and measure**:
- **1.4.3 Contrast (text)** — < 4.5:1 (normal) / 3:1 (large ≥ 18pt or 14pt bold).
- **1.4.11 Non-text contrast** — < 3:1 for UI component boundaries, icons that carry meaning, chart/graph data colours, focus indicators.
- **2.5.8 Target size** — interactive targets < 24×24 CSS px (aim for the 44–48 px touch norm).
- **1.4.4 / 1.4.10 Reflow + text scale** — content lost or clipped at 200% text / 320 CSS px width.
- **1.1.1 / 4.1.2 Name, role, value** — an icon-only button with no label, an image with no alt, a custom control with no role/state, a form field with no associated label.
- **2.4.7 / 2.1.x Focus + keyboard** — invisible focus, a keyboard trap, an unreachable control.
- **1.3.2 / 3.x RTL + direction** — physical `left`/`right` where a logical (`start`/`end`, or the platform's directional equivalent) is required.

Reject, and don't burn a commit on: "feels cramped" (that's `ux-hunt`), a contrast ratio you *guessed* without computing, or a target you didn't actually measure. **Never trade one violation for another** — the classic regression is a contrast "fix" that changes a shared value and breaks the *other* theme, because it was never checked in both.

## Before you start

- If the project ships more than one surface (web, mobile, watch, desktop…), a contrast value or a missing label is usually wrong in the **same place on every surface** — fix them as a matched set, not one platform at a time.
- **Reuse known-good resolved values** rather than re-deriving them: if a colour token or spacing value has already been tuned to clear AA, match it instead of inventing a new one.
- The read-only `/audit/accessibility` command (via the `compliance-auditor` agent) is the upstream reporter; this loop fixes what it finds and adds the guard.

## The loop

### 1. Pick the surface (if `$ARGUMENTS` is empty or vague)

Choose one bounded surface (a route + its components, a screen, a card cluster) and say which + why. Sweep it on **every surface it ships on** — the same defect usually recurs in the same place across platforms.

### 2. Fan out read-only hunters (in parallel)

Spawn hunters in a single message — `general-purpose` agents pointed at the surface's files (the web markup + its style tokens; any mobile/native widgets; any watch/desktop equivalent), each instructed to find **WCAG 2.2 AA violations** with the criterion named. Have them report, per finding: `file:line`, the criterion (e.g. "1.4.3"), the **measured value** (the two colours / the px size / the scale at which it clips), the threshold it misses, and which surfaces share the defect. The `compliance-auditor` (via `/audit/accessibility`) is the specialist if you want a deeper single-pass sweep first. `persona-accessibility-user` is available for an assistive-tech-user walkthrough of the flow.

### 3. Compute every numeric claim before touching code

This is the step that stops one violation becoming another:
- **Contrast**: compute the actual ratio from the two resolved colours (resolve CSS variables / theme tokens to hex first) for **both light and dark themes**. A token that passes in one mode can fail in the other — check both.
- **Target size**: measure the real rendered box (padding included), not the glyph.
- **Reflow/scale**: confirm the clip at 200% text / 320 px, don't assume.
- Check whether the same token/value is **shared across many surfaces** — fixing the token fixes (or breaks) all of them; verify you didn't regress a sibling. A global card / button / colour token can cascade into many pages.

### 4. Fix at the root + pin it, one fix per commit

Each fix is its own commit with its guard/test in the **same** commit:
- **Fix the root cause** at the shared token where there is one (the colour variable, the button base, the spacing scale), not per-call-site — but verify the cascade first (step 3).
- **Fix every surface the violation ships on in the same piece** — don't fix web contrast and leave the mobile/native equivalent failing.
- **i18n**: any new user-facing label/alt text added for a name/role fix goes into every locale the project ships, and its parity check (if the project has one) must stay green.
- **Pin it.** Add or extend a source-level guard test that asserts the contrast ratio clears AA, the target meets the minimum, or the logical property is used — so the regression can't silently return. Compute the asserted ratio in the test, don't hard-code a number you didn't derive.
- **Every violation fixed in this loop gets its guard in the same commit — including ones found incidentally**, and across **every** theme/locale/surface the criterion applies to (both light + dark for contrast, every locale for a label, every platform for a shared control). A fix with no guard is not done; a verified-but-deferred violation goes to the project's followups/deferred-work doc, not into an unguarded commit.

**Commit discipline (root `CLAUDE.md` guard rails):**
- Always path-scoped: `git commit -m "…" -- path1 path2 …`. `git add <new-file>` for new files only; never `git add -A`/`-u`, never a bare `git commit`.
- One fix = one commit. `git status` before each; confirm every path is yours.
- No AI attribution / `Co-Authored-By` / robot footer. Commit only — **never `git push`** without an explicit ask.

### 5. Report

Short summary: a list of violations fixed (file → criterion → before value vs threshold → after value, both themes where relevant), each with its guard; which surfaces each fix covered; what was **deferred** and why (tracked in the project's followups/deferred-work doc); and any finding dismissed because the computed value actually passed. End with a one-line offer to hunt another surface.

## Tone

- Don't narrate the fan-out — the user reads the diffs.
- **Show the number.** "Text was `#9aa0a6` on `#fff` = 2.6:1, fails 1.4.3; moved to `#5f6368` = 4.6:1" beats "improved contrast". Always state the computed ratio, both themes.
- Be honest about surface coverage: say if a fix landed on web + mobile but the watch/desktop equivalent is deferred.
- Lead with the shared-token fix where one exists; name the cascade you verified. 1–2 sentence end-of-turn summary; let the commits speak.
