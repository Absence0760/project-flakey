import { readFileSync, existsSync } from "fs";
import { basename } from "path";
import type { ReporterOptions, NormalizedRun } from "./schema.js";

export class ApiClient {
  private url: string;
  private apiKey: string;

  constructor(options: ReporterOptions) {
    // Strip any number of trailing slashes — "https://api.flakey.io//"
    // would otherwise leave one behind and produce a double-slash "//runs"
    // path that Express does not route. Done as a linear scan, not a
    // `/\/+$/` regex: that pattern is polynomial (O(n²)) on a slash-heavy
    // url, a ReDoS vector since the url comes from reporter config.
    let end = options.url.length;
    while (end > 0 && options.url[end - 1] === "/") end--;
    this.url = options.url.slice(0, end);
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
    // Drop files that no longer exist on disk (cleaned up between onTestEnd and
    // onEnd, or a bad path) before deciding how to send — otherwise we'd POST an
    // empty multipart body. Filtering first keeps the routing decision honest.
    const screenshots = files.screenshots.filter((file) => existsSync(file));
    const videos = files.videos.filter((file) => existsSync(file));
    const snapshots = files.snapshots.filter((file) => existsSync(file));

    if (screenshots.length === 0 && videos.length === 0 && snapshots.length === 0) {
      return this.postRun(run);
    }

    const formData = new FormData();
    formData.append("payload", JSON.stringify(run));

    for (const file of screenshots) {
      formData.append("screenshots", new Blob([readFileSync(file)], { type: "image/png" }), basename(file));
    }
    for (const file of videos) {
      const type = file.endsWith(".webm") ? "video/webm" : "video/mp4";
      formData.append("videos", new Blob([readFileSync(file)], { type }), basename(file));
    }
    for (const file of snapshots) {
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
