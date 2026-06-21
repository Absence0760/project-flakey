// Regenerate the landing-page hero screenshots (static/hero-dashboard-{light,dark}.png).
//
// These are real captures of the /dashboard route, framed in the faux
// browser window on /welcome. Rerun this when the dashboard UI changes
// materially so the marketing shot doesn't drift from the product.
//
// Prereqs (same stack the e2e suite needs):
//   pnpm db:up && (cd backend && npm run seed)   # seeded Postgres
//   cd backend && npm run dev                     # backend on :3000
//   pnpm --filter frontend dev                    # frontend on :7778
// Then, from frontend/:
//   node scripts/capture-hero.mjs
//
// Env overrides: APP_URL (default http://localhost:7778),
// API_URL (default http://localhost:3000), SEED_EMAIL / SEED_PASSWORD
// (default the seeded admin admin@example.com / admin).

import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const APP = process.env.APP_URL ?? "http://localhost:7778";
const API = process.env.API_URL ?? "http://localhost:3000";
const EMAIL = process.env.SEED_EMAIL ?? "admin@example.com";
const PASSWORD = process.env.SEED_PASSWORD ?? "admin";

// Clip height chosen to end in the gap below the first suite-health row
// (at-risk strip + headline stats + one card row), so nothing is cut
// mid-card. Bump if the dashboard's top section grows.
const CLIP = { x: 0, y: 0, width: 1440, height: 805 };

const staticDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "static");

const res = await fetch(`${API}/auth/login`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!res.ok) {
	throw new Error(`Login failed (${res.status}). Is the backend up and seeded?`);
}
const auth = await res.json();

const browser = await chromium.launch();
try {
	for (const scheme of ["light", "dark"]) {
		const ctx = await browser.newContext({
			viewport: { width: 1440, height: 900 },
			colorScheme: scheme,
			deviceScaleFactor: 2,
		});
		const page = await ctx.newPage();
		// Seed the auth singleton's localStorage (bt_* keys) before any script runs.
		await page.addInitScript((a) => {
			localStorage.setItem("bt_token", a.token);
			localStorage.setItem("bt_refresh", a.refreshToken);
			localStorage.setItem("bt_user", JSON.stringify(a.user));
		}, auth);
		await page.goto(`${APP}/dashboard`, { waitUntil: "domcontentloaded" });
		await page.waitForLoadState("load").catch(() => {});
		// Let charts/data settle (the dashboard streams stats in after mount).
		await page.waitForTimeout(2500);
		const out = resolve(staticDir, `hero-dashboard-${scheme}.png`);
		await page.screenshot({ path: out, clip: CLIP });
		console.log(`wrote ${out}`);
		await ctx.close();
	}
} finally {
	await browser.close();
}
console.log("Done. Re-optimise with: magick <png> -resize 1600x -strip <png>");
