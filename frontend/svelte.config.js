import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { mdsvex } from 'mdsvex';

export default defineConfig();

// Build the connect-src list at config-load time. The frontend
// (served from one origin) fetches the API at VITE_API_URL — a
// different origin in both dev (`http://localhost:3000`) and prod
// (`https://api.flakey.io`). CSP `'self'` only covers the page's
// own origin, so the API origin must be explicitly allow-listed
// or every fetch fails with a CSP "blocked by Content Security
// Policy" error and the dashboard renders blank.
//
// Extra entries listed in PUBLIC_CSP_CONNECT_SRC (space-separated)
// extend the list — used by ops who proxy the API behind a CDN or
// add a separate analytics endpoint.
function connectSrc() {
	const sources = new Set(["'self'"]);
	const apiUrl = process.env.VITE_API_URL || "http://localhost:3000";
	try {
		const u = new URL(apiUrl);
		sources.add(`${u.protocol}//${u.host}`);
	} catch {
		// VITE_API_URL is malformed — leave only 'self'. The fetch will
		// fail but at runtime, not at config-load time.
	}
	const extras = (process.env.PUBLIC_CSP_CONNECT_SRC || "")
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
					'img-src': ['self', 'data:', 'blob:'],
					'style-src': ['self', 'unsafe-inline'],
					'script-src': ['self'],
					'connect-src': connectSrc(),
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
