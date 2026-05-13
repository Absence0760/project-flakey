import type { Request, RequestHandler, Response, NextFunction } from "express";
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
