import { Router } from "express";
import multer from "multer";
import { join } from "path";
import { tenantTransaction } from "../db.js";
import { normalize } from "../normalizers/index.js";
import { logAudit } from "../audit.js";
import { dispatchRunFailed } from "../webhooks.js";
import { postPRComment } from "../git-providers/index.js";
import { autoCreateIssuesForRun } from "../integrations/jira.js";
import { maybeTriggerPagerDutyForRun } from "../integrations/pagerduty.js";
import { getStorage } from "../storage.js";
import { findOrCreateRun, recalculateRunStats } from "../run-merge.js";
import type { NormalizedRun } from "../types.js";

const router = Router();
const upload = multer({ dest: "uploads/tmp", limits: { fileSize: 200 * 1024 * 1024, fieldSize: 50 * 1024 * 1024 } });

const uploadFields = upload.fields([
  { name: "screenshots", maxCount: 100 },
  { name: "videos", maxCount: 100 },
  { name: "snapshots", maxCount: 500 },
]);

// POST /runs/upload — multipart upload with screenshots and videos
router.post("/", uploadFields, async (req, res) => {
  try {
    const payloadStr = req.body.payload;
    if (!payloadStr) {
      res.status(400).json({ error: "Missing 'payload' field" });
      return;
    }

    const body = JSON.parse(payloadStr);
    let run: NormalizedRun;

    if (body.raw && body.meta?.reporter) {
      run = normalize(body.meta.reporter, body.raw, body.meta);
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

    const storage = getStorage();

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
          `INSERT INTO specs (run_id, file_path, title, total, passed, failed, skipped, duration_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (run_id, file_path) DO UPDATE SET
             title       = EXCLUDED.title,
             total       = EXCLUDED.total,
             passed      = EXCLUDED.passed,
             failed      = EXCLUDED.failed,
             skipped     = EXCLUDED.skipped,
             duration_ms = EXCLUDED.duration_ms
           RETURNING id`,
          [runId, spec.file_path, spec.title, spec.stats.total, spec.stats.passed, spec.stats.failed, spec.stats.skipped, spec.stats.duration_ms]
        );
        const specId = specResult.rows[0].id;

        // Replace any live-path test rows for this spec — the upload carries
        // the authoritative per-test list, so prior pending/partial rows
        // would otherwise accumulate as duplicates. Snapshot the live-path's
        // snapshot_path linkages (written by /live/:runId/snapshot mid-run)
        // so we can re-apply them to the fresh rows by matching full_title.
        const preserved = await client.query(
          `SELECT full_title, snapshot_path FROM tests WHERE spec_id = $1 AND snapshot_path IS NOT NULL`,
          [specId]
        );
        const snapshotByTitle = new Map<string, string>();
        for (const row of preserved.rows) snapshotByTitle.set(row.full_title, row.snapshot_path);

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

          await client.query(
            `INSERT INTO tests (spec_id, title, full_title, status, duration_ms, error_message, error_stack, screenshot_paths, video_path, test_code, command_log, metadata, snapshot_path)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [specId, test.title, test.full_title, test.status, test.duration_ms,
             test.error?.message ?? null, test.error?.stack ?? null,
             matchedScreenshots.length > 0 ? matchedScreenshots : test.screenshot_paths,
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
  } catch (err) {
    console.error("POST /runs/upload error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

function fixFilename(name: string): string {
  // Multer decodes the multipart filename header as Latin-1, but browsers
  // send UTF-8.  Re-interpret the Latin-1 bytes as UTF-8 to recover the
  // original characters (e.g. checkmarks, accented letters).
  try {
    const buf = Buffer.from(name, "latin1");
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return decoded;
  } catch {
    return name;
  }
}

function normalizeForMatch(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export default router;
