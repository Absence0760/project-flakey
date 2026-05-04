import { mkdirSync, renameSync, rmSync, existsSync, readFileSync } from "fs";
import { join, dirname, resolve, relative } from "path";
import { S3Client, PutObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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
    // Defense-in-depth path-traversal guard.  Each upload route that
    // builds destKey already sanitizes user-controlled segments, but
    // the storage layer must not assume that — node's `path.join`
    // resolves `..` and will happily write outside `baseDir` if a
    // future caller forgets to sanitize.
    const baseAbs = resolve(this.baseDir);
    const destAbs = resolve(this.baseDir, destKey);
    const rel = relative(baseAbs, destAbs);
    if (rel.startsWith("..") || rel === "" || rel.includes("\0")) {
      throw new Error(`refusing to write outside storage root: ${destKey}`);
    }
    mkdirSync(dirname(destAbs), { recursive: true });
    renameSync(tempPath, destAbs);
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
    const body = readFileSync(tempPath);
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.key(destKey),
      Body: body,
      ContentType: guessContentType(destKey),
    }));
    // Clean up temp file
    try { rmSync(tempPath); } catch { /* ignore */ }
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
