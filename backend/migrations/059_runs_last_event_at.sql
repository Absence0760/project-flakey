-- DB-authoritative liveness for live runs.
--
-- A live run's "is it still alive?" signal lived ONLY in the in-memory bus
-- (LiveEventBus.runMeta.lastEventAt, bumped by the /events heartbeat). That
-- has two holes:
--   1. A backend restart wipes the in-memory state, so any run that was live
--      at restart is orphaned — nothing tracks it, the stale-run sweeper
--      (getStaleRuns scans the in-memory active set) never sees it, and it
--      stays finished_at IS NULL forever => permanently "LIVE" in the UI.
--   2. The in-memory active set is per-task (applyRemote does NOT mutate it),
--      so once ECS runs >1 task no single task can judge global staleness.
--
-- activeRunIdsForOrg is already DB-authoritative for the same reason; liveness
-- has to be too. This column records the last time ANY live signal (event or
-- empty heartbeat) was received for a run. POST /live/:id/events bumps it on
-- every call; the DB-backed reconciler (reconcileStaleLiveRuns) aborts runs
-- that are unfinished, not already aborted, and quiet past the stale timeout —
-- correct across restarts and tasks, and heartbeat-respecting (a healthy but
-- quiet run keeps advancing last_event_at, so it is never false-aborted).
--
-- Nullable: only live runs carry a meaningful value; batch-uploaded runs never
-- stream and leave it NULL. Readers COALESCE(last_event_at, started_at) so a
-- NULL row still has a sane staleness baseline. runs already enforces org
-- isolation via runs_tenant_isolation; adding a column needs no new policy.

ALTER TABLE runs ADD COLUMN IF NOT EXISTS last_event_at TIMESTAMPTZ;

-- Backfill so pre-existing unfinished orphans (like the run that motivated this)
-- become reconcilable on the first pass: their started_at is already old.
UPDATE runs SET last_event_at = started_at WHERE last_event_at IS NULL;
