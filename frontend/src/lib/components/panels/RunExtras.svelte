<script lang="ts">
	import { authFetch } from '$lib/stores/auth';
	import { API_URL } from '$lib/utils/config';
	import { artifactSrc } from '$lib/api';
	import { isHttpUrl } from '$lib/utils/safe-url';
	import { onMount } from 'svelte';

	interface Props { runId: number; }
	const { runId }: Props = $props();

	interface Coverage {
		lines_pct: string | number | null;
		branches_pct: string | number | null;
		functions_pct: string | number | null;
		statements_pct: string | number | null;
		lines_covered: number | null;
		lines_total: number | null;
	}
	interface A11yReport {
		id: number;
		url: string | null;
		score: string;
		violations_count: number;
		violations: Array<{ id: string; impact?: string; description?: string; help?: string; helpUrl?: string }>;
		critical_count: number;
		serious_count: number;
		moderate_count: number;
		minor_count: number;
	}
	interface VisualDiff {
		id: number;
		name: string;
		baseline_path: string | null;
		current_path: string | null;
		diff_path: string | null;
		diff_pct: string | null;
		status: string;
		reviewed_by_email: string | null;
	}

	type Tab = 'coverage' | 'a11y' | 'visual';

	let coverage = $state<Coverage | null>(null);
	let a11y = $state<A11yReport[]>([]);
	let visual = $state<VisualDiff[]>([]);
	let loaded = $state(false);
	let activeTab = $state<Tab>('coverage');

	const available = $derived({
		coverage: coverage !== null,
		a11y: a11y.length > 0,
		visual: visual.length > 0,
	});
	const anyAvailable = $derived(available.coverage || available.a11y || available.visual);

	onMount(load);

	async function load() {
		const [covRes, a11yRes, visRes] = await Promise.all([
			authFetch(`${API_URL}/coverage/runs/${runId}`).catch(() => null),
			authFetch(`${API_URL}/a11y/runs/${runId}`).catch(() => null),
			authFetch(`${API_URL}/visual/runs/${runId}`).catch(() => null),
		]);
		if (covRes?.ok) coverage = await covRes.json();
		if (a11yRes?.ok) a11y = await a11yRes.json();
		if (visRes?.ok) visual = await visRes.json();
		loaded = true;

		// Auto-pick the first available tab
		if (!available.coverage && available.a11y) activeTab = 'a11y';
		else if (!available.coverage && !available.a11y && available.visual) activeTab = 'visual';
	}

	async function updateVisualStatus(id: number, status: string) {
		const res = await authFetch(`${API_URL}/visual/${id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ status }),
		});
		if (res.ok) {
			visual = visual.map(v => (v.id === id ? { ...v, status } : v));
		}
	}

	function pct(v: string | number | null): string {
		if (v == null) return '—';
		const n = typeof v === 'string' ? parseFloat(v) : v;
		return `${n.toFixed(1)}%`;
	}
	function barClass(v: string | number | null): string {
		if (v == null) return '';
		const n = typeof v === 'string' ? parseFloat(v) : v;
		if (n >= 80) return 'good';
		if (n >= 60) return 'warn';
		return 'bad';
	}
	function resolveUrl(p: string | null): string {
		// Use the shared helper so the auth token is appended for the
		// auth+ownership check on /uploads/*.
		return artifactSrc(p);
	}
</script>

{#if loaded && anyAvailable}
	{@const a11yViolations = a11y[0]?.violations_count ?? 0}
	{@const visualPending = visual.filter(v => v.status === 'changed' || v.status === 'new').length}
	<div class="extras">
		<div class="extras-tabs">
			<div class="filter-tabs" role="tablist">
				{#if available.coverage}
					<button class="filter-tab" class:active={activeTab === 'coverage'} role="tab" onclick={() => (activeTab = 'coverage')}>
						Coverage
					</button>
				{/if}
				{#if available.a11y}
					<button class="filter-tab a11y" class:active={activeTab === 'a11y'} role="tab" onclick={() => (activeTab = 'a11y')}>
						Accessibility <span class="tab-count" class:bad={a11yViolations > 0}>{a11yViolations}</span>
					</button>
				{/if}
				{#if available.visual}
					<button class="filter-tab visual" class:active={activeTab === 'visual'} role="tab" onclick={() => (activeTab = 'visual')}>
						Visual <span class="tab-count" class:warn={visualPending > 0}>{visualPending}</span>
					</button>
				{/if}
			</div>
		</div>

		<div class="panel">
			{#if activeTab === 'coverage' && coverage}
				<div class="coverage-grid">
					{#each [['Lines', coverage.lines_pct], ['Branches', coverage.branches_pct], ['Functions', coverage.functions_pct], ['Statements', coverage.statements_pct]] as [label, val]}
						<div class="cov-metric">
							<div class="cov-label">{label}</div>
							<div class="cov-value">{pct(val as string | number | null)}</div>
							<div class="cov-bar">
								<div
									class="cov-fill {barClass(val as string | number | null)}"
									style="width: {val == null ? 0 : (typeof val === 'string' ? parseFloat(val) : val)}%"
								></div>
							</div>
						</div>
					{/each}
				</div>
				{#if coverage.lines_covered != null && coverage.lines_total != null}
					<p class="meta">{coverage.lines_covered.toLocaleString()} / {coverage.lines_total.toLocaleString()} lines covered</p>
				{/if}
			{:else if activeTab === 'a11y' && a11y.length > 0}
				{#each a11y as report}
					<div class="a11y-report">
						<div class="a11y-header">
							<div class="a11y-title">
								<span class="a11y-score">Score {parseFloat(report.score).toFixed(0)}</span>
								{#if report.url}<span class="a11y-url">{report.url}</span>{/if}
							</div>
							<div class="a11y-impacts">
								{#if report.critical_count > 0}<span class="impact critical">{report.critical_count} critical</span>{/if}
								{#if report.serious_count > 0}<span class="impact serious">{report.serious_count} serious</span>{/if}
								{#if report.moderate_count > 0}<span class="impact moderate">{report.moderate_count} moderate</span>{/if}
								{#if report.minor_count > 0}<span class="impact minor">{report.minor_count} minor</span>{/if}
							</div>
						</div>
						{#if report.violations?.length}
							<ul class="violations">
								{#each report.violations as v}
									<li>
										<span class="v-impact v-{v.impact ?? 'minor'}">{v.impact ?? 'minor'}</span>
										<span class="v-id">{v.id}</span>
										{#if v.description}<span class="v-desc">{v.description}</span>{/if}
										{#if isHttpUrl(v.helpUrl)}<a class="v-help" href={v.helpUrl} target="_blank" rel="noreferrer">learn</a>{/if}
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				{/each}
			{:else if activeTab === 'visual'}
				<div class="visual-grid">
					{#each visual as v}
						<div class="visual-card status-{v.status}">
							<div class="visual-top">
								<span class="visual-name">{v.name}</span>
								<span class="status status-{v.status}">{v.status}</span>
							</div>
							{#if v.diff_path}
								<img src={resolveUrl(v.diff_path)} alt={v.name} />
							{:else if v.current_path}
								<img src={resolveUrl(v.current_path)} alt={v.name} />
							{/if}
							<div class="visual-meta">
								{#if v.diff_pct}<span class="diff-pct">{parseFloat(v.diff_pct).toFixed(2)}% diff</span>{/if}
								{#if v.reviewed_by_email}<span class="reviewer" title={v.reviewed_by_email}>by {v.reviewed_by_email}</span>{/if}
							</div>
							{#if v.status !== 'approved' && v.status !== 'unchanged' && v.status !== 'rejected'}
								<div class="visual-actions">
									<button class="visual-action approve" onclick={() => updateVisualStatus(v.id, 'approved')}>Approve</button>
									<button class="visual-action reject" onclick={() => updateVisualStatus(v.id, 'rejected')}>Reject</button>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.extras {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 8px;
		margin: 0.75rem 0 1rem;
		overflow: hidden;
	}
	.extras-tabs {
		padding: 0.5rem 0.6rem;
		border-bottom: 1px solid var(--border);
		background: var(--bg-secondary);
	}
	/* Tab-count tints — match the /releases + / convention. The base
	   pill is muted; the tinted variants pop only when a count is
	   actionable (a11y violations, pending visual reviews). */
	.filter-tab.a11y .tab-count.bad {
		background: color-mix(in srgb, var(--color-fail) 18%, transparent);
		color: var(--color-fail);
	}
	.filter-tab.visual .tab-count.warn {
		background: color-mix(in srgb, var(--color-skip) 22%, transparent);
		color: var(--color-skip);
	}

	.panel { padding: 1rem; }

	.coverage-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
		gap: 0.75rem;
	}
	.cov-metric { display: flex; flex-direction: column; gap: 0.3rem; }
	.cov-label { font-size: 0.68rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
	.cov-value { font-size: 1.25rem; font-weight: 700; color: var(--text); }
	.cov-bar { height: 6px; background: var(--bg-secondary); border-radius: 3px; overflow: hidden; }
	.cov-fill { height: 100%; transition: width 0.25s; }
	.cov-fill.good { background: var(--color-pass); }
	.cov-fill.warn { background: var(--color-skip); }
	.cov-fill.bad { background: var(--color-fail); }
	.meta { font-size: 0.78rem; color: var(--text-muted); margin: 0.75rem 0 0; }

	.a11y-report { margin-bottom: 0.75rem; }
	.a11y-report:last-child { margin-bottom: 0; }
	.a11y-header {
		display: flex; justify-content: space-between; align-items: center;
		gap: 0.75rem; margin-bottom: 0.5rem; flex-wrap: wrap;
	}
	.a11y-title { display: flex; align-items: baseline; gap: 0.5rem; min-width: 0; }
	.a11y-score { font-size: 0.95rem; font-weight: 700; color: var(--text); }
	.a11y-url {
		font-size: 0.72rem; color: var(--text-secondary);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		padding: 0.1rem 0.4rem; border-radius: 3px; background: var(--bg-secondary);
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	.a11y-impacts { display: flex; gap: 0.35rem; flex-wrap: wrap; }
	.impact {
		font-size: 0.62rem; padding: 0.12rem 0.5rem; border-radius: 4px;
		font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
		white-space: nowrap;
	}
	.impact.critical { background: color-mix(in srgb, var(--color-fail) 18%, transparent); color: var(--color-fail); }
	.impact.serious  { background: color-mix(in srgb, var(--color-skip) 22%, transparent); color: var(--color-skip); }
	.impact.moderate { background: color-mix(in srgb, var(--link) 18%, transparent); color: var(--link); }
	.impact.minor    { background: var(--bg-secondary); color: var(--text-secondary); }

	.violations { list-style: none; padding: 0; margin: 0; border-top: 1px solid var(--border); }
	.violations li {
		padding: 0.5rem 0; border-bottom: 1px solid var(--border-light, var(--border));
		font-size: 0.82rem; display: flex; gap: 0.55rem; align-items: baseline;
	}
	.violations li:last-child { border-bottom: none; }
	.v-impact {
		font-size: 0.6rem; padding: 0.1rem 0.45rem; border-radius: 3px;
		font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
		flex-shrink: 0; min-width: 4.5rem; text-align: center;
	}
	.v-critical { background: color-mix(in srgb, var(--color-fail) 18%, transparent); color: var(--color-fail); }
	.v-serious  { background: color-mix(in srgb, var(--color-skip) 22%, transparent); color: var(--color-skip); }
	.v-moderate { background: color-mix(in srgb, var(--link) 18%, transparent); color: var(--link); }
	.v-minor    { background: var(--bg-secondary); color: var(--text-secondary); }
	.v-id {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-weight: 600; color: var(--text);
	}
	.v-desc { color: var(--text-secondary); }
	.v-desc::before { content: '— '; color: var(--text-muted); }
	.v-help {
		margin-left: auto; font-size: 0.72rem; color: var(--link);
		text-decoration: none; flex-shrink: 0;
	}
	.v-help:hover { text-decoration: underline; }

	.visual-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		gap: 0.75rem;
	}
	.visual-card {
		position: relative;
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.6rem 0.75rem 0.6rem 0.85rem;
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		background: var(--bg);
		overflow: hidden;
	}
	.visual-card::before {
		/* Status accent stripe — same convention as /releases cards. */
		content: ''; position: absolute; left: 0; top: 0; bottom: 0;
		width: 4px; background: var(--border);
	}
	.visual-card.status-unchanged::before { background: var(--border); }
	.visual-card.status-changed::before,
	.visual-card.status-new::before       { background: var(--color-skip); }
	.visual-card.status-approved::before  { background: var(--color-pass); }
	.visual-card.status-rejected::before  { background: var(--color-fail); }

	.visual-top {
		display: flex; justify-content: space-between;
		align-items: center; gap: 0.5rem; font-size: 0.82rem;
	}
	.visual-name {
		font-weight: 600; color: var(--text);
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
	}
	.status {
		font-size: 0.6rem; padding: 0.18rem 0.5rem; border-radius: 4px;
		text-transform: uppercase; font-weight: 700; letter-spacing: 0.04em;
		white-space: nowrap; flex-shrink: 0;
	}
	.status.status-unchanged { background: var(--bg-secondary); color: var(--text-secondary); }
	.status.status-changed,
	.status.status-new       { background: color-mix(in srgb, var(--color-skip) 22%, transparent); color: var(--color-skip); }
	.status.status-approved  { background: color-mix(in srgb, var(--color-pass) 18%, transparent); color: var(--color-pass); }
	.status.status-rejected  { background: color-mix(in srgb, var(--color-fail) 18%, transparent); color: var(--color-fail); }

	.visual-card img {
		width: 100%; height: auto; max-height: 180px;
		object-fit: cover; border-radius: 4px;
		background: var(--bg-secondary);
	}
	.visual-meta {
		display: flex; justify-content: space-between; gap: 0.5rem;
		font-size: 0.72rem; color: var(--text-muted);
	}
	.diff-pct { font-variant-numeric: tabular-nums; }
	.reviewer {
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		max-width: 60%;
	}

	.visual-actions { display: flex; gap: 0.4rem; margin-top: 0.1rem; }
	.visual-action {
		flex: 1; padding: 0.3rem 0.5rem; border-radius: 4px;
		cursor: pointer; font-size: 0.72rem; font-weight: 600;
		background: var(--bg); transition: background 0.15s, border-color 0.15s;
	}
	.visual-action.approve {
		border: 1px solid color-mix(in srgb, var(--color-pass) 45%, var(--border));
		color: var(--color-pass);
	}
	.visual-action.approve:hover {
		background: color-mix(in srgb, var(--color-pass) 12%, var(--bg));
	}
	.visual-action.reject {
		border: 1px solid color-mix(in srgb, var(--color-fail) 45%, var(--border));
		color: var(--color-fail);
	}
	.visual-action.reject:hover {
		background: color-mix(in srgb, var(--color-fail) 12%, var(--bg));
	}
</style>
