import { Router } from "express";
import multer from "multer";
import { basename } from "path";
import { tenantTransaction } from "../db.js";
import { normalize } from "../normalizers/index.js";
import { logAudit } from "../audit.js";
import { dispatchRunFailed } from "../webhooks.js";
import { recordErrorRecurrence, dispatchRegressionWebhooks } from "../error-recurrence.js";
import { postPRComment } from "../git-providers/index.js";
import { autoCreateIssuesForRun } from "../integrations/jira.js";
import { maybeTriggerPagerDutyForRun } from "../integrations/pagerduty.js";
import { getStorage } from "../storage.js";
import { findOrCreateRun, recalculateRunStats } from "../run-merge.js";
import { rejectExecutableAttachments, safeUnlinkTmp, wrapMulter } from "../upload-filters.js";
import type { NormalizedRun } from "../types.js";
import { safeLog } from "../log.js";

const router = Router();
// Per-field size caps. Multer's `limits.fileSize` is global, so we hold
// the global at the highest sane value (videos, 200 MB) and enforce
// per-field caps in the route handler after multer has streamed each
// file to disk. The handler unlinks any oversize temp file and returns
// 413 — this is the actual gate that stops a reporter from posting a
// 20 GB request via 100×200 MB screenshots.
//
// fieldSize bounds non-file form fields (the JSON `payload` blob) at
// 5 MB — generous for any real reporter payload.
//
// fileFilter rejects SVG/HTML at the boundary — without it a reporter
// could upload `xss.html` and (in local-disk mode) `express.static`
// would serve it back with Content-Type: text/html. The S3 path is
// already covered by guessContentType's octet-stream fallback, but the
// boundary check makes both modes consistent.
const upload = multer({
  dest: "uploads/tmp",
  limits: { fileSize: 200 * 1024 * 1024, fieldSize: 5 * 1024 * 1024 },
  fileFilter: rejectExecutableAttachments,
});

const SCREENSHOT_MAX_BYTES = 25 * 1024 * 1024;
const SNAPSHOT_MAX_BYTES = 50 * 1024 * 1024;
const VIDEO_MAX_BYTES = 200 * 1024 * 1024;

// Single-sourced so the multer config and the caps handed to wrapMulter
// (for its over-limit error message) can't drift apart.
const UPLOAD_FILE_FIELDS = [
  { name: "screenshots", maxCount: 100 },
  { name: "videos", maxCount: 100 },
  { name: "snapshots", maxCount: 500 },
];
const uploadFields = wrapMulter(
  upload.fields(UPLOAD_FILE_FIELDS),
  Object.fromEntries(UPLOAD_FILE_FIELDS.map((f) => [f.name, f.maxCount])),
);

