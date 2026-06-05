---
description: WCAG 2.2 AA + EU EAA + ADA pass on web, mobile, and watch surfaces
---

Audit accessibility across every user-facing surface. EU EAA in force from 2025-06-28 made WCAG 2.2 AA a legal requirement for consumer apps sold in the EU.

## Goal

EAA + ADA + state laws (Colorado Privacy Act §6-1-1305, NY Human Rights Law §296) all converge on WCAG 2.2 AA. The audit's job is to find every place we miss the bar.

## What to check

### Web (SvelteKit)

1. **Semantic HTML.** `<button>` vs `<div onClick>`. Every interactive icon-only button needs `aria-label` or visually-hidden text. Walk `the web app/src/lib/components/` + `the frontend routes directory`.
2. **Focus management.** Modals (`.modal-backdrop`) trap focus inside the dialog and restore on close. `:focus-visible` ring on every focusable. `tabindex="-1"` on non-interactive elements only.
3. **Colour contrast.** ≥ 4.5:1 on text, ≥ 3:1 on UI components. Walk `app.css` and any inline styles. Dark + light themes both.
4. **Keyboard nav.** Every flow reachable without pointer. The route builder's tap-to-place is a classic offender — needs a keyboard alternative.
5. **Form labels.** Every input has a `<label>` (visible or `aria-labelledby`).
6. **Live regions.** Toasts (`ToastContainer`) need `role="status"` / `aria-live="polite"`. Errors `aria-live="assertive"`.
7. **Skip link.** `skip to main content` at top of `+layout.svelte`.
8. **Motion-reduce.** `@media (prefers-reduced-motion: reduce)` honoured for the buttery-dot animation, the celebration confetti, every transition.
9. **Headings.** One `<h1>` per page; descending order without skips.
10. **Map a11y.** Maps are the hardest. At minimum a "view as list" alternative for run history, route detail, segment leaderboards.

### Mobile (if the project has a mobile target)

11. **Semantics widgets.** Every `IconButton`, gesture detector, custom-painted tappable needs a `Semantics(label: ..., button: true, ...)` wrapper.
12. **Screen-reader labels.** Icon-only buttons in `RunScreen` (start, pause, lap, stop), `DashboardScreen` cards, `RouteBuilderScreen` mode toggle.
13. **Dynamic type.** `MediaQuery.textScaleFactor` respected — text doesn't overflow at 200%.
14. **Colour contrast.** Same bar as web.
15. **Touch targets.** Min 44×44 px (Apple HIG, Material).
16. **Live regions.** `SemanticsService.announce(...)` for important state changes (run started, lap recorded).
17. **Reduce motion.** `MediaQuery.disableAnimations`.

### Wear OS (Compose-for-Wear)

18. **TalkBack.** Every action reachable + announced. Compose has `Modifier.semantics` — verify usage.
19. **Glanceability.** Font size, contrast, in cold/wet conditions (white/red/green/blue legibility).
20. **Max-font.** Compliant with the platform user-font-size setting.

### Apple Watch (SwiftUI)

21. **VoiceOver.** `.accessibilityLabel`, `.accessibilityHint`, `.accessibilityAddTraits(.isButton)`.
22. **Dynamic Type.** SwiftUI inherits this when using built-in text styles.
23. **Reduce Motion.** `@Environment(\.accessibilityReduceMotion)`.

## Report

- **Critical** — flow is unreachable without sight or without pointer (image-only signup, modal that traps focus on the close button).
- **High** — WCAG 2.2 AA fail that's clearly testable (contrast ratio < 4.5:1, missing aria-label, no keyboard alt).
- **Medium** — best practice gap (no skip link, headings out of order, missing live region on a toast).
- **Low** — polish (focus ring style, motion-reduce on non-critical animation).

For each: file/line, the success criterion (e.g. WCAG 2.4.7 Focus Visible, 1.4.3 Contrast Minimum), and the fix.

End with a **clean** list of surfaces you confirmed pass.

## Delegate to

Use the `compliance-auditor` agent: `"Audit accessibility across web + mobile + watch per WCAG 2.2 AA / EU EAA / ADA. Write the report to reviews/accessibility.md."`

Read-only on the codebase. The deliverable is the findings report written to **`reviews/accessibility.md`** (the agent returns a short summary of it).
