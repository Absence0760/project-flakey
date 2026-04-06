import { Router } from "express";
import multer from "multer";
import { mkdirSync, renameSync } from "fs";
import { join, basename } from "path";
import { tenantTransaction } from "../db.js";
import { normalize } from "../normalizers/index.js";
import type { NormalizedRun } from "../types.js";

const router = Router();
const upload = multer({ dest: "uploads/tmp", limits: { fileSize: 200 * 1024 * 1024 } });

const uploadFields = upload.fields([
  { name: "screenshots", maxCount: 100 },
  { name: "videos", maxCount: 10 },
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

    // Move uploaded files before the transaction
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const screenshotFiles = files?.screenshots ?? [];
    const videoFiles = files?.videos ?? [];

    await tenantTransaction(orgId, async (client) => {
      const runResult = await client.query(
        `INSERT INTO runs (suite_name, branch, commit_sha, ci_run_id, reporter, started_at, finished_at, total, passed, failed, skipped, pending, duration_ms, org_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id`,
        [
          run.meta.suite_name, run.meta.branch, run.meta.commit_sha, run.meta.ci_run_id,
          run.meta.reporter, run.meta.started_at, run.meta.finished_at,
          run.stats.total, run.stats.passed, run.stats.failed, run.stats.skipped, run.stats.pending, run.stats.duration_ms,
          orgId,
        ]
      );
      runId = runResult.rows[0].id;

      const screenshotDir = join("uploads", "runs", String(runId), "screenshots");
      const videoDir = join("uploads", "runs", String(runId), "videos");
      mkdirSync(screenshotDir, { recursive: true });
      mkdirSync(videoDir, { recursive: true });

      const screenshotMap = new Map<string, string>();
      for (const file of screenshotFiles) {
        const dest = join(screenshotDir, file.originalname);
        renameSync(file.path, dest);
        screenshotMap.set(file.originalname, `runs/${runId}/screenshots/${file.originalname}`);
      }

      let videoPath: string | null = null;
      for (const file of videoFiles) {
        const dest = join(videoDir, file.originalname);
        renameSync(file.path, dest);
        videoPath = `runs/${runId}/videos/${file.originalname}`;
      }

      for (const spec of run.specs) {
        const specResult = await client.query(
          `INSERT INTO specs (run_id, file_path, title, total, passed, failed, skipped, duration_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [runId, spec.file_path, spec.title, spec.stats.total, spec.stats.passed, spec.stats.failed, spec.stats.skipped, spec.stats.duration_ms]
        );
        const specId = specResult.rows[0].id;

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

          await client.query(
            `INSERT INTO tests (spec_id, title, full_title, status, duration_ms, error_message, error_stack, screenshot_paths, video_path, test_code, command_log, metadata)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [specId, test.title, test.full_title, test.status, test.duration_ms,
             test.error?.message ?? null, test.error?.stack ?? null,
             matchedScreenshots.length > 0 ? matchedScreenshots : test.screenshot_paths,
             videoPath ?? test.video_path ?? null,
             test.test_code ?? null,
             test.command_log ? JSON.stringify(test.command_log) : null,
             test.metadata ? JSON.stringify(test.metadata) : null]
          );
        }
      }
    });

    res.status(201).json({ id: runId! });
  } catch (err) {
    console.error("POST /runs/upload error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

function normalizeForMatch(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export default router;
