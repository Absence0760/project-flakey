import { mkdirSync, renameSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve, sep } from "path";
import { S3Client, PutObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Reject the four path-traversal primitives at the storage boundary:
// `..` segments, backslashes, null bytes, and a leading `/`. We don't
// enforce a character allow-list because legitimate filenames include
// spaces, accented Unicode, etc.; the deny-list is sufficient because
// node's path resolver only escapes a directory via these patterns.
//
// NOTE: this is defense-in-depth on top of the inline resolve+prefix
// sanitisation in each put() method. CodeQL's js/path-injection rule
// only traces sanitisation when the resolve+startsWith pattern sits
// inline at the filesystem call site — values flowing through a
// helper function boundary aren't recognised as sanitised by the
// data-flow library. Hence the inline duplication below.
function assertSafeKey(destKey: string): void {
  if (
    destKey.length === 0 ||
    destKey === "." ||
    destKey.startsWith("/") ||
    destKey.includes("\\") ||
    destKey.includes("\0") ||
    destKey.split("/").some((seg) => seg === "..")
  ) {
    throw new Error(`unsafe storage key: ${destKey}`);
  }
}

// Pre-resolved tmp roots that multer files are allowed to live under.
// One for the multer disk-storage dest the upload routes configure
// (`uploads/tmp/<random>`), one for the OS tmpdir the unit tests use.
// Kept as separate constants (not an array iterated by a loop) so the
// startsWith checks below are inline conditionals that CodeQL's
// js/path-injection data-flow library can trace through end-to-end.
const TEMP_ROOT_UPLOADS = resolve("uploads", "tmp") + sep;
const TEMP_ROOT_OS = resolve(tmpdir()) + sep;

export interface Storage {
  /** Move a file from a local temp path to its final storage location. */
  put(tempPath: string, destKey: string): Promise<void>;

  /** Get a URL to serve the artifact. For local: relative path. For S3: presigned URL or CDN URL. */
  getUrl(key: string): Promise<string>;

  /** Delete all artifacts for a run. */
  deleteRun(runId: number): Promise<void>;
}

// --- Local disk storage ---

class LocalStorage implements Storage {
  private baseDir: string;

  constructor(baseDir = "uploads") {
    this.baseDir = baseDir;
  }

  async put(tempPath: string, destKey: string): Promise<void> {
    assertSafeKey(destKey);

    // INLINE sanitisation — CodeQL's js/path-injection rule recognises
    // `x.startsWith(safePrefix) === true` as a barrier guard for `x`.
    // For it to mark the downstream `fs` sink as sanitised, the sink
    // call must be dominated by the `startsWith` truthy branch — i.e.
    // the sink lives INSIDE `if (x.startsWith(safe)) { ... }`, not
    // after an `if (!x.startsWith(safe)) throw`. Compound boolean
    // guards and helper-function indirection both break that match.
    // The seemingly redundant duplication below is the price of
    // satisfying that data-flow shape.

    // Sanitise destKey: resolve under baseDir, refuse anything outside.
    // assertSafeKey rejects empty / "." / leading "/" / "\" / "\0" /
    // ".." segments, so destAbs can never equal baseAbs and a single
    // startsWith check suffices.
    const baseAbs = resolve(this.baseDir);
    const destAbs = resolve(baseAbs, destKey);
    if (!destAbs.startsWith(baseAbs + sep)) {
      throw new Error(`refusing to write outside storage root: ${destKey}`);
    }

    // Sanitise tempPath: resolve, then dispatch to the sink only
    // INSIDE a branch that proved the resolved path is under one of
    // the two whitelisted tmp roots (multer dest or os.tmpdir()).
    if (tempPath.includes("\0")) {
      throw new Error(`unsafe temp path (null byte): ${tempPath}`);
    }
    const tempAbs = resolve(tempPath);

    if (tempAbs.startsWith(TEMP_ROOT_UPLOADS)) {
      mkdirSync(dirname(destAbs), { recursive: true });
      renameSync(tempAbs, destAbs);
      return;
    }
    if (tempAbs.startsWith(TEMP_ROOT_OS)) {
      mkdirSync(dirname(destAbs), { recursive: true });
      renameSync(tempAbs, destAbs);
      return;
    }
    throw new Error(`refusing to read from outside known temp roots: ${tempPath}`);
  }

  async getUrl(key: string): Promise<string> {
    // Static middleware serves from /uploads/
    return `/uploads/${key}`;
  }

  async deleteRun(runId: number): Promise<void> {
    const dir = join(this.baseDir, "runs", String(runId));
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// --- S3 storage ---

class S3Storage implements Storage {
  private client: S3Client;
  private bucket: string;
  private prefix: string;
  private cdnUrl: string | null;

  constructor() {
    this.client = new S3Client({
      region: process.env.S3_REGION ?? "us-east-1",
    });
    this.bucket = process.env.S3_BUCKET ?? "";
    this.prefix = process.env.S3_PREFIX ?? "";
    this.cdnUrl = process.env.CDN_URL ?? null;

    if (!this.bucket) {
      throw new Error("S3_BUCKET environment variable is required when STORAGE=s3");
    }
  }

  private key(destKey: string): string {
    return this.prefix ? `${this.prefix}${destKey}` : destKey;
  }

  async put(tempPath: string, destKey: string): Promise<void> {
    assertSafeKey(destKey);

    // INLINE sanitisation — see LocalStorage.put for the rationale.
    // The fs sinks (readFileSync, rmSync) sit INSIDE the truthy branch
    // of each `startsWith` so CodeQL's js/path-injection barrier-guard
    // recognises them as sanitised.
    if (tempPath.includes("\0")) {
      throw new Error(`unsafe temp path (null byte): ${tempPath}`);
    }
    const tempAbs = resolve(tempPath);

    if (tempAbs.startsWith(TEMP_ROOT_UPLOADS)) {
      const body = readFileSync(tempAbs);
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(destKey),
        Body: body,
        ContentType: guessContentType(destKey),
      }));
      try { rmSync(tempAbs); } catch { /* ignore */ }
      return;
    }
    if (tempAbs.startsWith(TEMP_ROOT_OS)) {
      const body = readFileSync(tempAbs);
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(destKey),
        Body: body,
        ContentType: guessContentType(destKey),
      }));
      try { rmSync(tempAbs); } catch { /* ignore */ }
      return;
    }
    throw new Error(`refusing to read from outside known temp roots: ${tempPath}`);
  }

  async getUrl(key: string): Promise<string> {
    if (this.cdnUrl) {
      return `${this.cdnUrl}/${this.key(key)}`;
    }
    // Generate presigned URL valid for 1 hour
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.key(key),
    });
    return getSignedUrl(this.client, command, { expiresIn: 3600 });
  }

  async deleteRun(runId: number): Promise<void> {
    const prefix = this.key(`runs/${runId}/`);
    let continuationToken: string | undefined;

    do {
      const list = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));

      const objects = list.Contents;
      if (objects && objects.length > 0) {
        await this.client.send(new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: {
            Objects: objects.map((o) => ({ Key: o.Key! })),
          },
        }));
      }

      continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (continuationToken);
  }
}

// Exported for unit testing (storage_content_type.unit.test.ts) — the
// SVG → octet-stream rule is a security boundary, so it's worth a
// direct test rather than going through the S3 client mock-and-spy
// dance.
export function guessContentType(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "mp4": return "video/mp4";
    case "webm": return "video/webm";
    case "gz": return "application/gzip";
    case "json": return "application/json";
    // Explicit gate: never advertise SVG as image/svg+xml. Browsers
    // execute scripts inside SVG when fetched as that MIME, which
    // turns an attached "screenshot.svg" into a stored XSS the
    // moment a user clicks the attachment link.
    case "svg":
    case "svgz": return "application/octet-stream";
    default: return "application/octet-stream";
  }
}

// --- Factory ---

const STORAGE_TYPE = process.env.STORAGE ?? "local";

let _instance: Storage | null = null;

export function getStorage(): Storage {
  if (!_instance) {
    _instance = STORAGE_TYPE === "s3" ? new S3Storage() : new LocalStorage();
  }
  return _instance;
}
