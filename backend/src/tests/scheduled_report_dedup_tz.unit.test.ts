/**
 * Timezone-correctness guard for the scheduled-report daily dedup predicate
 * (DAILY_NOT_SENT_TODAY_SQL in src/scheduled-reports.ts).
 *
 * The sweep decides "is it time to send?" in UTC (hour_utc / day_of_week are
 * compared against JS getUTCHours()/getUTCDay()). The dedup "have I already
 * sent today?" must therefore also use the UTC calendar day. A naive
 * `last_sent_at::date < CURRENT_DATE` resolves the day boundary in the DB
 * *session* timezone, so on a non-UTC session a daily report can re-send
 * within the same UTC day. These tests pin the UTC-anchored behaviour and
 * demonstrate the divergence the naive form would have introduced.
 *
 * DB-backed (evaluated by Postgres, the way the app runs it). Skipped if the
 * DB is unreachable, mirroring the other DB unit tests.
 *
 * Run: node --import tsx --test src/tests/scheduled_report_dedup_tz.unit.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { DAILY_NOT_SENT_TODAY_SQL } from "../scheduled-reports.js";

const HOST = process.env.DB_HOST ?? "localhost";
const PORT = Number(process.env.DB_PORT ?? 5432);
const DB = process.env.DB_NAME ?? "flakey";
const USER = process.env.DB_USER ?? "flakey_app";
const PASSWORD = process.env.DB_PASSWORD ?? "flakey_app";

// A zone ahead of UTC and one behind it, so the local calendar day is on the
// far side of the UTC day boundary in both directions.
const SESSION_ZONES = ["UTC", "Pacific/Kiritimati" /* +14 */, "Etc/GMT+12" /* -12 */];

let pool: pg.Pool | null = null;
let canRun = false;

before(async () => {
  pool = new pg.Pool({ host: HOST, port: PORT, user: USER, password: PASSWORD, database: DB });
  try {
    await pool.query("SELECT 1");
    canRun = true;
  } catch (err) {
    console.warn(`[dedup-tz] could not connect, skipping: ${(err as Error).message}`);
  }
});

after(async () => {
  await pool?.end();
});

// Evaluate the real predicate against a supplied `last_sent_at` expression,
// under a specific session timezone. Returns the boolean it yields.
async function evalDaily(lastSentAtSql: string, tz: string): Promise<boolean> {
  const client = await pool!.connect();
  try {
    await client.query(`SET TIME ZONE '${tz}'`);
    const r = await client.query<{ not_sent: boolean }>(
      `SELECT ${DAILY_NOT_SENT_TODAY_SQL} AS not_sent
         FROM (SELECT ${lastSentAtSql} AS last_sent_at) s`
    );
    return r.rows[0].not_sent;
  } finally {
    client.release();
  }
}

// Start of the current UTC day, as a timestamptz — always on the same UTC
// calendar day as NOW(), so "already sent today".
const START_OF_TODAY_UTC =
  "date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'";
// Noon of the previous UTC day — unambiguously a day earlier in UTC.
const NOON_YESTERDAY_UTC =
  "date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '12 hours'";

test("sent earlier today (UTC) → NOT due to send again, in every session timezone", async () => {
  if (!canRun) return;
  for (const tz of SESSION_ZONES) {
    const notSent = await evalDaily(START_OF_TODAY_UTC, tz);
    assert.equal(
      notSent,
      false,
      `under session TZ ${tz}: a report sent at the start of today (UTC) must be deduped (not_sent=false)`
    );
  }
});

test("sent yesterday (UTC) → due to send again, in every session timezone", async () => {
  if (!canRun) return;
  for (const tz of SESSION_ZONES) {
    const notSent = await evalDaily(NOON_YESTERDAY_UTC, tz);
    assert.equal(
      notSent,
      true,
      `under session TZ ${tz}: a report last sent yesterday (UTC) must be eligible (not_sent=true)`
    );
  }
});

test("never sent (NULL) → due to send, in every session timezone", async () => {
  if (!canRun) return;
  for (const tz of SESSION_ZONES) {
    const notSent = await evalDaily("NULL::timestamptz", tz);
    assert.equal(notSent, true, `under session TZ ${tz}: a never-sent report must be eligible`);
  }
});

test("naive ::date dedup diverges across timezones — the bug the UTC anchor avoids", async () => {
  if (!canRun) return;
  // Two fixed instants on the SAME UTC day (2026-06-08). Under UTC+14 they
  // straddle a *local* midnight, so the session-local calendar dates differ
  // even though the UTC dates are identical.
  const last = "timestamptz '2026-06-08 05:00:00+00'";
  const ref = "timestamptz '2026-06-08 15:00:00+00'";
  const client = await pool!.connect();
  try {
    await client.query(`SET TIME ZONE 'Pacific/Kiritimati'`);
    const r = await client.query<{ naive_due: boolean; utc_due: boolean }>(
      `SELECT ${last}::date < ${ref}::date AS naive_due,
              (${last} AT TIME ZONE 'UTC')::date < (${ref} AT TIME ZONE 'UTC')::date AS utc_due`
    );
    // The naive form wrongly reports "a new day → due" within one UTC day...
    assert.equal(r.rows[0].naive_due, true, "naive ::date should flip to due under UTC+14 (the bug)");
    // ...while the UTC-anchored form (used by the app) correctly says "not yet".
    assert.equal(r.rows[0].utc_due, false, "UTC-anchored predicate must stay false within the same UTC day");
  } finally {
    client.release();
  }
});
