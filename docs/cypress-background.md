# Cypress Cloud — background

## What happened

In Cypress v12/v13+, Cypress added code to detect and error on competing dashboard libraries (specifically the `cypress-cloud` module used by Sorry Cypress and Currents.dev). This effectively broke self-hosted and open-source alternatives that had been working up to that point.

Cypress Cloud recording remains fully optional for basic test runs — they didn't force you to use it to run tests, they just blocked the third-party plugins that let you route results elsewhere.

## Why Sorry Cypress and Currents couldn't just use post-run upload

The simple question is: why didn't they just switch to a mochawesome-style post-run upload approach instead of fighting the binary-level blocking?

The answer is that their value proposition was **live orchestration**, not just reporting:

- **Parallel test splitting** across multiple CI machines in real time
- Each Cypress runner pings the orchestration server mid-run to say "give me my next batch of tests"
- **Live run coordination** so machines don't duplicate test files
- Real-time screenshots and video streaming during the run
- Smart grouping and flakiness tracking per run session

This requires a live coordination server that each runner talks to *during* the run. You can't replicate this post-run — by definition the run is already finished.

So they had two choices:
1. Fork the Cypress binary to remove the blocking code (what both Sorry Cypress and Currents did)
2. Drop live orchestration and become a pure reporting tool (which would have meant losing their core feature)

## What this means for your tool

Your tool doesn't try to do live orchestration, so you're not in this fight at all. You're not a Cypress Cloud alternative in the same way — you're a reporting and analytics layer that sits *after* the run, not during it.

CI-native parallelization (Bitbucket `parallel` steps, GitHub Actions matrix) handles the test splitting. Your tool handles what happens with the results once the run is done.

This is a cleaner, simpler architecture with no binary forking, no orchestration server, and no dependency on Cypress internals.

## Workarounds that exist for teams still wanting live orchestration

- Stick to Cypress 12.17.4 (last version before blocking) + Sorry Cypress or Currents
- Use Currents' forked Cypress binaries (block-free, supports newer features)
- Switch to Playwright (no cloud lock-in, native parallelization, full open alternative)
