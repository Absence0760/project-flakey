---
description: Inventory dependency licenses across the three toolchains and flag copyleft / unknown / attribution-missing licenses that create legal risk for a shipped self-hosted product and the published @flakeytesting/* packages
---

Walk every dependency tree in the monorepo, collect the declared license of each package, and flag the ones that create legal risk for shipping a proprietary self-hosted product (SOC 2 + GovRAMP posture) and for the `@flakeytesting/*` packages we publish to npm.

## Goal

`/audit/deps` answers "is anything vulnerable / out of date." This audit answers a *different* question that the same `package-lock.json` / `pnpm-lock.yaml` files happen to encode: "are we legally clear to ship and redistribute every byte of this." A clean `npm audit` says nothing about an AGPL transitive dependency that would force us to publish source, or a package with no license field at all. **Do not re-report CVEs, version drift, or GitHub Actions pinning here** — those belong to `/audit/deps`; cross-reference and move on. The deliverable is a license *inventory* plus a flagged risk list, not a security advisory.

Two facts shape the risk model:

- Flakey ships as a **self-hosted, proprietary product** (we distribute the backend + frontend bundle to customers who run it on their own infra). A copyleft dep linked into that shipped artifact is a real obligation, not a theoretical one.
- The `@flakeytesting/*` reporter packages are **published to npm** (`publish.yml`, MIT-declared — see below). When we publish, we *redistribute* every runtime dependency of that package to every downstream user. A bad license in a published package's runtime tree is worse than the same license in a dev-only backend tool.

## What to check

1. **Run the license tooling per toolchain and collect raw output.** Three trees, three commands:
   - **Backend (npm):** in `backend/`, `npx license-checker --summary` for the histogram, then `npx license-checker --json` for the per-package detail (path, repo, license, license file). Backend has its own `package-lock.json` and is outside the pnpm workspace — run it there, not at the root.
   - **Frontend (pnpm):** in `frontend/`, `pnpm licenses list` (and `pnpm licenses list --json`). The frontend has its own `pnpm-lock.yaml` and is not a workspace member.
   - **Packages workspace (pnpm):** at the repo **root**, `pnpm licenses list` — this walks every `packages/*` member via `pnpm-workspace.yaml`. Run per-package too where a member's runtime tree matters (the published reporters).
   If a tool isn't installed, `npx`/`pnpm dlx` it; don't skip a toolchain. Capture the raw histogram in the report so the inventory is reproducible.

2. **Copyleft and network-copyleft — the High-severity class.** Flag every `GPL-*`, `AGPL-*`, `LGPL-*`, `MPL-*`, `EUPL`, `CDDL`, `SSPL`, `OSL` (and dual licenses that *include* one, e.g. `(MIT OR GPL-2.0)` is fine, `GPL-2.0` alone is not). For each, trace **which tree** it's in:
   - In the **backend** or **frontend** runtime dependencies (shipped to customers) → High. AGPL in a shipped path is the worst case — its network-use clause can trigger even for a hosted dashboard.
   - In a **published `@flakeytesting/*` package's** `dependencies` (not `devDependencies`) → High, and louder: we redistribute it under our own MIT banner.
   - In `devDependencies` / build-only tooling that never ships → Low/Medium (note it, but a build-time GPL tool generally doesn't infect output — say so explicitly).
   Distinguish "linked/bundled into the artifact" from "invoked as a separate tool" — that distinction is the whole finding.

3. **UNLICENSED / UNKNOWN / missing license field — the Medium class.** `license-checker` reports `UNKNOWN`; `pnpm licenses list` shows blanks. A transitive dep with no resolvable license is legally unusable until clarified — you have *no* grant to redistribute it. List each with its dependency path (who pulls it in) so it can be replaced or pinned to a licensed version. Note: our own `backend/package.json`, `frontend/package.json`, and root `package.json` have **no `license` field** — that's fine for `"private"` un-published packages but flag it as a hygiene item (the repo ships under the top-level `LICENSE`, which is MIT — see #6).

4. **Attribution-required permissive licenses with no attribution provided.** MIT, BSD-2/3-Clause, ISC, Apache-2.0 are all fine to ship *but* require preserving the copyright notice / license text. Apache-2.0 additionally requires NOTICE-file propagation if upstream ships one. There is no `THIRD_PARTY_NOTICES` / `NOTICES` file in the repo today — flag the absence as a Medium for the **shipped** artifacts (backend + frontend bundle) and recommend generating one from the `license-checker --json` output. This is a SOC 2 / GovRAMP-relevant control (license obligation tracking).

5. **The published `@flakeytesting/*` packages — extra care.** All nine members under `packages/*` (`@flakeytesting/cli`, `core`, `cypress-reporter`, `cypress-snapshots`, `live-reporter`, `mcp-server`, `playwright-reporter`, `playwright-snapshots`, `webdriverio-reporter`) declare `"license": "MIT"` and are publishable (none set `"private": true`). For each:
   - Confirm the declared `license` field is present and accurate (MIT today — a member that drops or mis-declares it is a finding).
   - Walk its **runtime `dependencies`** licenses (we redistribute these). A copyleft runtime dep in a package we publish as MIT is a High finding and a license-conflict (we can't relicense GPL as MIT).
   - Confirm a `LICENSE` file is actually included in the published tarball (`files` allow-list / npm default). MIT requires the license text travel with the code; a declared-but-absent `LICENSE` in the tarball is a Medium.

6. **The repo's own LICENSE.** The top-level `LICENSE` is **MIT** (`Copyright (c) 2026 Liability1235`). Sanity-check it: the copyright holder placeholder looks like a stub (`Liability1235`) — flag as Low if it should be the real legal entity. Confirm the MIT grant is consistent with shipping a *proprietary* self-hosted product — MIT on our own first-party code is permissive and fine, but note any mismatch between "we describe the product as proprietary" and "our LICENSE grants MIT to everyone." That tension is worth surfacing to the CISO, not silently resolving.

7. **Per finding, recommend one of:** *replace* (swap the dep for a permissively-licensed equivalent — name a candidate where you can), *pin* (hold at a known-licensed version while the newer one is UNKNOWN), *add attribution* (generate/extend the `THIRD_PARTY_NOTICES` file), or *legal review* (the call isn't yours — copyleft-in-shipped-path and the proprietary-vs-MIT question both go to legal / CISO, not a code fix).

## Report

Group by severity. For SOC 2 / GovRAMP, license obligations are an auditable control — be precise about *which artifact* carries each obligation, since "ships to customers" vs "build-only" changes the answer.

- **High** — copyleft / network-copyleft (`GPL`, `AGPL`, `LGPL`, `SSPL`, `OSL`, `MPL` linked-in) in a **shipped** path (backend or frontend runtime) **or** in a published `@flakeytesting/*` package's runtime dependencies; a published package mis-declaring or dropping its `license` field.
- **Medium** — `UNKNOWN`/`UNLICENSED`/blank-license transitive dep anywhere; missing attribution for permissive deps in a shipped artifact (no `THIRD_PARTY_NOTICES`); a published package whose `LICENSE` text isn't in the tarball.
- **Low** — permissive-but-uncommon license worth noting (`BlueOak`, `0BSD`, `Unlicense`, `WTFPL`, `Zlib`, `Python-2.0`) that's fine to ship but should be on the record; missing `license` field on a `private` first-party package; the `LICENSE` copyright-holder stub; build-only / dev-only copyleft (note the no-infect reasoning).

For each finding: the package + version, the **toolchain/tree** it lives in (backend npm / frontend pnpm / which `packages/*` member), the declared license, the **dependency path** (what pulls it in, for transitives), whether it ships or is build-only, and the recommended action (replace / pin / add attribution / legal review). Lead the report with the three raw license histograms so the inventory is reproducible.

## Useful starting points

- `backend/package.json` + `backend/package-lock.json` — the npm tree (run `license-checker` here)
- `frontend/package.json` + `frontend/pnpm-lock.yaml` — the frontend pnpm tree
- `pnpm-workspace.yaml` + root `pnpm-lock.yaml` — covers `packages/*`
- `packages/*/package.json` — the nine published reporters; their `license` field, `dependencies`, and `files`
- `LICENSE` — the repo's own MIT grant (`Copyright (c) 2026 Liability1235`)
- root `package.json` — note the missing `license` field on the workspace root

## Delegate to

Use the `general-purpose` agent with this file as the prompt body — the work is mostly running each license tool in turn, classifying output, and tracing dependency paths, which is well within one agent's scope. Instruct it to **write the full report to `reviews/licenses.md`** (overwrite if present) and return a short summary. Read-only on the codebase otherwise — `reviews/licenses.md` is the only file it writes; it applies no dependency or license changes (replacements and the proprietary-vs-MIT question are operator/legal calls, surfaced as recommendations).
