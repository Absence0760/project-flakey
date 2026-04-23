import { readFileSync, existsSync } from "fs";
import { basename } from "path";
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

  async postRunWithFiles(
    run: NormalizedRun,
    files: { screenshots: string[]; videos: string[]; snapshots: string[] }
  ): Promise<{ id: number }> {
    const { screenshots, videos, snapshots } = files;

    if (screenshots.length === 0 && videos.length === 0 && snapshots.length === 0) {
      return this.postRun(run);
    }

    const formData = new FormData();
    formData.append("payload", JSON.stringify(run));

    for (const file of screenshots) {
      if (!existsSync(file)) continue;
      formData.append("screenshots", new Blob([readFileSync(file)], { type: "image/png" }), basename(file));
    }
    for (const file of videos) {
      if (!existsSync(file)) continue;
      const type = file.endsWith(".webm") ? "video/webm" : "video/mp4";
      formData.append("videos", new Blob([readFileSync(file)], { type }), basename(file));
    }
    for (const file of snapshots) {
      if (!existsSync(file)) continue;
      formData.append("snapshots", new Blob([readFileSync(file)], { type: "application/gzip" }), basename(file));
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
