import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, basename } from "path";
import type { ReporterOptions, NormalizedRun } from "./schema.js";

export class ApiClient {
  private url: string;
  private apiKey: string;

  constructor(options: ReporterOptions) {
    this.url = options.url.replace(/\/$/, "");
    this.apiKey = options.apiKey;
  }

  async postRun(run: NormalizedRun): Promise<{ id: number }> {
    const res = await fetch(`${this.url}/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(run),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Flakey API error ${res.status}: ${text}`);
    }

    return res.json() as Promise<{ id: number }>;
  }

  async postRunWithArtifacts(
    run: NormalizedRun,
    opts: { screenshotsDir?: string; snapshotsDir?: string; videosDir?: string }
  ): Promise<{ id: number }> {
    const screenshots = findFiles(opts.screenshotsDir, [".png"]);
    const snapshots = findFiles(opts.snapshotsDir, [".json.gz"]);
    const videos = findFiles(opts.videosDir, [".mp4", ".webm"]);

    // If no artifacts, use the simple JSON endpoint
    if (screenshots.length === 0 && snapshots.length === 0 && videos.length === 0) {
      return this.postRun(run);
    }

    const formData = new FormData();
    formData.append("payload", JSON.stringify({
      meta: run.meta,
      stats: run.stats,
      specs: run.specs,
    }));

    for (const file of screenshots) {
      const data = readFileSync(file);
      formData.append("screenshots", new Blob([data], { type: "image/png" }), basename(file));
    }

    for (const file of videos) {
      const type = file.endsWith(".webm") ? "video/webm" : "video/mp4";
      const data = readFileSync(file);
      formData.append("videos", new Blob([data], { type }), basename(file));
    }

    for (const file of snapshots) {
      const data = readFileSync(file);
      formData.append("snapshots", new Blob([data], { type: "application/gzip" }), basename(file));
    }

    const res = await fetch(`${this.url}/runs/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: formData,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Flakey API error ${res.status}: ${text}`);
    }

    return res.json() as Promise<{ id: number }>;
  }
}

function findFiles(dir: string | undefined, exts: string[]): string[] {
  if (!dir || !existsSync(dir)) return [];
  const results: string[] = [];

  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (exts.some((ext) => entry.endsWith(ext))) {
          results.push(full);
        }
      } catch {
        // Skip inaccessible files
      }
    }
  }

  walk(dir);
  return results;
}
