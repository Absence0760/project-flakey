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
function assertSafeKey(destKey: string): void {
  if (
    destKey.length === 0 ||
    destKey.startsWith("/") ||
    destKey.includes("\\") ||
    destKey.includes("\0") ||
    destKey.split("/").some((seg) => seg === "..")
  ) {
    throw new Error(`unsafe storage key: ${destKey}`);
  }
}

// Resolve destKey under baseDir and return the absolute path. Throws
// if the resolved path escapes baseDir. The path.resolve + prefix
// check pattern is the form CodeQL's js/path-injection rule
// recognises as a sanitiser (the older relative()-based form wasn't
// traced through end-to-end).
function safeJoinUnder(baseDir: string, destKey: string): string {
  const baseAbs = resolve(baseDir);
  const destAbs = resolve(baseAbs, destKey);
  if (destAbs !== baseAbs && !destAbs.startsWith(baseAbs + sep)) {
    throw new Error(`refusing to write outside storage root: ${destKey}`);
  }
  return destAbs;
}

// Validate that tempPath (multer's randomly-named tmp file) is under a
// known temp root before fs operations dereference it. multer's
// disk-storage filename is crypto.randomBytes-derived so it's not
// actually attacker-controlled, but CodeQL traces it back through the
// multipart parser and conservatively flags any fs op on it. The
// explicit prefix check at the storage boundary satisfies the rule
// AND adds genuine defense-in-depth if a future multer config drift
// ever lands tempPath outside the expected dir.
const TEMP_ROOTS = [
  resolve("uploads", "tmp"),
  resolve(tmpdir()),
];
function safeTempPath(tempPath: string): string {
  if (tempPath.includes("\0")) {
    throw new Error(`unsafe temp path (null byte): ${tempPath}`);
  }
  const abs = resolve(tempPath);
  for (const root of TEMP_ROOTS) {
    if (abs === root || abs.startsWith(root + sep)) return abs;
  }
  throw new Error(`refusing to read from outside known temp roots: ${tempPath}`);
}

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
    const safeTemp = safeTempPath(tempPath);
    const destAbs = safeJoinUnder(this.baseDir, destKey);
    mkdirSync(dirname(destAbs), { recursive: true });
    renameSync(safeTemp, destAbs);
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
    const safeTemp = safeTempPath(tempPath);
    const body = readFileSync(safeTemp);
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.key(destKey),
      Body: body,
      ContentType: guessContentType(destKey),
    }));
    // Clean up temp file
    try { rmSync(safeTemp); } catch { /* ignore */ }
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

function guessContentType(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "mp4": return "video/mp4";
    case "webm": return "video/webm";
    case "gz": return "application/gzip";
    case "json": return "application/json";
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
