-- Cypress failure-context capture (Phase 13).
-- Stores the runtime context a Cypress red actually needs to diagnose it:
-- the tail of cy.* commands before the failure, browser console output,
-- uncaught exceptions / unhandled rejections, failed network requests, and
-- the per-attempt error trail for retried tests. This is the Cypress
-- counterpart to the Playwright trace -> command-log already captured in
-- metadata for the Playwright reporter.
--
-- Schema-less JSONB so the reporter can evolve the captured shape without a
-- migration. NULL for tests that recorded no context (passing tests, or
-- non-Cypress reporters that never populate it). Mirrors the command_log
-- column added in 002 — no GRANT needed; flakey_app already holds table-level
-- privileges that extend to new columns.
ALTER TABLE tests ADD COLUMN IF NOT EXISTS failure_context JSONB;

COMMENT ON COLUMN tests.failure_context IS
  'Cypress failure context (Phase 13). Shape: { commands_tail: [{name,message,state}], browser_console: string[], uncaught_errors: string[], network_failures: string[], retry_errors: [{attempt,message,stack?}] }. NULL when nothing was captured.';