// POST /runs/upload — multipart upload with screenshots and videos
router.post("/", uploadFields, async (req, res) => {
  try {
    const payloadStr = req.body.payload;
    if (!payloadStr) {
      res.status(400).json({ error: "Missing 'payload' field" });
      return;
    }

    let body: any;
    try {
      body = JSON.parse(payloadStr);
    } catch {
      res.status(400).json({ error: "Invalid JSON in payload field" });
      return;
    }
    let run: NormalizedRun;

    if (body.raw && body.meta?.reporter) {
      // normalize() throws "Unsupported reporter. Supported: ..." when
      // the reporter name isn't in the parsers map — that's caller error
      // (a misconfigured CLI invocation), not a server failure, so convert
      // it to a 400 instead of letting it surface as a generic 500. The
      // thrown message is deliberately fixed (no caller-supplied reporter
      // name reflected — see normalizers/index.ts); the offending value is
      // logged server-side for debugging instead.
      try {
        run = normalize(body.meta.reporter, body.raw, body.meta);
      } catch (err) {
        console.error("POST /runs/upload reporter rejected:", safeLog(body.meta.reporter), safeLog(err));
        const message = err instanceof Error ? err.message : "Invalid reporter payload";
        res.status(400).json({ error: message });
        return;
      }
    } else if (body.meta && body.stats && body.specs) {
      run = { meta: body.meta, stats: body.stats, specs: body.specs };
    } else {
      res.status(400).json({ error: "Provide either {raw, meta} or {meta, stats, specs} in payload" });
      return;
    }

    const orgId = req.user!.orgId;
    let runId: number;
    let merged = false;
    // Phase 15.2 (a): fingerprints that flipped fixed → regressed on this
    // ingest (captured in-tx, dispatched as error.regressed after commit).
    let regressedFingerprints: string[] = [];

    // Move uploaded files before the transaction
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const screenshotFiles = files?.screenshots ?? [];
    const videoFiles = files?.videos ?? [];
    const snapshotFiles = files?.snapshots ?? [];

    // Per-field size enforcement. Multer's global fileSize is set to
    // the video cap; fields that should be smaller (screenshots,
    // snapshots) get rejected here before any storage put or DB write.
    const oversize = (
      [
        ...screenshotFiles.map((f) => ({ field: "screenshots", file: f, max: SCREENSHOT_MAX_BYTES })),
        ...snapshotFiles.map((f) => ({ field: "snapshots", file: f, max: SNAPSHOT_MAX_BYTES })),
        ...videoFiles.map((f) => ({ field: "videos", file: f, max: VIDEO_MAX_BYTES })),
      ] as const
    ).find((entry) => entry.file.size > entry.max);
    if (oversize) {
      // Reap every multer temp file before bailing.
      for (const f of [...screenshotFiles, ...videoFiles, ...snapshotFiles]) {
        safeUnlinkTmp(f.path);
      }
      res.status(413).json({
        error: `${oversize.field} file '${oversize.file.originalname}' is ${oversize.file.size} bytes; max ${oversize.max} bytes`,
      });
      return;
    }

    const storage = getStorage();

    // Collect all multer temp paths up-front so the finally block can clean
    // them up regardless of whether the transaction succeeds or fails.
    // storage.put() either moves (local) or uploads-then-deletes (S3) each
    // file, so rmSync with force:true is a safe no-op for already-moved files.
    const allTmpPaths = [
      ...screenshotFiles.map((f) => f.path),
      ...videoFiles.map((f) => f.path),
      ...snapshotFiles.map((f) => f.path),
    ];

    try {
    // `client` inside this block is already org-scoped — tenantTransaction
    // sets app.current_org_id at transaction start, so every client.query
    // below runs with RLS active. Treat client.query identically to
    // tenantQuery for review purposes.
    await tenantTransaction(orgId, async (client) => {
      const result = await findOrCreateRun(client, orgId, run);
      runId = result.runId;
      merged = result.merged;

      // Move snapshot files and build a lookup by test title
      const snapshotMap = new Map<string, string>(); // normalized test title → relative path
      for (const file of snapshotFiles) {
        const name = fixFilename(file.originalname);
        const relPath = `runs/${runId}/snapshots/${name}`;
        await storage.put(file.path, relPath);
        // Filename format: specFile--testTitle.json.gz (split on first --)
        const nameNoExt = name.replace(/\.json\.gz$/, "");
        const firstSep = nameNoExt.indexOf("--");
        const titlePart = firstSep >= 0 ? nameNoExt.slice(firstSep + 2) : nameNoExt;
        snapshotMap.set(normalizeForMatch(titlePart), relPath);
      }

      const screenshotMap = new Map<string, string>();
      for (const file of screenshotFiles) {
        const name = fixFilename(file.originalname);
        const relPath = `runs/${runId}/screenshots/${name}`;
        await storage.put(file.path, relPath);
        screenshotMap.set(name, relPath);
      }

      // Move each uploaded video and remember it by filename. Do NOT collapse
      // to a single "last video wins" path: a multi-spec upload (or a sharded
      // run) carries one video per spec, and assigning the last one to every
      // test strands the others and mislabels every test's video. Cypress
      // names each video after its spec file (login.cy.ts.mp4), so we match a
      // spec to its video by filename below.
      const videoFilesList: { name: string; relPath: string }[] = [];
      for (const file of videoFiles) {
        const name = fixFilename(file.originalname);
        const relPath = `runs/${runId}/videos/${name}`;
        await storage.put(file.path, relPath);
        videoFilesList.push({ name, relPath });
      }
      // Resolve the video belonging to a spec by matching the uploaded video
      // name against the spec's file basename. Falls back to the sole uploaded
      // video when there's exactly one (the common single-spec Cypress run),
      // and to null when nothing matches in a multi-video upload.
      const videoForSpec = (filePath: string): string | null => {
        const specBase = basename(filePath).toLowerCase();
        const match = videoFilesList.find((v) => {
          const vbase = v.name.toLowerCase().replace(/\.(mp4|webm)$/, "");
          return vbase === specBase || vbase.includes(specBase) || specBase.includes(vbase);
        });
        if (match) return match.relPath;
        return videoFilesList.length === 1 ? videoFilesList[0].relPath : null;
      };

      for (const spec of run.specs) {
        const specVideo = videoForSpec(spec.file_path);
        // Upsert against uniq_specs_run_file (migration 030). The live path
        // may have already created this spec row during spec.started; this
        // upload is the authoritative stats snapshot, so overwrite.
        const specResult = await client.query(
          `INSERT INTO specs (run_id, file_path, title, total, passed, failed, skipped, pending, duration_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (run_id, file_path) DO UPDATE SET
             title       = EXCLUDED.title,
             total       = EXCLUDED.total,
             passed      = EXCLUDED.passed,
             failed      = EXCLUDED.failed,
             skipped     = EXCLUDED.skipped,
             pending     = EXCLUDED.pending,
             duration_ms = EXCLUDED.duration_ms
           RETURNING id`,
          // pending ?? 0: the direct {meta,stats,specs} payload path accepts
          // pre-normalized JSON from reporters that predate spec-level pending.
          [runId, spec.file_path, spec.title, spec.stats.total, spec.stats.passed, spec.stats.failed, spec.stats.skipped, spec.stats.pending ?? 0, spec.stats.duration_ms]
        );
        const specId = specResult.rows[0].id;

        // Reconcile this spec's test rows IN PLACE instead of dropping and
        // recreating them. The live path (spec.started / test.started /
        // test.passed|failed) already created rows for this spec while the run
        // was streaming; this upload is the authoritative snapshot. We match
        // each uploaded test to an existing row by full_title and UPDATE it in
        // place — preserving tests.id across the live→final handoff.
        //
        // A DELETE+INSERT here reassigns every id, which:
        //   (a) 404s the run-detail test modal (GET /tests/:id → "Test not
        //       found") for anyone who opened a scenario in the window between
        //       the merge and their next poll/refetch — the row they clicked
        //       still carries the pre-merge id; and
        //   (b) silently nulls visual_diffs.test_id (ON DELETE SET NULL) on
        //       every merge.
        //
        // full_title is not unique within a spec (data-driven tests repeat
        // it), so ids are reused FIFO per title: the Nth uploaded test with a
        // given title claims the Nth surviving live row with that title.
        // Uploaded tests with no surviving match are INSERTed; live rows left
        // unclaimed (e.g. a pending row for a test the final report dropped)
        // are deleted after the loop. We also snapshot the live-path's
        // snapshot_path / screenshot_paths (written mid-run by
        // /live/:runId/snapshot|screenshot) so they fold back into the
        // authoritative row by matching full_title.
        const existing = await client.query(
          `SELECT id, full_title, snapshot_path, screenshot_paths
           FROM tests WHERE spec_id = $1 ORDER BY id`,
          [specId]
        );
        const idsByTitle = new Map<string, number[]>();
        const snapshotByTitle = new Map<string, string>();
        const screenshotsByTitle = new Map<string, string[]>();
        for (const row of existing.rows) {
          const q = idsByTitle.get(row.full_title);
          if (q) q.push(row.id); else idsByTitle.set(row.full_title, [row.id]);
          if (row.snapshot_path) snapshotByTitle.set(row.full_title, row.snapshot_path);
          if (row.screenshot_paths?.length) screenshotsByTitle.set(row.full_title, row.screenshot_paths);
        }
        const reusedIds = new Set<number>();

        for (const test of spec.tests) {
          const matchedScreenshots: string[] = [];
          const testNorm = normalizeForMatch(test.title);
          const fullNorm = normalizeForMatch(test.full_title);

          for (const [filename, relPath] of screenshotMap) {
            const fileNorm = normalizeForMatch(filename);
            // Prefer full_title match (more specific, includes suite path).
            // Fall back to title match only if full_title doesn't match,
            // and only if the title is long enough to avoid false positives
            // (e.g. "Login" matching "Login with SSO").
            if (fileNorm.includes(fullNorm) && fullNorm.length > 0) {
              matchedScreenshots.push(relPath);
            } else if (testNorm.length >= 15 && fileNorm.includes(testNorm)) {
              matchedScreenshots.push(relPath);
            }
          }

          // For Playwright: match by original attachment filename from the report.
          // test.screenshot_paths contains local paths like "/Users/.../test-results/img.png"
          // Check if any uploaded file has the same basename.
          if (matchedScreenshots.length === 0 && test.screenshot_paths.length > 0) {
            for (const origPath of test.screenshot_paths) {
              const origBasename = origPath.split("/").pop() ?? "";
              const mapped = screenshotMap.get(origBasename);
              if (mapped) matchedScreenshots.push(mapped);
            }
          }

          // Match snapshot file to test: prefer end-of-run batch upload match,
          // fall back to the live-streamed link preserved above.
          let snapshotPath: string | null = null;
          for (const [snapshotNorm, snapshotRelPath] of snapshotMap) {
            if (snapshotNorm.includes(testNorm) && testNorm.length > 5) {
              snapshotPath = snapshotRelPath;
              break;
            }
          }
          if (!snapshotPath) snapshotPath = snapshotByTitle.get(test.full_title) ?? null;

          // Merge any screenshots that were streamed mid-run via
          // /live/:runId/screenshot with whatever the batch upload found, so
          // per-test live uploads aren't clobbered by the end-of-run merge.
          const streamed = screenshotsByTitle.get(test.full_title) ?? [];
          const finalScreenshots = Array.from(new Set([
            ...streamed,
            ...(matchedScreenshots.length > 0 ? matchedScreenshots : test.screenshot_paths),
          ]));

          // Reuse a surviving live row's id (UPDATE in place) when this
          // full_title still has one unclaimed; otherwise INSERT a fresh row.
          const titleQueue = idsByTitle.get(test.full_title);
          const reuseId = titleQueue && titleQueue.length ? titleQueue.shift()! : null;

          if (reuseId !== null) {
            reusedIds.add(reuseId);
            await client.query(
              `UPDATE tests SET
                 title = $2, full_title = $3, status = $4, duration_ms = $5,
                 error_message = $6, error_stack = $7, screenshot_paths = $8,
                 video_path = $9, test_code = $10, command_log = $11,
                 metadata = $12, snapshot_path = $13
               WHERE id = $1`,
              [reuseId, test.title, test.full_title, test.status, test.duration_ms,
               test.error?.message ?? null, test.error?.stack ?? null,
               finalScreenshots,
               specVideo ?? test.video_path ?? null,
               test.test_code ?? null,
               test.command_log ? JSON.stringify(test.command_log) : null,
               test.metadata ? JSON.stringify(test.metadata) : null,
               snapshotPath]
            );
          } else {
            await client.query(
              `INSERT INTO tests (spec_id, title, full_title, status, duration_ms, error_message, error_stack, screenshot_paths, video_path, test_code, command_log, metadata, snapshot_path)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
              [specId, test.title, test.full_title, test.status, test.duration_ms,
               test.error?.message ?? null, test.error?.stack ?? null,
               finalScreenshots,
               specVideo ?? test.video_path ?? null,
               test.test_code ?? null,
               test.command_log ? JSON.stringify(test.command_log) : null,
               test.metadata ? JSON.stringify(test.metadata) : null,
               snapshotPath]
            );
          }
        }

        // Delete live rows the upload didn't claim — e.g. a 'pending' row for
        // a test the final report no longer contains. Leaving them would
        // strand orphan rows that inflate the spec's counts.
        const staleIds = existing.rows
          .map((r) => r.id as number)
          .filter((id) => !reusedIds.has(id));
        if (staleIds.length > 0) {
          await client.query(`DELETE FROM tests WHERE id = ANY($1)`, [staleIds]);
        }
      }

      if (merged) {
        await recalculateRunStats(client, runId);
      }

      // Phase 15.2 (a) — recurrence → auto-reopen. Same single ingest-time
      // path as POST /runs (src/error-recurrence.ts): flip any `fixed` group
      // whose fingerprint reappeared to `regressed`, in this org-scoped tx.
      regressedFingerprints = await recordErrorRecurrence(client, orgId, run);
    });

    // Awaited (not fire-and-forget): logAudit now appends into the per-org hash
    // chain under a transaction-scoped advisory lock, so an unawaited call would
    // pile up pool connections + serialized lock waits under concurrent same-org
    // uploads. It swallows internally — the await only costs the round-trip.
    await logAudit(req.user!.orgId, req.user!.id, "run.upload", "run", String(runId!), { suite: run.meta.suite_name, total: run.stats.total, failed: run.stats.failed, merged });

    // Phase 15.2 (a) — error.regressed for groups that reopened on this ingest.
    if (regressedFingerprints.length > 0) {
      dispatchRegressionWebhooks(req.user!.orgId, run, regressedFingerprints);
    }

    dispatchRunFailed(req.user!.orgId, runId!, run);
    postPRComment(req.user!.orgId, runId!, run);
    autoCreateIssuesForRun(req.user!.orgId, runId!, run);
    maybeTriggerPagerDutyForRun(req.user!.orgId, runId!, run);

    res.status(merged ? 200 : 201).json({ id: runId!, merged });
    } finally {
      for (const p of allTmpPaths) {
        try { safeUnlinkTmp(p); } catch { /* ignore */ }
      }
    }
  } catch (err) {
    console.error("POST /runs/upload error:", safeLog(err));
    res.status(500).json({ error: "Internal server error" });
  }
});

export function fixFilename(name: string): string {
  // Two passes:
  //   1. Multer decodes the multipart filename header as Latin-1, but
  //      browsers send UTF-8.  Re-interpret the Latin-1 bytes as UTF-8
  //      to recover the original characters (e.g. checkmarks, accents).
  //   2. Strip any directory components and \0 / \\ path-traversal
  //      tricks before the name is joined into a storage key. The
  //      LocalStorage put() has a defense-in-depth `relative()` guard
  //      too, but CodeQL js/path-injection only trusts a sanitization
  //      step that's visible at the boundary — and either way, we don't
  //      want an upload named "../../etc/passwd" reaching the storage
  //      layer at all.
  let decoded: string;
  try {
    const buf = Buffer.from(name, "latin1");
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    decoded = name;
  }
  // posix basename + win32 backslash strip + null-byte strip.
  // Final 200-char cap stops a multi-MB filename payload from blowing
  // up downstream key/length budgets in S3 metadata or DB columns.
  const cleaned = basename(decoded.replace(/\\/g, "/")).replace(/\0/g, "");
  return cleaned.slice(0, 200);
}

export function normalizeForMatch(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export default router;
