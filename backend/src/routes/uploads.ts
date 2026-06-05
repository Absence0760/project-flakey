import { Router } from "express";
import multer from "multer";
import { basename } from "path";
import { tenantTransaction } from "../db.js";
import { normalize } from "../normalizers/index.js";
import { logAudit } from "../audit.js";
import { dispatchRunFailed } from "../webhooks.js";
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

const uploadFields = wrapMulter(upload.fields([
  { name: "screenshots", maxCount: 100 },
  { name: "videos", maxCount: 100 },
  { name: "snapshots", maxCount: 500 },
]));

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
      // normalize() throws "Unsupported reporter: X. Supported: ..."
      // when the reporter name isn't in the parsers map — that's
      // caller error (a misconfigured CLI invocation), not a
      // server failure, so convert it to a 400 instead of letting
      // it surface as a generic 500.
      try {
        run = normalize(body.meta.reporter, body.raw, body.meta);
      } catch (err) {
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

      let videoPath: string | null = null;
      for (const file of videoFiles) {
        const name = fixFilename(file.originalname);
        const relPath = `runs/${runId}/videos/${name}`;
        await storage.put(file.path, relPath);
        videoPath = relPath;
      }

      for (const spec of run.specs) {
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

        // Replace any live-path test rows for this spec — the upload carries
        // the authoritative per-test list, so prior pending/partial rows
        // would otherwise accumulate as duplicates. Snapshot the live-path's
        // snapshot_path linkages (written by /live/:runId/snapshot mid-run)
        // and screenshot_paths (written by /live/:runId/screenshot mid-run)
        // so we can re-apply them to the fresh rows by matching full_title.
        const preserved = await client.query(
          `SELECT full_title, snapshot_path, screenshot_paths
           FROM tests
           WHERE spec_id = $1
             AND (snapshot_path IS NOT NULL
                  OR (screenshot_paths IS NOT NULL AND array_length(screenshot_paths, 1) > 0))`,
          [specId]
        );
        const snapshotByTitle = new Map<string, string>();
        const screenshotsByTitle = new Map<string, string[]>();
        for (const row of preserved.rows) {
          if (row.snapshot_path) snapshotByTitle.set(row.full_title, row.snapshot_path);
          if (row.screenshot_paths?.length) screenshotsByTitle.set(row.full_title, row.screenshot_paths);
        }

        await client.query(`DELETE FROM tests WHERE spec_id = $1`, [specId]);

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
          // per-test live uploads aren't clobbered by the end-of-run rewrite.
          const streamed = screenshotsByTitle.get(test.full_title) ?? [];
          const finalScreenshots = Array.from(new Set([
            ...streamed,
            ...(matchedScreenshots.length > 0 ? matchedScreenshots : test.screenshot_paths),
          ]));

          await client.query(
            `INSERT INTO tests (spec_id, title, full_title, status, duration_ms, error_message, error_stack, screenshot_paths, video_path, test_code, command_log, metadata, snapshot_path)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [specId, test.title, test.full_title, test.status, test.duration_ms,
             test.error?.message ?? null, test.error?.stack ?? null,
             finalScreenshots,
             videoPath ?? test.video_path ?? null,
             test.test_code ?? null,
             test.command_log ? JSON.stringify(test.command_log) : null,
             test.metadata ? JSON.stringify(test.metadata) : null,
             snapshotPath]
          );
        }
      }

      if (merged) {
        await recalculateRunStats(client, runId);
      }
    });

    logAudit(req.user!.orgId, req.user!.id, "run.upload", "run", String(runId!), { suite: run.meta.suite_name, total: run.stats.total, failed: run.stats.failed, merged });

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
