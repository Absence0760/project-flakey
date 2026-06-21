<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { restoreAuth, getAuth } from '$lib/stores/auth';
	import { API_URL } from '$lib/utils/config';

	// Show a brief loading frame while the auth check decides whether
	// to redirect — without this, returning visitors see a flash of
	// landing copy before the redirect fires. `ready` flips true after
	// the (sync) restoreAuth + auth check completes.
	let ready = $state(false);

	// Backend's ALLOW_REGISTRATION posture. null while we're still
	// fetching (or if the fetch failed); UI treats null as "show the
	// button" — same as the open case — because hiding when we don't
	// know would block legitimate users in transient backend-blip
	// scenarios. The endpoint itself is public + cheap to call.
	let registrationOpen = $state<boolean | null>(null);

	onMount(async () => {
		restoreAuth();
		const auth = getAuth();
		if (auth.token && auth.user) {
			goto('/dashboard');
			return;
		}
		ready = true;
		try {
			const res = await fetch(`${API_URL}/auth/registration-status`);
			if (res.ok) {
				const body = (await res.json()) as { open?: boolean };
				registrationOpen = body.open === true;
			}
		} catch {
			// Backend unreachable — leave null so the CTA stays visible.
			// If the user tries to register and the backend is actually
			// down, the form will surface a proper network error.
		}
	});

	function go(path: string) {
		return (event: MouseEvent) => {
			event.preventDefault();
			menuOpen = false;
			goto(path);
		};
	}

	// Mobile section-nav disclosure. At ≤720px the inline nav links are
	// hidden; this drives a hamburger menu so small-screen visitors keep
	// access to Features / Compare / How-it-works / Self-host.
	let menuOpen = $state(false);

	function onWindowKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && menuOpen) {
			menuOpen = false;
		}
	}

	// "Show the register CTA?" — true unless we've explicitly heard
	// "closed" back from the backend. Null (still loading / fetch
	// failed) defaults to open so the page works during the initial
	// paint and degrades gracefully if /registration-status is
	// unreachable.
	const showRegister = $derived(registrationOpen !== false);

	// Optional absolute site origin for canonical + social-card URLs.
	// Self-hosters leave VITE_SITE_URL unset — relative URLs work for the
	// major scrapers, and hard-coding a domain would point their cards at
	// someone else's host. The canonical flakey.io build sets it so the
	// Open Graph / Twitter cards resolve to absolute URLs everywhere (the
	// strict scrapers that don't resolve a relative og:image then work too).
	const siteUrl = (import.meta.env.VITE_SITE_URL ?? '').replace(/\/+$/, '');
	const ogImage = `${siteUrl}/og-card.png`;
	const canonical = siteUrl ? `${siteUrl}/welcome` : undefined;

	// Human-readable support labels for the comparison cells. The visual
	// mark (check / half / dash) is reinforced for screen readers with a
	// real word instead of the internal "yes" | "partial" | "no" key.
	const supportLabel: Record<'yes' | 'partial' | 'no', string> = {
		yes: 'Supported',
		partial: 'Partial support',
		no: 'Not supported',
	};

	// Competitor comparison matrix. Kept declarative so the table stays
	// scannable and a future row addition doesn't require touching the
	// markup. Each entry is `[product] -> Map<feature, support>` where
	// support is "yes" | "partial" | "no" | string (a short note).
	type Cell = { kind: 'yes' | 'partial' | 'no'; note?: string };
	type Feature = { label: string; description: string; cells: { flakey: Cell; cypressCloud: Cell; browserstack: Cell; currents: Cell; testrail: Cell } };

	const yes = (note?: string): Cell => ({ kind: 'yes', note });
	const no = (note?: string): Cell => ({ kind: 'no', note });
	const partial = (note?: string): Cell => ({ kind: 'partial', note });

	const features: Feature[] = [
		{
			label: 'Self-hosted',
			description: 'Run on your own infrastructure, keep test data inside your network.',
			cells: {
				flakey: yes('MIT, single docker-compose up'),
				cypressCloud: no('SaaS only'),
				browserstack: no('SaaS only'),
				currents: partial('Enterprise tier only'),
				testrail: yes('Self-hosted edition exists'),
			},
		},
		{
			label: 'CI-agnostic',
			description: 'Works with any test framework — Cypress, Playwright, WebdriverIO, pytest, Selenium, Jest, JUnit, Postman.',
			cells: {
				flakey: yes('7 reporters out of the box'),
				cypressCloud: no('Cypress only'),
				browserstack: yes('Multi-framework'),
				currents: no('Cypress + Playwright only'),
				testrail: yes('Manual + automated'),
			},
		},
		{
			label: 'Manual + automated in one place',
			description: 'Manual exploratory testing, release sign-off checklists, and automated runs share the same project view.',
			cells: {
				flakey: yes('Releases, checklists, traceability'),
				cypressCloud: no(),
				browserstack: no(),
				currents: no(),
				testrail: partial('Manual-first, automated via API'),
			},
		},
		{
			label: 'Flakiness detection + quarantine',
			description: 'Automatic flaky-test classification, one-click quarantine, history of pass/fail alternation.',
			cells: {
				flakey: yes('Built-in'),
				cypressCloud: yes('Built-in'),
				browserstack: yes('Built-in'),
				currents: yes('Built-in'),
				testrail: no(),
			},
		},
		{
			label: 'Live test streaming',
			description: 'See tests pass/fail in real time as they run on CI — no waiting for the suite to finish.',
			cells: {
				flakey: yes('SSE-based, ~hundred-ms latency'),
				cypressCloud: yes(),
				browserstack: yes(),
				currents: yes(),
				testrail: no(),
			},
		},
		{
			label: 'DOM snapshots per test step',
			description: 'Replay the captured DOM at each step to debug failures without re-running the test.',
			cells: {
				flakey: yes('Cypress + Playwright'),
				cypressCloud: yes('Cypress only'),
				browserstack: yes(),
				currents: partial('Cypress only'),
				testrail: no(),
			},
		},
		{
			label: 'AI-assisted failure analysis',
			description: 'LLM groups similar failures, explains root cause, and surfaces likely-related tests.',
			cells: {
				flakey: yes('OpenAI / Anthropic / Ollama'),
				cypressCloud: partial('"Test Replay AI"'),
				browserstack: yes(),
				currents: no(),
				testrail: no(),
			},
		},
		{
			label: 'Jira / PagerDuty integration',
			description: 'Auto-create issues, page on-call when a deploy regresses critical tests.',
			cells: {
				flakey: yes('Both, encrypted at rest'),
				cypressCloud: yes(),
				browserstack: yes(),
				currents: partial('Jira via webhooks'),
				testrail: yes(),
			},
		},
		{
			label: 'Open source',
			description: 'Inspect the code, fork it, host it without per-seat licensing.',
			cells: {
				flakey: yes('MIT'),
				cypressCloud: no('Proprietary'),
				browserstack: no('Proprietary'),
				currents: partial('Reporter SDK MIT; backend closed'),
				testrail: no('Proprietary'),
			},
		},
		{
			label: 'Pricing model',
			description: 'How the meter ticks.',
			cells: {
				flakey: yes('Free, your hardware'),
				cypressCloud: no('Per test result / month'),
				browserstack: no('Per parallel session'),
				currents: no('Per test result / month'),
				testrail: no('Per user / month'),
			},
		},
	];
