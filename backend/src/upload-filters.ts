import type { Request, RequestHandler, Response, NextFunction } from "express";
import { rmSync } from "fs";
import path from "path";
import multer, { type Options } from "multer";

// Multer fileFilter that rejects attachment types that browsers will
// happily execute when served back inline. SVG + SVGZ run <script>
// inside the document; HTML / XHTML obviously do. storage.ts's
// guessContentType maps SVG/SVGZ to application/octet-stream so S3
// serves them as a download, but the boundary rejection is cleaner —
// nothing inside an org's bucket should be a stored-XSS payload to
// begin with.
//
// Extension AND mimetype are checked because a reporter can lie about
// either. A reporter sending {originalname: "ok.png", mimetype:
// "image/svg+xml"} is just as dangerous as one sending the other way
// round.
const FORBIDDEN_EXTS = [".svg", ".svgz", ".html", ".htm", ".xhtml"];
const FORBIDDEN_MIMES = new Set([
  "image/svg+xml",
  "image/svg",
  "text/html",
  "application/xhtml+xml",
]);

export const rejectExecutableAttachments: Options["fileFilter"] = (_req, file, cb) => {
  const name = (file.originalname ?? "").toLowerCase();
  const mime = (file.mimetype ?? "").toLowerCase();
  if (FORBIDDEN_EXTS.some((ext) => name.endsWith(ext)) || FORBIDDEN_MIMES.has(mime)) {
    cb(new Error("Executable attachment types (SVG / HTML) are not allowed"));
    return;
  }
  cb(null, true);
};

// Multer's temp-file root. Every route that takes a multipart upload
// is configured with `dest: "uploads/tmp"`, and multer writes the
// payload to a random-named file under that directory. Resolving it
// once at module load gives us a stable absolute prefix to compare
// against when reaping the temp file in a finally block.
const UPLOAD_TMP_ROOT = path.resolve("uploads/tmp") + path.sep;

// Reap a multer temp file with a defence-in-depth bounds check.
// Multer's `file.path` is set internally to a crypto-random filename
// under `uploads/tmp/`, so in practice it can never escape that
// directory — but it derives from `req.file`, which CodeQL marks as
// user-tainted. A path-traversal escape would only be possible if a
// future change swapped multer for a custom storage engine that
// honoured a client-controlled filename. Bounds-checking here makes
// the guarantee a runtime invariant rather than a "trust multer"
// argument, and silences the js/path-injection alert.
export function safeUnlinkTmp(p: string): void {
  const resolved = path.resolve(p);
  if (!resolved.startsWith(UPLOAD_TMP_ROOT)) return;
  rmSync(resolved, { force: true });
}

// Wrap a multer middleware so fileFilter rejections and other multer
// errors surface as a clean 400 rather than the default 500 from
// Express's fallback error handler. Without this wrap, a malicious
// reporter that posts an `.svg` gets a confusing 500 + stack-trace
// log entry on every attempt; with it, they get a 400 + a one-line
// reason and the audit log stays clean.
export function wrapMulter(mw: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    mw(req, res, (err: unknown) => {
      if (!err) return next();
      const isMulter = err instanceof multer.MulterError;
      const message = err instanceof Error ? err.message : "Upload rejected";
      const status = isMulter && err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      res.status(status).json({ error: message });
    });
  };
}
