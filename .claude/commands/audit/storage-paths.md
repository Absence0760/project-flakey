---
description: Verify every upload path sanitizes filenames before joining into a storage key
---

Audit filename and path handling across every endpoint that accepts a file upload.

## Goal

Reporters control the multipart filename. A reporter (or anything posing as one with valid creds) that sends `originalname: "../../../etc/passwd"` could escape the run-scoped prefix on local disk. Worse, any unsanitized character that survives into the S3 key is permanent — keys can't be renamed, only re-uploaded.

## What to check

1. **Endpoint inventory.** The upload paths the frontend / reporters drive:
   - `POST /runs/upload` — multipart with `screenshots[]`, `videos[]`, `snapshots[]` (`backend/src/routes/uploads.ts`)
   - `POST /live/:runId/snapshot` — single `.json.gz` (`backend/src/routes/live.ts`)
   - `POST /live/:runId/screenshot` — single `.png` (`backend/src/routes/live.ts`)
   - Any avatar / org logo / report attachment route — search `multer` callsites

   For each, identify how the destination key is built and what user input flows into it.

2. **Filename sanitization.** Every endpoint should clean the filename before joining into the storage key. Existing patterns in the codebase:
   - `fixFilename()` in `uploads.ts` decodes Latin-1→UTF-8 (filename header encoding bug, not a security check on its own)
   - The live snapshot path: `replace(/[^a-zA-Z0-9_\-./]/g, "")` on spec, `replace(/[^a-zA-Z0-9_\- ]/g, "").replace(/\s+/g, "-")` on title — strips traversal, slashes get replaced with `__`
   - The live screenshot path: `replace(/[^a-zA-Z0-9_\-. ]/g, "_")` on the original name

   For each upload endpoint: confirm the filename is sanitized before being concatenated into the key. A filename containing `..`, `/`, `\`, null bytes, or control chars must not survive into the storage layer.

3. **Storage key prefix.** Every upload key must be scoped to `runs/{runId}/...` (or another tenant-scoped prefix) so a compromised reporter can't write to another run's directory. Confirm the runId is verified-as-owned (cross-reference `audit/auth` step 4) before being used in the key.

4. **Multer limits.** Each multer instance has `limits.fileSize` and `limits.fieldSize`. Confirm:
   - Screenshots: ≤ 25 MB / file (single screenshot is rarely above 5 MB)
   - Snapshots: ≤ 50 MB / file (compressed DOM bundles can be large)
   - Videos: ≤ 200 MB / file
   - `maxCount` on each field is bounded (the existing `maxCount: 100` for screenshots, `maxCount: 500` for snapshots — without this an upload could spawn 10k temp files)
   - `dest: "uploads/tmp"` is on the same filesystem as `uploads/` so the storage `put()` move is atomic

5. **Temp-file cleanup.** The multipart routes use `multer({ dest: "uploads/tmp" })` and rely on the storage `put()` to move-or-upload-and-delete. Confirm the `finally` block in `uploads.ts` does an `rmSync(p, { force: true })` for every temp path, and that any new endpoint that uses multer follows the same pattern. Orphaned temp files are a slow disk leak.

6. **Content-type vs extension.** The endpoints accept the file regardless of declared `Content-Type`. That's fine for backend storage — no in-browser execution path — but flag if any new endpoint uses the user-supplied `Content-Type` to decide rendering or processing. SVG-as-HTML is the canonical mistake.

7. **Signed URL TTL.** When `getStorage().get()` (or whatever the read path is) returns a signed URL, the TTL should be short (≤ 1 hour for screenshots that the dashboard renders inline; longer for videos that may be linked from emails). Search `backend/src/storage.ts` for the TTL value and confirm it's not multiple days.

8. **Public bucket.** If the storage backend is S3, confirm the bucket has Public Access Block flags set. (This overlaps with `audit/infra` — coordinate, don't duplicate.)

## Report

- **Critical** — a filename traverses out of `runs/{id}/...` and writes anywhere on the filesystem / bucket; an upload writes to a key the caller doesn't own.
- **High** — missing sanitization on a new upload endpoint; signed URL TTL > 24 h on a sensitive artifact; missing `runId` ownership check before key construction.
- **Medium** — `maxCount` unbounded on a multer field; missing fileSize limit; temp file cleanup missing on a code path.
- **Low** — sanitization regex slightly different across endpoints (the live screenshot vs snapshot regex differ in edge cases — consolidating reduces drift, not currently a bug).

For each: file:line, the input that escapes, the resulting key.

## Useful starting points

- `backend/src/routes/uploads.ts` — `fixFilename`, `normalizeForMatch`, `screenshotMap` build, `runs/{runId}/screenshots/${name}`
- `backend/src/routes/live.ts` — `safeTitle` / `safeSpec` sanitization for `/snapshot`, `safeName` for `/screenshot`
- `backend/src/storage.ts` — local-disk vs S3 implementations
- `backend/src/tests/phase_9_10.smoke.test.ts` — the snapshot endpoint already has a "filename sanitization" sub-test; confirm the screenshot endpoint has the same

## Delegate to

Use the `flakey-auditor` agent: `"Audit filename sanitization and key scoping on every upload endpoint."` Read-only.