</script>

<svelte:head>
	<title>Flakey — self-hosted, CI-agnostic test reporting</title>
	<meta
		name="description"
		content="Self-hosted test reporting dashboard. Ingests results from Cypress, Playwright, WebdriverIO, pytest, Selenium, Jest, and JUnit. Flaky detection, live streaming, manual-test sign-off, and release readiness in one tool. MIT-licensed."
	/>
	{#if canonical}<link rel="canonical" href={canonical} />{/if}

	<!-- Open Graph (Facebook, LinkedIn, Slack, Discord, …) -->
	<meta property="og:type" content="website" />
	<meta property="og:site_name" content="Flakey" />
	<meta property="og:title" content="Flakey — self-hosted, CI-agnostic test reporting" />
	<meta
		property="og:description"
		content="Ingest results from any reporter. See flaky tests, regressions, and release readiness in one self-hosted dashboard. No SaaS lock-in, no per-test-result pricing. MIT-licensed."
	/>
	{#if canonical}<meta property="og:url" content={canonical} />{/if}
	<meta property="og:image" content={ogImage} />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta property="og:image:alt" content="Flakey — self-hosted, CI-agnostic test reporting dashboard" />

	<!-- Twitter / X large-summary card -->
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content="Flakey — self-hosted, CI-agnostic test reporting" />
	<meta
		name="twitter:description"
		content="Ingest results from any reporter. Flaky detection, live streaming, manual-test sign-off, and release readiness in one self-hosted, MIT-licensed dashboard."
	/>
	<meta name="twitter:image" content={ogImage} />
	<meta name="twitter:image:alt" content="Flakey — self-hosted, CI-agnostic test reporting dashboard" />
</svelte:head>

<svelte:window onkeydown={onWindowKeydown} />

{#if ready}
	<div class="page">
		<header class="topbar">
			<a href="/welcome" class="brand">
				<svg class="brand-icon" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
					<defs>
						<linearGradient id="brand-bg" x1="0%" y1="0%" x2="100%" y2="100%">
							<stop offset="0%" stop-color="#4F46E5" />
							<stop offset="100%" stop-color="#7C3AED" />
						</linearGradient>
					</defs>
					<rect x="16" y="16" width="480" height="480" rx="96" ry="96" fill="url(#brand-bg)" />
					<rect x="136" y="144" width="240" height="280" rx="20" ry="20" fill="white" opacity="0.95" />
					<rect x="196" y="112" width="120" height="56" rx="12" ry="12" fill="white" opacity="0.95" />
					<rect x="220" y="100" width="72" height="36" rx="18" ry="18" fill="url(#brand-bg)" />
					<polyline points="192,296 240,344 320,248" fill="none" stroke="url(#brand-bg)" stroke-width="32" stroke-linecap="round" stroke-linejoin="round" />
				</svg>
				<span class="brand-name">Flakey</span>
			</a>
			<nav class="topnav">
				<a href="#features">Features</a>
				<a href="#compare">Compare</a>
				<a href="#how-it-works">How it works</a>
				<a href="https://github.com/Absence0760/project-flakey#self-host" rel="noopener" target="_blank">Self-host ↗</a>
				<a href="/login" class="topnav-cta" onclick={go('/login')}>Sign in →</a>
			</nav>

			<button
				type="button"
				class="nav-toggle"
				aria-label={menuOpen ? 'Close menu' : 'Open menu'}
				aria-expanded={menuOpen}
				aria-controls="mobile-nav"
				onclick={() => (menuOpen = !menuOpen)}
			>
				{#if menuOpen}
					<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
						<path d="M6 6l12 12M18 6L6 18" />
					</svg>
				{:else}
					<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
						<path d="M4 7h16M4 12h16M4 17h16" />
					</svg>
				{/if}
			</button>
		</header>

		{#if menuOpen}
			<nav id="mobile-nav" class="mobile-nav">
				<a href="#features" onclick={() => (menuOpen = false)}>Features</a>
				<a href="#compare" onclick={() => (menuOpen = false)}>Compare</a>
				<a href="#how-it-works" onclick={() => (menuOpen = false)}>How it works</a>
				<a
					href="https://github.com/Absence0760/project-flakey#self-host"
					rel="noopener"
					target="_blank"
					onclick={() => (menuOpen = false)}
				>
					Self-host ↗
				</a>
				<a href="/login" class="mobile-nav-cta" onclick={go('/login')}>Sign in →</a>
			</nav>
		{/if}

		<section class="hero">
			<div class="hero-inner">
				<span class="eyebrow">Open source · MIT · self-hosted</span>
				<h1>Self-hosted test reporting, CI-agnostic.</h1>
				<p class="lede">
					Ingest results from any reporter. See flaky tests, regressions, and release readiness in one dashboard.
					No SaaS lock-in, no per-test-result pricing — your test data stays in your network.
				</p>
				<div class="hero-cta">
					{#if showRegister}
						<a href="/login?mode=register" class="btn primary" onclick={go('/login?mode=register')}>Create an account</a>
						<a href="/login" class="btn ghost" onclick={go('/login')}>Sign in</a>
					{:else}
						<a href="/login" class="btn primary" onclick={go('/login')}>Sign in</a>
					{/if}
					<a
						href="https://github.com/Absence0760/project-flakey#self-host"
						rel="noopener"
						target="_blank"
						class="btn ghost"
					>
						<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
							<rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
							<path d="M5 7l3-3 3 3M8 4v8" />
						</svg>
						Self-host
						<span class="external-arrow">↗</span>
					</a>
				</div>
				{#if registrationOpen === false}
					<div class="invite-only-note" data-test="invite-only-note">
						<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
							<rect x="2" y="3" width="12" height="10" rx="1.5" />
							<path d="M2 4l6 5 6-5" />
						</svg>
						<span>This instance is <strong>invite-only</strong>. Ask your admin for an invite, or sign in if you've already been invited.</span>
					</div>
				{/if}
				<div class="hero-meta">
					<span>Works with <strong>Cypress</strong>, <strong>Playwright</strong>, <strong>WebdriverIO</strong>, <strong>pytest</strong>, <strong>Selenium</strong>, <strong>Jest</strong>, <strong>JUnit</strong>, <strong>Postman</strong>.</span>
				</div>
			</div>

			<!-- CSS-only product-preview placeholder. A real dashboard
			     screenshot should replace this framed mock before launch. -->
			<div class="hero-preview" aria-hidden="true">
				<div class="preview-frame">
					<div class="preview-chrome">
						<span class="preview-dot"></span>
						<span class="preview-dot"></span>
						<span class="preview-dot"></span>
						<span class="preview-url">flakey · runs</span>
					</div>
					<div class="preview-body">
						<div class="preview-stats">
							<div class="preview-stat pass"><span class="preview-stat-num">1,284</span><span class="preview-stat-label">passed</span></div>
							<div class="preview-stat fail"><span class="preview-stat-num">7</span><span class="preview-stat-label">failed</span></div>
							<div class="preview-stat skip"><span class="preview-stat-num">12</span><span class="preview-stat-label">flaky</span></div>
						</div>
						<div class="preview-rows">
							<div class="preview-row"><span class="preview-state pass"></span><span class="preview-bar" style="width: 96%"></span></div>
							<div class="preview-row"><span class="preview-state pass"></span><span class="preview-bar" style="width: 82%"></span></div>
							<div class="preview-row"><span class="preview-state fail"></span><span class="preview-bar" style="width: 67%"></span></div>
							<div class="preview-row"><span class="preview-state skip"></span><span class="preview-bar" style="width: 74%"></span></div>
							<div class="preview-row"><span class="preview-state pass"></span><span class="preview-bar" style="width: 90%"></span></div>
							<div class="preview-row"><span class="preview-state pass"></span><span class="preview-bar" style="width: 58%"></span></div>
						</div>
					</div>
				</div>
				<span class="preview-caption">Illustrative preview</span>
			</div>
		</section>

		<section id="features" class="features">
			<h2 class="section-heading">What you get</h2>
			<div class="feature-grid">
				<article class="feature-card">
					<div class="feature-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
							<rect x="3" y="4" width="18" height="14" rx="2" />
							<path d="M3 9h18M7 13l2 2-2 2M12 17h4" />
						</svg>
					</div>
					<h3>Multi-framework reporters</h3>
					<p>One backend, seven first-class reporter packages. Drop a single config block into your existing CI — no migrating off your test runner.</p>
				</article>
				<article class="feature-card">
					<div class="feature-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
							<path d="M13 2L4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5z" />
						</svg>
					</div>
					<h3>Flaky-test detection</h3>
					<p>Automatic classification of tests that alternate pass/fail across runs. One-click quarantine pulls them out of your green-build calculation until they're fixed.</p>
				</article>
				<article class="feature-card">
					<div class="feature-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
							<circle cx="12" cy="12" r="9" />
							<path d="M12 7v5l3.5 2" />
						</svg>
					</div>
					<h3>Live run streaming</h3>
					<p>SSE-based per-test events let you watch a long suite progress as it runs on CI. No waiting for the suite to finish to see the first failure.</p>
				</article>
				<article class="feature-card">
					<div class="feature-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
							<path d="M9 11l3 3 5-6" />
							<path d="M21 12a9 9 0 1 1-5-8.05" />
						</svg>
					</div>
					<h3>Release sign-off + manual tests</h3>
					<p>Release checklists, manual test sessions, evidence attachments, and the automated suite share one project. Manual and automated track the same release together.</p>
				</article>
				<article class="feature-card">
					<div class="feature-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
							<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z" />
							<path d="M18 14l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z" />
						</svg>
					</div>
					<h3>Error grouping + AI explain</h3>
					<p>Failures grouped by error fingerprint. Optional LLM (OpenAI / Anthropic / local Ollama) explains likely root cause and surfaces related failures across runs.</p>
				</article>
				<article class="feature-card">
					<div class="feature-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
							<rect x="3" y="4" width="18" height="7" rx="1.5" />
							<rect x="3" y="13" width="18" height="7" rx="1.5" />
							<path d="M7 7.5h.01M7 16.5h.01" />
						</svg>
					</div>
					<h3>Self-hosted on your terms</h3>
					<p>Docker compose for local dev, Terraform stacks for AWS ECS Fargate. RLS-enforced multi-tenancy at the database layer. No data leaves your account.</p>
				</article>
			</div>
		</section>

		<section id="compare" class="compare">
			<h2 class="section-heading">How Flakey compares</h2>
			<p class="section-lede">
				The honest version — different tools for different teams. Here's where Flakey wins and where the alternatives are stronger.
			</p>
			<div class="compare-table-wrap">
				<table class="compare-table">
					<thead>
						<tr>
							<th class="feature-col">Feature</th>
							<th class="product-col flakey-col">Flakey</th>
							<th class="product-col">Cypress Cloud</th>
							<th class="product-col">BrowserStack</th>
							<th class="product-col">Currents.dev</th>
							<th class="product-col">TestRail</th>
						</tr>
					</thead>
					<tbody>
						{#each features as feature}
							<tr>
								<td class="feature-cell">
									<div class="feature-label">{feature.label}</div>
									<div class="feature-desc">{feature.description}</div>
								</td>
								{#each ['flakey', 'cypressCloud', 'browserstack', 'currents', 'testrail'] as key}
									{@const cell = feature.cells[key as keyof typeof feature.cells]}
									<td class="cell {cell.kind}" class:flakey-cell={key === 'flakey'}>
										<span class="cell-mark" role="img" aria-label={supportLabel[cell.kind]}>
											{#if cell.kind === 'yes'}
												<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
													<path d="M3 8.5l3.5 3.5L13 4.5" />
												</svg>
											{:else if cell.kind === 'partial'}
												<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
													<circle cx="8" cy="8" r="6" />
													<path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" stroke="none" />
												</svg>
											{:else}
												<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
													<path d="M4 8h8" />
												</svg>
											{/if}
										</span>
										{#if cell.note}<span class="cell-note">{cell.note}</span>{/if}
									</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p class="compare-footnote">
				Cells claim what each vendor publicly documents at the time of writing. If something's wrong or outdated, please
				<a href="https://github.com/Absence0760/project-flakey/issues" rel="noopener" target="_blank">open an issue</a> — we'd rather correct the table than fudge it.
			</p>
		</section>

		<section id="how-it-works" class="how">
			<h2 class="section-heading">How it works</h2>
			<ol class="how-list">
				<li>
					<span class="step-num">1</span>
					<div>
						<h3>Install a reporter package in your test project</h3>
						<p>One <code>pnpm add</code> for the framework you already use. The reporter handles uploads, screenshots, videos, and DOM snapshots automatically.</p>
					</div>
				</li>
				<li>
					<span class="step-num">2</span>
					<div>
						<h3>Set <code>FLAKEY_API_URL</code> + <code>FLAKEY_API_KEY</code> in CI</h3>
						<p>Two env vars. CI metadata (branch, commit, PR ref) is picked up automatically from GitHub Actions, Bitbucket, or any other CI's standard environment.</p>
					</div>
				</li>
				<li>
					<span class="step-num">3</span>
					<div>
						<h3>Watch the dashboard light up</h3>
						<p>Live events stream in as the suite runs. Failures fingerprint and group automatically; flaky tests surface on the next run that re-passes them.</p>
					</div>
				</li>
			</ol>
		</section>

		<section class="cta">
			<div class="cta-inner">
				<h2>Get started in under a minute</h2>
				{#if showRegister}
					<p>Sign in if you already have an account, or create one to get started. Self-hosting? See the README on GitHub.</p>
				{:else}
					<p>Sign in if you've already been invited. New users need an invite from an existing admin on this instance.</p>
				{/if}
				<div class="cta-buttons">
					{#if showRegister}
						<a href="/login?mode=register" class="btn primary" onclick={go('/login?mode=register')}>Create an account</a>
						<a href="/login" class="btn ghost" onclick={go('/login')}>Sign in</a>
					{:else}
						<a href="/login" class="btn primary" onclick={go('/login')}>Sign in</a>
					{/if}
					<a href="https://github.com/Absence0760/project-flakey" rel="noopener" target="_blank" class="btn ghost">
						GitHub <span class="external-arrow">↗</span>
					</a>
				</div>
			</div>
		</section>

		<footer class="footer">
			<div class="footer-inner">
				<span>© Flakey · MIT · <a href="https://github.com/Absence0760/project-flakey" rel="noopener" target="_blank">github.com/Absence0760/project-flakey</a></span>
				<a href="/login" onclick={go('/login')}>Sign in →</a>
			</div>
		</footer>
	</div>
{:else}
	<div class="loading-screen" aria-hidden="true"></div>
{/if}

<style>
	.loading-screen {
		min-height: 100vh;
		background: var(--bg);
	}

	.page {
		min-height: 100vh;
		background: var(--bg);
		color: var(--text);
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
	}

	/* ── Top bar ───────────────────────────────────────────────── */
	.topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		max-width: 1200px;
		margin: 0 auto;
		padding: 1.25rem 1.5rem;
		border-bottom: 1px solid var(--border-light);
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		text-decoration: none;
		color: var(--text);
		font-weight: 700;
		font-size: 1.05rem;
	}

	.brand-icon {
		width: 28px;
		height: 28px;
	}

	.topnav {
		display: flex;
		align-items: center;
		gap: 1.75rem;
	}

	.topnav a {
		color: var(--text-secondary);
		text-decoration: none;
		font-size: 0.92rem;
		transition: color 0.1s;
	}

	.topnav a:hover {
		color: var(--text);
	}

	.topnav-cta {
		padding: 0.45rem 0.9rem;
		border-radius: 6px;
		background: var(--link);
		color: #fff !important;
		font-weight: 600;
	}

	.topnav-cta:hover {
		color: #fff !important;
		filter: brightness(1.08);
	}

	/* ── Mobile nav ────────────────────────────────────────────── */
	.nav-toggle {
		display: none;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		padding: 0;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-secondary);
		color: var(--text);
		cursor: pointer;
		transition: background 0.1s, border-color 0.1s;
	}

	.nav-toggle:hover {
		background: var(--bg-hover);
		border-color: var(--link);
	}

	.nav-toggle:focus-visible {
		outline: 2px solid var(--link);
		outline-offset: 2px;
	}

	.mobile-nav {
		display: none;
		flex-direction: column;
		gap: 0.25rem;
		max-width: 1200px;
		margin: 0 auto;
		padding: 0.5rem 1.5rem 1rem;
		border-bottom: 1px solid var(--border-light);
	}

	.mobile-nav a {
		padding: 0.7rem 0.75rem;
		border-radius: 8px;
		color: var(--text-secondary);
		text-decoration: none;
		font-size: 0.98rem;
		transition: background 0.1s, color 0.1s;
	}

	.mobile-nav a:hover {
		background: var(--bg-secondary);
		color: var(--text);
	}

	.mobile-nav-cta {
		margin-top: 0.35rem;
		background: var(--link);
		color: #fff !important;
		font-weight: 600;
		text-align: center;
	}

	.mobile-nav-cta:hover {
		background: var(--link);
		filter: brightness(1.08);
		color: #fff !important;
	}

	/* ── Hero ──────────────────────────────────────────────────── */
	.hero {
		max-width: 1200px;
		margin: 0 auto;
		padding: 5rem 1.5rem 4.5rem;
		display: grid;
		grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr);
		align-items: center;
		gap: 3rem;
	}

	.hero-inner {
		max-width: 640px;
	}

	.eyebrow {
		display: inline-block;
		font-size: 0.78rem;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--link);
		background: color-mix(in srgb, var(--link) 10%, transparent);
		padding: 0.3rem 0.7rem;
		border-radius: 999px;
		font-weight: 600;
		margin-bottom: 1.5rem;
	}

	.hero h1 {
		font-size: clamp(2.25rem, 4.5vw, 3.5rem);
		line-height: 1.1;
		letter-spacing: -0.02em;
		font-weight: 700;
		margin: 0 0 1.25rem;
	}

	.lede {
		font-size: 1.15rem;
		line-height: 1.55;
		color: var(--text-secondary);
		margin: 0 0 2rem;
		max-width: 640px;
	}

	.hero-cta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		margin-bottom: 2rem;
	}

	.btn {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.7rem 1.3rem;
		border-radius: 8px;
		font-size: 0.95rem;
		font-weight: 600;
		text-decoration: none;
		transition: filter 0.1s, transform 0.05s, background 0.1s;
		border: 1px solid transparent;
	}

	.btn:active {
		transform: translateY(1px);
	}

	.btn.primary {
		background: var(--link);
		color: #fff;
	}

	.btn.primary:hover {
		filter: brightness(1.08);
	}

	.btn.ghost {
		background: transparent;
		color: var(--text);
		border-color: var(--border);
	}

	.btn.ghost:hover {
		background: var(--bg-hover);
	}

	.external-arrow {
		font-size: 0.85rem;
		opacity: 0.7;
	}

	.hero-meta {
		font-size: 0.88rem;
		color: var(--text-muted);
	}

	.hero-meta strong {
		color: var(--text-secondary);
		font-weight: 600;
	}

	.invite-only-note {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 1.25rem;
		padding: 0.55rem 0.85rem;
		border-radius: 8px;
		background: color-mix(in srgb, var(--color-skip) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--color-skip) 30%, transparent);
		color: var(--text-secondary);
		font-size: 0.88rem;
		max-width: 100%;
	}

	.invite-only-note svg {
		flex-shrink: 0;
		color: var(--color-skip);
	}

	.invite-only-note strong {
		color: var(--text);
		font-weight: 600;
	}

	/* ── Hero product preview (CSS-only placeholder) ───────────── */
	.hero-preview {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.6rem;
	}

	.preview-frame {
		width: 100%;
		border: 1px solid var(--border);
		border-radius: 14px;
		background: var(--bg-secondary);
		overflow: hidden;
		box-shadow: 0 18px 48px -28px color-mix(in srgb, var(--link) 55%, transparent),
			0 1px 0 var(--border-light);
	}

	.preview-chrome {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.6rem 0.85rem;
		border-bottom: 1px solid var(--border-light);
		background: var(--bg);
	}

	.preview-dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--border);
	}

	.preview-url {
		margin-left: 0.6rem;
		font-size: 0.74rem;
		color: var(--text-muted);
		font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
	}

	.preview-body {
		padding: 1rem;
	}

	.preview-stats {
		display: flex;
		gap: 0.6rem;
		margin-bottom: 1rem;
	}

	.preview-stat {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		padding: 0.6rem 0.7rem;
		border-radius: 9px;
		border: 1px solid var(--border-light);
		background: var(--bg);
	}

	.preview-stat-num {
		font-size: 1.15rem;
		font-weight: 700;
		line-height: 1;
	}

	.preview-stat-label {
		font-size: 0.66rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}

	.preview-stat.pass .preview-stat-num {
		color: var(--color-pass);
	}

	.preview-stat.fail .preview-stat-num {
		color: var(--color-fail);
	}

	.preview-stat.skip .preview-stat-num {
		color: var(--color-skip);
	}

	.preview-rows {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.preview-row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}

	.preview-state {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.preview-state.pass {
		background: var(--color-pass);
	}

	.preview-state.fail {
		background: var(--color-fail);
	}

	.preview-state.skip {
		background: var(--color-skip);
	}

	.preview-bar {
		height: 8px;
		border-radius: 999px;
		background: linear-gradient(90deg, color-mix(in srgb, var(--link) 45%, transparent), color-mix(in srgb, var(--link) 12%, transparent));
	}

	.preview-caption {
		font-size: 0.72rem;
		color: var(--text-muted);
	}

	/* ── Section primitives ────────────────────────────────────── */
	.section-heading {
		font-size: 1.85rem;
		font-weight: 700;
		letter-spacing: -0.015em;
		margin: 0 0 1rem;
	}

	.section-lede {
		font-size: 1rem;
		color: var(--text-secondary);
		max-width: 640px;
		margin: 0 0 2.5rem;
		line-height: 1.55;
	}

	/* ── Features ──────────────────────────────────────────────── */
	.features {
		max-width: 1200px;
		margin: 0 auto;
		padding: 4rem 1.5rem;
		border-top: 1px solid var(--border-light);
	}

	.feature-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: 1.25rem;
		margin-top: 2rem;
	}

	.feature-card {
		padding: 1.5rem;
		border: 1px solid var(--border);
		border-radius: 12px;
		background: var(--bg-secondary);
		transition: border-color 0.15s, transform 0.1s;
	}

	.feature-card:hover {
		border-color: var(--link);
		transform: translateY(-2px);
	}

	.feature-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.4rem;
		height: 2.4rem;
		border-radius: 9px;
		background: color-mix(in srgb, var(--link) 12%, transparent);
		color: var(--link);
		margin-bottom: 0.95rem;
	}

	.feature-icon svg {
		width: 1.35rem;
		height: 1.35rem;
	}

	.feature-card h3 {
		font-size: 1.05rem;
		font-weight: 600;
		margin: 0 0 0.5rem;
	}

	.feature-card p {
		font-size: 0.9rem;
		color: var(--text-secondary);
		margin: 0;
		line-height: 1.5;
	}

	/* ── Comparison table ──────────────────────────────────────── */
	.compare {
		max-width: 1200px;
		margin: 0 auto;
		padding: 4rem 1.5rem;
		border-top: 1px solid var(--border-light);
	}

	.compare-table-wrap {
		overflow-x: auto;
		border: 1px solid var(--border);
		border-radius: 12px;
		background: var(--bg-secondary);
	}

	.compare-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
		min-width: 880px;
	}

	.compare-table thead th {
		text-align: left;
		padding: 1rem 0.9rem;
		font-weight: 600;
		color: var(--text-secondary);
		border-bottom: 1px solid var(--border);
		background: var(--bg-secondary);
		position: sticky;
		top: 0;
	}

	.compare-table th.flakey-col {
		color: var(--link);
		background: color-mix(in srgb, var(--link) 6%, var(--bg-secondary));
	}

	.compare-table .product-col {
		width: 13%;
		text-align: center;
	}

	.compare-table .feature-col {
		width: 35%;
	}

	.compare-table tbody tr {
		border-bottom: 1px solid var(--border-light);
	}

	.compare-table tbody tr:last-child {
		border-bottom: none;
	}

	.compare-table tbody td {
		padding: 1rem 0.9rem;
		vertical-align: top;
	}

	.feature-cell {
		background: var(--bg);
	}

	.feature-label {
		font-weight: 600;
		color: var(--text);
		margin-bottom: 0.25rem;
	}

	.feature-desc {
		font-size: 0.8rem;
		color: var(--text-muted);
		line-height: 1.45;
	}

	.cell {
		text-align: center;
		font-size: 0.82rem;
	}

	.cell.flakey-cell {
		background: color-mix(in srgb, var(--link) 4%, var(--bg-secondary));
	}

	.cell-mark {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		margin-bottom: 0.35rem;
	}

	.cell-mark svg {
		width: 1.05rem;
		height: 1.05rem;
	}

	.cell.yes .cell-mark {
		color: var(--color-pass);
	}

	.cell.partial .cell-mark {
		color: var(--color-skip);
	}

	.cell.no .cell-mark {
		color: var(--text-muted);
	}

	.cell-note {
		display: block;
		color: var(--text-muted);
		font-size: 0.75rem;
		line-height: 1.35;
	}

	.compare-footnote {
		font-size: 0.82rem;
		color: var(--text-muted);
		margin-top: 1rem;
		text-align: center;
	}

	.compare-footnote a {
		color: var(--link);
	}

	/* ── How it works ──────────────────────────────────────────── */
	.how {
		max-width: 1200px;
		margin: 0 auto;
		padding: 4rem 1.5rem;
		border-top: 1px solid var(--border-light);
	}

	.how-list {
		list-style: none;
		padding: 0;
		margin: 2rem 0 0;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
		gap: 1.25rem;
	}

	.how-list li {
		display: flex;
		gap: 1rem;
		padding: 1.5rem;
		border: 1px solid var(--border);
		border-radius: 12px;
		background: var(--bg-secondary);
	}

	.step-num {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.2rem;
		height: 2.2rem;
		border-radius: 50%;
		background: var(--link);
		color: #fff;
		font-weight: 700;
		font-size: 0.95rem;
		flex-shrink: 0;
	}

	.how-list h3 {
		font-size: 1.02rem;
		font-weight: 600;
		margin: 0 0 0.4rem;
	}

	.how-list p {
		font-size: 0.9rem;
		color: var(--text-secondary);
		line-height: 1.5;
		margin: 0;
	}

	.how-list code {
		font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
		background: var(--bg);
		padding: 0.1rem 0.35rem;
		border-radius: 4px;
		font-size: 0.88em;
		border: 1px solid var(--border-light);
	}

	/* ── CTA strip ─────────────────────────────────────────────── */
	.cta {
		max-width: 1200px;
		margin: 0 auto;
		padding: 4rem 1.5rem;
		border-top: 1px solid var(--border-light);
	}

	.cta-inner {
		text-align: center;
		max-width: 640px;
		margin: 0 auto;
	}

	.cta-inner h2 {
		font-size: 1.85rem;
		font-weight: 700;
		letter-spacing: -0.015em;
		margin: 0 0 0.75rem;
	}

	.cta-inner p {
		color: var(--text-secondary);
		font-size: 1rem;
		line-height: 1.55;
		margin: 0 0 1.75rem;
	}

	.cta-buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		justify-content: center;
	}

	/* ── Footer ────────────────────────────────────────────────── */
	.footer {
		border-top: 1px solid var(--border-light);
	}

	.footer-inner {
		max-width: 1200px;
		margin: 0 auto;
		padding: 1.5rem;
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.footer-inner a {
		color: var(--text-secondary);
		text-decoration: none;
	}

	.footer-inner a:hover {
		color: var(--text);
	}

	/* ── Responsive ────────────────────────────────────────────── */
	/* Below the hero-grid breakpoint, drop the product preview to a
	   single column so the copy gets full width. */
	@media (max-width: 900px) {
		.hero {
			grid-template-columns: 1fr;
			gap: 2.25rem;
			padding: 4rem 1.5rem 3.5rem;
		}

		.hero-inner {
			max-width: 720px;
		}

		.hero-preview {
			max-width: 480px;
		}
	}

	@media (max-width: 720px) {
		.topnav {
			display: none;
		}

		.nav-toggle {
			display: inline-flex;
		}

		.mobile-nav {
			display: flex;
		}

		.hero {
			padding: 2.5rem 1.5rem 3rem;
		}

		.hero-preview {
			display: none;
		}

		.footer-inner {
			flex-direction: column;
			gap: 0.5rem;
			text-align: center;
		}
	}

	/* ── Keyboard focus ────────────────────────────────────────────
	   The page restyles links and buttons, so the UA's default focus
	   ring is unreliable on them. Give every interactive element a
	   consistent, visible focus indicator for keyboard users. */
	.brand:focus-visible,
	.topnav a:focus-visible,
	.mobile-nav a:focus-visible,
	.btn:focus-visible,
	.compare-footnote a:focus-visible,
	.footer-inner a:focus-visible {
		outline: 2px solid var(--link);
		outline-offset: 2px;
		border-radius: 6px;
	}

	/* ── Reduced motion ────────────────────────────────────────────
	   Honour the OS "reduce motion" setting: drop the hover lift and
	   press transforms that this page adds for flourish. */
	@media (prefers-reduced-motion: reduce) {
		.btn,
		.feature-card,
		.nav-toggle,
		.topnav a {
			transition: none;
		}

		.btn:active,
		.feature-card:hover {
			transform: none;
		}
	}
</style>
