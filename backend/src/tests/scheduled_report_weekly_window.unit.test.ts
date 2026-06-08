/**
 * Window-correctness guard for the scheduled-report weekly dedup predicate
 * (WEEKLY_NOT_SENT_THIS_WEEK_SQL in src/scheduled-reports.ts).
 *
 * The daily predicate has its own timezone guard (scheduled_report_dedup_tz);
 * this is the weekly counterpart. The weekly window is an absolute-instant
 * comparison — `last_sent_at < NOW() - INTERVAL '6 days'`, both sides
 * timestamptz — so unlike the daily `::date` predicate it must yield the SAME
 * answer in every DB session timezone (there is no calendar boundary to
 * resolve). These tests pin both that timezone-independence AND the 6-day
 * window boundary: a report sent within the last 6 days is deduped, one sent
 * longer ago (or never) is due. Combined with the caller's `day_of_week`
 * gate, this is what keeps a weekly report on a clean ~7-day cadence without
 * re-sending twice in one week.
 *
 * DB-backed (evaluated by Postgres, the way the app runs it). Skipped if the
 * DB is unreachable, mirroring the daily test.
 *
 * Run: node --import tsx --test src/tests/scheduled_report_weekly_window.unit.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { WEEKLY_NOT_SENT_THIS_WEEK_SQL } from "../scheduled-reports.js";

const HOST = process.env.DB_HOST ?? "localhost";
const PORT = Number(process.env.DB_PORT ?? 5432);
const DB = process.env.DB_NAME ?? "flakey";
const USER = process.env.DB_USER ?? "flakey_app";
const PASSWORD = process.env.DB_PASSWORD ?? "flakey_app";

// A zone ahead of UTC and one behind it. The weekly window must be immune to
// the session timezone, so the answer has to be identical across all three.
const SESSION_ZONES = ["UTC", "Pacific/Kiritimati" /* +14 */, "Etc/GMT+12" /* -12 */];

let pool: pg.Pool | null = null;
let canRun = false;

before(async () => {
  pool = new pg.Pool({ host: HOST, port: PORT, user: USER, password: PASSWORD, database: DB });
  try {
    await pool.query("SELECT 1");
    canRun = true;
  } catch (err) {
    console.warn(`[weekly-window] could not connect, skipping: ${(err as Error).message}`);
  }
});

after(async () => {
  await pool?.end();
});

// Evaluate the real predicate against a supplied `last_sent_at` expression,
// under a specific session timezone. Returns the boolean it yields.
async function evalWeekly(lastSentAtSql: string, tz: string): Promise<boolean> {
  const client = await pool!.connect();
  try {
    await client.query(`SET TIME ZONE '${tz}'`);
    const r = await client.query<{ due: boolean }>(
      `SELECT ${WEEKLY_NOT_SENT_THIS_WEEK_SQL} AS due
         FROM (SELECT ${lastSentAtSql} AS last_sent_at) s`
    );
    return r.rows[0].due;
  } finally {
    client.release();
  }
}

test("never sent (NULL) → due, in every session timezone", async () => {
  if (!canRun) return;
  for (const tz of SESSION_ZONES) {
    assert.equal(await evalWeekly("NULL::timestamptz", tz), true, `under TZ ${tz}: a never-sent weekly report must be due`);
  }
});

test("sent just now → NOT due (deduped within the week), in every session timezone", async () => {
  if (!canRun) return;
  for (const tz of SESSION_ZONES) {
    assert.equal(await evalWeekly("now()", tz), false, `under TZ ${tz}: a report sent now must be deduped`);
  }
});

test("sent 7 days ago → due again (next week's window is open), in every session timezone", async () => {
  if (!canRun) return;
  for (const tz of SESSION_ZONES) {
    assert.equal(
      await evalWeekly("now() - interval '7 days'", tz),
      true,
      `under TZ ${tz}: a report last sent 7 days ago must be due`,
    );
  }
});

test("sent 5 days ago → NOT due (still inside the 6-day window)", async () => {
  if (!canRun) return;
  for (const tz of SESSION_ZONES) {
    assert.equal(
      await evalWeekly("now() - interval '5 days'", tz),
      false,
      `under TZ ${tz}: a report sent 5 days ago is inside the window and must be deduped`,
    );
  }
});

test("window boundary: 6 days minus a minute → NOT due; 6 days plus a minute → due", async () => {
  if (!canRun) return;
  // The predicate is `last_sent_at < NOW() - INTERVAL '6 days'`. Just inside
  // 6 days (sent 5d23h59m ago) the report is still deduped; just past it
  // (6d1m ago) the window has opened. This pins the comparison direction and
  // the exact 6-day threshold the cadence depends on.
  assert.equal(await evalWeekly("now() - interval '6 days' + interval '1 minute'", "UTC"), false, "just inside 6 days → deduped");
  assert.equal(await evalWeekly("now() - interval '6 days' - interval '1 minute'", "UTC"), true, "just past 6 days → due");
});

test("timezone-independence: the window answer is identical across UTC, +14, and -12", async () => {
  if (!canRun) return;
  // Two fixed instants the daily ::date predicate disagrees on across zones
  // (see scheduled_report_dedup_tz) — the weekly window must NOT, because it
  // never casts to a calendar date. A send 3 days before the reference instant
  // is inside the window in every zone.
  const lastSent = "timestamptz '2026-06-05 05:00:00+00'"; // 3 days before ref
  const sql = `(${lastSent} < timestamptz '2026-06-08 15:00:00+00' - interval '6 days')`;
  const client = await pool!.connect();
  try {
    const seen = new Set<boolean>();
    for (const tz of SESSION_ZONES) {
      await client.query(`SET TIME ZONE '${tz}'`);
      const r = await client.query<{ due: boolean }>(`SELECT ${sql} AS due`);
      seen.add(r.rows[0].due);
    }
    assert.equal(seen.size, 1, "the weekly window must yield the same answer in every session timezone");
    assert.equal([...seen][0], false, "a send 3 days before the reference instant is inside the 6-day window");
  } finally {
    client.release();
  }
});
