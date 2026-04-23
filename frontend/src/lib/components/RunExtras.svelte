<script lang="ts">
	import { authFetch } from '$lib/auth';
	import { API_URL } from '$lib/config';
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
		if (!p) return '';
		if (p.startsWith('http')) return p;
		return `${API_URL}/uploads/${p}`;
	}
</script>

{#if loaded && anyAvailable}
	<div class="extras">
		<div class="tabs">
			{#if available.coverage}
				<button class="tab" class:active={activeTab === 'coverage'} onclick={() => (activeTab = 'coverage')}>
					Coverage
				</button>
			{/if}
			{#if available.a11y}
				<button class="tab" class:active={activeTab === 'a11y'} onclick={() => (activeTab = 'a11y')}>
					Accessibility <span class="badge">{a11y[0]?.violations_count ?? 0}</span>
				</button>
			{/if}
			{#if available.visual}
				<button class="tab" class:active={activeTab === 'visual'} onclick={() => (activeTab = 'visual')}>
					Visual <span class="badge">{visual.filter(v => v.status !== 'unchanged').length}</span>
				</button>
			{/if}
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
							<div>
								<span class="a11y-score">Score: {parseFloat(report.score).toFixed(0)}</span>
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
										{#if v.description}<span class="v-desc">— {v.description}</span>{/if}
										{#if v.helpUrl}<a class="v-help" href={v.helpUrl} target="_blank" rel="noreferrer">learn</a>{/if}
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
								<span class="visual-status">{v.status}</span>
							</div>
							{#if v.diff_path}
								<img src={resolveUrl(v.diff_path)} alt={v.name} />
							{:else if v.current_path}
								<img src={resolveUrl(v.current_path)} alt={v.name} />
							{/if}
							<div class="visual-meta">
								{#if v.diff_pct}<span>{parseFloat(v.diff_pct).toFixed(2)}% diff</span>{/if}
							</div>
							{#if v.status !== 'approved' && v.status !== 'unchanged'}
								<div class="visual-actions">
									<button class="btn-approve" onclick={() => updateVisualStatus(v.id, 'approved')}>Approve</button>
									<button class="btn-reject" onclick={() => updateVisualStatus(v.id, 'rejected')}>Reject</button>
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
	.tabs {
		display: flex;
		border-bottom: 1px solid var(--border);
		background: var(--bg-secondary);
	}
	.tab {
		padding: 0.6rem 1rem;
		background: transparent;
		border: none;
		border-bottom: 2px solid transparent;
		color: var(--text-muted);
		font-size: 0.85rem;
		cursor: pointer;
	}
	.tab.active {
		color: var(--text);
		border-bottom-color: var(--link, #2563eb);
		font-weight: 600;
	}
	.badge {
		background: var(--bg);
		border-radius: 10px;
		padding: 0.08rem 0.45rem;
		font-size: 0.7rem;
		margin-left: 0.3rem;
	}
	.panel { padding: 1rem; }

	.coverage-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
		gap: 0.75rem;
	}
	.cov-metric { display: flex; flex-direction: column; gap: 0.3rem; }
	.cov-label { font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
	.cov-value { font-size: 1.25rem; font-weight: 700; color: var(--text); }
	.cov-bar { height: 6px; background: var(--bg-secondary); border-radius: 3px; overflow: hidden; }
	.cov-fill { height: 100%; transition: width 0.25s; }
	.cov-fill.good { background: #16a34a; }
	.cov-fill.warn { background: #f59e0b; }
	.cov-fill.bad { background: #dc2626; }
	.meta { font-size: 0.78rem; color: var(--text-muted); margin: 0.75rem 0 0; }

	.a11y-report { margin-bottom: 0.75rem; }
	.a11y-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
	.a11y-score { font-size: 1rem; font-weight: 700; margin-right: 0.5rem; }
	.a11y-url { font-size: 0.78rem; color: var(--text-muted); font-family: monospace; }
	.a11y-impacts { display: flex; gap: 0.35rem; }
	.impact { font-size: 0.65rem; padding: 0.1rem 0.45rem; border-radius: 4px; font-weight: 600; text-transform: uppercase; }
	.impact.critical { background: #fee2e2; color: #991b1b; }
	.impact.serious  { background: #fef3c7; color: #92400e; }
	.impact.moderate { background: #dbeafe; color: #1e40af; }
	.impact.minor    { background: #e5e7eb; color: #4b5563; }
	.violations { list-style: none; padding: 0; margin: 0; border-top: 1px solid var(--border); }
	.violations li { padding: 0.4rem 0; border-bottom: 1px solid var(--border); font-size: 0.82rem; display: flex; gap: 0.5rem; align-items: baseline; }
	.violations li:last-child { border-bottom: none; }
	.v-impact { font-size: 0.62rem; padding: 0.06rem 0.4rem; border-radius: 3px; font-weight: 600; text-transform: uppercase; flex-shrink: 0; }
	.v-critical { background: #fee2e2; color: #991b1b; }
	.v-serious  { background: #fef3c7; color: #92400e; }
	.v-moderate { background: #dbeafe; color: #1e40af; }
	.v-minor    { background: #e5e7eb; color: #4b5563; }
	.v-id { font-family: monospace; font-weight: 600; }
	.v-desc { color: var(--text-muted); }
	.v-help { margin-left: auto; font-size: 0.72rem; color: var(--link, #2563eb); text-decoration: none; }

	.visual-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 0.75rem; }
	.visual-card {
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.6rem;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		background: var(--bg);
	}
	.visual-card.status-changed, .visual-card.status-new { border-color: #f59e0b; }
	.visual-card.status-approved { border-color: #16a34a; }
	.visual-card.status-rejected { border-color: #dc2626; }
	.visual-top { display: flex; justify-content: space-between; align-items: center; font-size: 0.82rem; }
	.visual-name { font-weight: 600; }
	.visual-status { text-transform: uppercase; font-size: 0.65rem; color: var(--text-muted); font-weight: 600; }
	.visual-card img { width: 100%; height: auto; max-height: 180px; object-fit: cover; border-radius: 4px; background: #f3f4f6; }
	.visual-meta { font-size: 0.72rem; color: var(--text-muted); }
	.visual-actions { display: flex; gap: 0.4rem; }
	.visual-actions button { flex: 1; padding: 0.3rem; border: none; border-radius: 4px; cursor: pointer; font-size: 0.75rem; font-weight: 600; }
	.btn-approve { background: #16a34a; color: #fff; }
	.btn-reject { background: #dc2626; color: #fff; }
</style>
