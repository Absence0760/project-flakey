import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { mdsvex } from 'mdsvex';

export default defineConfig();

// The API origin (VITE_API_URL) — a different origin from the page in
// both dev (`http://localhost:3000` vs the :7778 dev server) and prod
// (`https://api.flakey.io`). CSP `'self'` only covers the page's own
// origin, so EVERY directive that loads from the API must allow-list it:
//   - connect-src — fetch()/authFetch() calls (data; omit → dashboard
//     renders blank).
//   - img-src     — test screenshots are <img> elements served straight
//     from /uploads on the API origin (omit → every screenshot is blocked
//     with a CSP "img-src" violation; the page still loads because
//     connect-src IS allow-listed — that asymmetry is what hid this).
//   - media-src   — failure videos are <video> elements, same /uploads
//     origin (omit → falls back to default-src 'self' and won't play).
function apiOrigin() {
	const apiUrl = process.env.VITE_API_URL || "http://localhost:3000";
	try {
		const u = new URL(apiUrl);
		return `${u.protocol}//${u.host}`;
	} catch {
		// VITE_API_URL is malformed — leave it out. The request fails at
		// runtime, not at config-load time.
		return null;
	}
}

// Build a CSP source list at config-load time: a fixed `base` + the API
// origin + any space-separated extras from `envVar`. The env hook lets ops
// who serve artifacts from a separate CDN / S3 bucket (e.g. STORAGE=s3
// presigned URLs live on the bucket origin, not the API) extend the list
// without patching this file: PUBLIC_CSP_CONNECT_SRC / PUBLIC_CSP_IMG_SRC /
// PUBLIC_CSP_MEDIA_SRC.
function cspSources(base, envVar) {
	const sources = new Set(base);
	const api = apiOrigin();
	if (api) sources.add(api);
	const extras = (process.env[envVar] || "")
		.split(/\s+/)
		.filter(Boolean);
	for (const e of extras) sources.add(e);
	return [...sources];
}

/** @type {() => import('@sveltejs/kit').Config} */
function defineConfig() {
	return {
		extensions: ['.svelte', '.md'],
		compilerOptions: {
			modernAst: true,
			warningFilter,
		},
		// Consult https://kit.svelte.dev/docs/integrations#preprocessors
		// for more information about preprocessors
		preprocess: [vitePreprocess(), mdsvex({ extensions: ['.md'] })],

		kit: {
			// See https://kit.svelte.dev/docs/adapters for more information about adapters.
			adapter: adapter({
				fallback: "index.html",
				prerender: { default: true },
			}),
			paths: {
				base: process.env.BASE_PATH || '',
			},
			inlineStyleThreshold: 0,
			// CSP injected as a <meta> tag in every prerendered HTML page.
			// Complements the CloudFront response_headers_policy that
			// applies the same gate at the response-header layer; both
			// run in browsers and the most-restrictive directives win.
			// `script-src 'self'` rejects inline + remote scripts; the
			// hash-mode lets SvelteKit auto-add hashes for any inline
			// hydration script the framework emits.
			csp: {
				mode: 'hash',
				directives: {
					'default-src': ['self'],
					'img-src': cspSources(["'self'", 'data:', 'blob:'], 'PUBLIC_CSP_IMG_SRC'),
					'media-src': cspSources(["'self'", 'blob:'], 'PUBLIC_CSP_MEDIA_SRC'),
					'style-src': ['self', 'unsafe-inline'],
					'script-src': ['self'],
					'connect-src': cspSources(["'self'"], 'PUBLIC_CSP_CONNECT_SRC'),
					'frame-ancestors': ['none'],
					'base-uri': ['self'],
					'form-action': ['self'],
				},
			},
		},
	};
}

/**
 * Filter out noisy deprecation warnings from the compiled code.
 * Hopefully by svelte 5's release, this will no longer be needed.
 * @type {NonNullable<NonNullable<import('@sveltejs/kit').Config['compilerOptions']>['warningFilter']>}
 */
function warningFilter(warning) {
	const ignorePatterns = [/node_modules/, /\.svelte-kit/];
	const ignoredWarningCodes = [
		"svelte_component_deprecated",
		"slot_element_deprecated",
		"a11y_no_noninteractive_tabindex",
		"css_unused_selector",
	];
	if (
		ignorePatterns.some((pattern) => pattern.test(warning.filename ?? "")) &&
		ignoredWarningCodes.includes(warning.code)
	) {
		return false;
	}

	return true;
}
