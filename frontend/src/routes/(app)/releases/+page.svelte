<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { replaceState } from '$app/navigation';
	import { authFetch } from '$lib/stores/auth';
	import { API_URL } from '$lib/utils/config';
	import { toast, toastError } from '$lib/stores/toast';

	interface ReleaseSummary {
		id: number;
		version: string;
		name: string | null;
		status: string;
		target_date: string | null;
		description: string | null;
		signed_off_at: string | null;
		signed_off_by_email: string | null;
		created_by_email: string | null;
		created_at: string;
		item_count: number;
		checked_count: number;
		required_remaining: number;
	}

	type StatusKey = 'all' | 'draft' | 'in_progress' | 'signed_off' | 'released' | 'cancelled';
	type SortKey = 'target' | 'updated' | 'progress' | 'version';

	let releases = $state<ReleaseSummary[]>([]);
	let loading = $state(true);
	let showCreate = $state(false);
	let error = $state<string | null>(null);

	let filterStatus = $state<StatusKey>('all');
	let sortBy = $state<SortKey>('target');
	let searchQuery = $state('');

	// URL state — same pattern as the other list pages so a release
	// view is bookmarkable.
	function syncUrl() {
		const url = new URL(window.location.href);
		const set = (k: string, v: string, def: string) => {
			if (v && v !== def) url.searchParams.set(k, v);
			else url.searchParams.delete(k);
		};
		set('status', filterStatus, 'all');
		set('sort', sortBy, 'target');
		set('q', searchQuery, '');
		replaceState(url, {});
	}
	function readUrl() {
		const p = $page.url.searchParams;
		filterStatus = (p.get('status') as StatusKey) ?? 'all';
		sortBy = (p.get('sort') as SortKey) ?? 'target';
		searchQuery = p.get('q') ?? '';
	}
	let mounted = $state(false);
	$effect(() => {
		filterStatus; sortBy; searchQuery; // tracked
		if (mounted) syncUrl();
	});

	// ── Date helpers ─────────────────────────────────────────────────
	// All dates render through one of these so we never leak raw ISO
	// strings into the UI.
	const DAY_MS = 86_400_000;
	function startOfDay(t: number): number {
		const d = new Date(t);
		d.setHours(0, 0, 0, 0);
		return d.getTime();
	}
	function daysUntil(iso: string): number {
		return Math.round((startOfDay(new Date(iso).getTime()) - startOfDay(Date.now())) / DAY_MS);
	}
	function relativeDate(iso: string): string {
		const d = daysUntil(iso);
		if (d === 0) return 'today';
		if (d === 1) return 'tomorrow';
		if (d === -1) return 'yesterday';
		if (d > 0 && d < 7) return `in ${d} days`;
		if (d < 0 && d > -7) return `${-d} days ago`;
		return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d < -300 || d > 300 ? 'numeric' : undefined });
	}
	function absoluteDate(iso: string): string {
		return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
	}

	// ── At-risk detection ────────────────────────────────────────────
	// A release is at risk when it's not yet signed off / shipped /
	// cancelled AND either:
	//   - its target is within 7 days AND it has required items left, OR
	//   - its target is already in the past (overdue)
	const OPEN_STATUSES = new Set(['draft', 'in_progress']);
	function riskLevel(r: ReleaseSummary): 'overdue' | 'imminent' | null {
		if (!OPEN_STATUSES.has(r.status)) return null;
		if (!r.target_date) return null;
		const d = daysUntil(r.target_date);
		if (d < 0) return 'overdue';
		if (d <= 7 && r.required_remaining > 0) return 'imminent';
		return null;
	}

	// ── Derived data ─────────────────────────────────────────────────
	const stats = $derived.by(() => {
		const total = releases.length;
		const open = releases.filter(r => OPEN_STATUSES.has(r.status)).length;
		const atRisk = releases.filter(r => riskLevel(r) !== null).length;
		const signedOff = releases.filter(r => r.status === 'signed_off' || r.status === 'released').length;
		return { total, open, atRisk, signedOff };
	});

	const statusCounts = $derived.by(() => {
		const out: Record<string, number> = { all: releases.length, draft: 0, in_progress: 0, signed_off: 0, released: 0, cancelled: 0 };
		for (const r of releases) out[r.status] = (out[r.status] ?? 0) + 1;
		return out;
	});

	const atRiskReleases = $derived(releases.filter(r => riskLevel(r) !== null));

	const filtered = $derived.by(() => {
		const q = searchQuery.trim().toLowerCase();
		return releases
			.filter(r => filterStatus === 'all' || r.status === filterStatus)
			.filter(r => {
				if (!q) return true;
				return r.version.toLowerCase().includes(q) || (r.name?.toLowerCase().includes(q) ?? false);
			})
			.sort((a, b) => {
				switch (sortBy) {
					case 'target': {
						// Releases with a target date first, ordered nearest-first
						// (overdue / soonest at the top); rest by created_at desc.
						const at = a.target_date ? new Date(a.target_date).getTime() : Infinity;
						const bt = b.target_date ? new Date(b.target_date).getTime() : Infinity;
						if (at !== bt) return at - bt;
						return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
					}
					case 'updated':
						return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
					case 'progress': {
						const pa = a.item_count > 0 ? a.checked_count / a.item_count : 0;
						const pb = b.item_count > 0 ? b.checked_count / b.item_count : 0;
						return pb - pa;
					}
					case 'version':
						return b.version.localeCompare(a.version, undefined, { numeric: true });
				}
			});
	});

	// Pagination — kicks in only above 50.
	const PAGE_SIZE = 50;
	let visibleCount = $state(PAGE_SIZE);
	const visibleReleases = $derived(filtered.slice(0, visibleCount));
	const hasMoreReleases = $derived(visibleReleases.length < filtered.length);
	$effect(() => { filterStatus; sortBy; searchQuery; visibleCount = PAGE_SIZE; });
	function loadMoreReleases() {
		visibleCount = Math.min(visibleCount + PAGE_SIZE, filtered.length);
	}

	// ── Create modal ─────────────────────────────────────────────────
	let newVersion = $state('');
	let newName = $state('');
	let newTargetDate = $state('');
	let newDescription = $state('');

	function openCreate() {
		newVersion = newName = newTargetDate = newDescription = '';
		showCreate = true;
	}
	function closeCreate() { showCreate = false; }
	function handleEsc(e: KeyboardEvent) {
		if (e.key === 'Escape' && showCreate) { closeCreate(); e.preventDefault(); }
	}

	onMount(async () => {
		readUrl();
		await load();
		mounted = true;
	});

	// Preserve pagination + scroll across back/forward navigation so
	// opening a release detail and hitting back doesn't drop the user
	// to page 1.
	export const snapshot = {
		capture: () => ({
			visibleCount,
			scrollY: typeof window !== "undefined" ? window.scrollY : 0,
		}),
		restore: (s: { visibleCount: number; scrollY: number }) => {
			visibleCount = s.visibleCount;
			queueMicrotask(() => window.scrollTo({ top: s.scrollY, behavior: "instant" as ScrollBehavior }));
		},
	};

	async function load() {
		loading = true;
		error = null;
		const res = await authFetch(`${API_URL}/releases`);
		if (!res.ok) {
			error = `Failed to load releases (${res.status})`;
			loading = false;
			return;
		}
		releases = await res.json();
		loading = false;
	}

	async function createRelease() {
		if (!newVersion.trim()) {
			toastError('Version is required');
			return;
		}
		let res: Response;
		try {
			res = await authFetch(`${API_URL}/releases`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					version: newVersion,
					name: newName || null,
					target_date: newTargetDate || null,
					description: newDescription || null,
				}),
			});
		} catch {
			toastError('Could not reach the server. Check your connection and try again.');
			return;
		}
		if (res.ok) {
			const createdVersion = newVersion;
			closeCreate();
			toast(`Release ${createdVersion} created`);
			await load();
			return;
		}
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		toastError(body?.error ?? `Failed to create release (${res.status})`);
	}

	function statusLabel(s: string): string { return s.replace('_', ' '); }

	function progressPct(r: ReleaseSummary): number {
		return r.item_count > 0 ? Math.round((r.checked_count / r.item_count) * 100) : 0;
	}

	const STATUS_TABS: { value: StatusKey; label: string }[] = [
		{ value: 'all', label: 'All' },
		{ value: 'in_progress', label: 'In progress' },
		{ value: 'draft', label: 'Draft' },
		{ value: 'signed_off', label: 'Signed off' },
		{ value: 'released', label: 'Released' },
		{ value: 'cancelled', label: 'Cancelled' },
	];
</script>

<svelte:window onkeydown={handleEsc} />

<div class="page">
	<!-- No <h1> — sidebar nav + URL already label the page. The action
	     button hangs on the right of the filter row instead of needing
	     its own header. -->
	<p class="subtitle">Track release checklists, required approvals, and sign-off.</p>

	{#if error}
		<p class="load-error">{error}</p>
	{/if}

	{#if !loading && atRiskReleases.length > 0}
		<!-- At-risk band — pinned at the top so the most time-sensitive
		     releases never get scrolled past. Overdue lands first; the
		     "imminent" group (target ≤ 7d + required items remaining)
		     follows. -->
		<section class="risk-band" aria-label="At-risk releases">
			<header class="risk-header">
				<span class="risk-icon" aria-hidden="true">⚠</span>
				<span class="risk-title">{atRiskReleases.length} release{atRiskReleases.length === 1 ? '' : 's'} {atRiskReleases.length === 1 ? 'needs' : 'need'} attention</span>
			</header>
			<div class="risk-list">
				{#each atRiskReleases as r}
					{@const lvl = riskLevel(r)}
					<a href={`/releases/${r.id}`} class="risk-item" class:overdue={lvl === 'overdue'}>
						<span class="risk-version">{r.version}</span>
						{#if r.name}<span class="risk-name" title={r.name}>{r.name}</span>{/if}
						<span class="risk-spacer"></span>
						{#if r.target_date}
							<span class="risk-target" title={absoluteDate(r.target_date)}>
								{lvl === 'overdue' ? '⏰' : '🎯'} {relativeDate(r.target_date)}
							</span>
						{/if}
						{#if r.required_remaining > 0}
							<span class="risk-required">{r.required_remaining} required left</span>
						{/if}
					</a>
				{/each}
			</div>
		</section>
	{/if}

	<!-- Summary strip — same pattern as /manual-tests. Each stat is a
	     compact tile; the at-risk tile is colored when non-zero. -->
	{#if !loading && releases.length > 0}
		<section class="summary">
			<div class="stat"><span class="stat-label">Total</span><span class="stat-value">{stats.total}</span></div>
			<div class="stat"><span class="stat-label">In progress + draft</span><span class="stat-value">{stats.open}</span></div>
			<div class="stat" class:risk={stats.atRisk > 0}><span class="stat-label">At risk</span><span class="stat-value">{stats.atRisk}</span></div>
			<div class="stat done"><span class="stat-label">Signed off / shipped</span><span class="stat-value">{stats.signedOff}</span></div>
		</section>
	{/if}

	<!-- Toolbar: status tabs (filter), sort dropdown, search, action -->
	<div class="toolbar">
		<div class="filter-tabs">
			{#each STATUS_TABS as tab}
				<button
					class="filter-tab"
					class:active={filterStatus === tab.value}
					onclick={() => filterStatus = tab.value}
				>
					{tab.label}
					<span class="tab-count">{statusCounts[tab.value] ?? 0}</span>
				</button>
			{/each}
		</div>

		<div class="toolbar-right">
			<div class="search-box">
				<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>
				<input type="text" placeholder="Search version or name…" bind:value={searchQuery} />
			</div>
			<select bind:value={sortBy} class="sort-select" aria-label="Sort by">
				<option value="target">Target date</option>
				<option value="updated">Recently created</option>
				<option value="progress">Progress</option>
				<option value="version">Version</option>
			</select>
			<button class="btn-primary" onclick={openCreate}>+ New release</button>
		</div>
	</div>

	{#if loading}
		<p class="muted">Loading…</p>
	{:else if releases.length === 0}
		<p class="empty">No releases yet. Create one to get started with a default sign-off checklist.</p>
	{:else if filtered.length === 0}
		<p class="empty">No releases match the current filters.</p>
	{:else}
		<div class="release-grid">
			{#each visibleReleases as r}
				{@const lvl = riskLevel(r)}
				<a class="release-card status-{r.status}" class:at-risk={lvl !== null} class:overdue={lvl === 'overdue'} href={`/releases/${r.id}`}>
					<header class="card-top">
						<div class="card-title">
							<span class="version">{r.version}</span>
							{#if r.name}<span class="name" title={r.name}>{r.name}</span>{/if}
						</div>
						<span class="status status-{r.status}">{statusLabel(r.status)}</span>
					</header>

					<div class="progress-row">
						<div class="progress" aria-label="{r.checked_count} of {r.item_count} checklist items">
							<div class="progress-fill" style="width: {progressPct(r)}%"></div>
						</div>
						<span class="progress-label">{r.checked_count}/{r.item_count} <span class="pct">·&nbsp;{progressPct(r)}%</span></span>
					</div>

					<footer class="card-bottom">
						{#if r.signed_off_at}
							<span class="signed" title={absoluteDate(r.signed_off_at)}>
								✓ Signed off {relativeDate(r.signed_off_at)}{r.signed_off_by_email ? ` · ${r.signed_off_by_email}` : ''}
							</span>
						{:else if r.target_date}
							<span class="target" class:risk-text={lvl !== null} title={absoluteDate(r.target_date)}>
								🎯 Target {relativeDate(r.target_date)}
							</span>
						{:else}
							<span class="target dim">No target date</span>
						{/if}
						{#if r.required_remaining > 0 && !r.signed_off_at}
							<span class="required-chip" title="Required checklist items still outstanding">{r.required_remaining} required left</span>
						{/if}
					</footer>
				</a>
			{/each}
		</div>
		{#if hasMoreReleases}
			<div class="load-more">
				<button class="load-more-btn" onclick={loadMoreReleases}>
					Load more ({filtered.length - visibleReleases.length} more)
				</button>
			</div>
		{/if}
	{/if}
</div>

<!-- Create modal (same overlay pattern as /manual-tests) -->
{#if showCreate}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="modal-overlay" onclick={closeCreate}>
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="modal" onclick={(e) => e.stopPropagation()}>
			<header class="modal-header">
				<h2>New release</h2>
				<button class="btn-ghost" onclick={closeCreate} aria-label="Close">✕</button>
			</header>
			<div class="modal-body">
				<label class="field"><span class="field-label">Version <span class="req">*</span></span><input bind:value={newVersion} placeholder="v1.2.0" /></label>
				<label class="field"><span class="field-label">Name</span><input bind:value={newName} placeholder="February release" /></label>
				<label class="field"><span class="field-label">Target date</span><input type="date" bind:value={newTargetDate} /></label>
				<label class="field"><span class="field-label">Description</span><textarea bind:value={newDescription} rows="3"></textarea></label>
			</div>
			<footer class="modal-footer">
				<button class="btn-ghost" onclick={closeCreate}>Cancel</button>
				<button class="btn-primary" onclick={createRelease} disabled={!newVersion.trim()}>Create release</button>
			</footer>
		</div>
	</div>
{/if}

<style>
	.page { max-width: 1920px; margin: 0 auto; padding: 1.5rem 2rem; }
	.subtitle { color: var(--text-muted); font-size: 0.9rem; margin: 0 0 1rem; }

	.load-error {
		padding: 0.65rem; background: var(--error-bg, #fee2e2);
		border: 1px solid var(--error-border, #fca5a5);
		border-radius: 6px; color: var(--error-text, #991b1b);
		font-size: 0.85rem; margin-bottom: 1rem;
	}

	/* ── At-risk band ──────────────────────────────────────────────── */
	.risk-band {
		background: color-mix(in srgb, var(--color-fail) 6%, var(--bg));
		border: 1px solid color-mix(in srgb, var(--color-fail) 35%, var(--border));
		border-left: 4px solid var(--color-fail);
		border-radius: 8px;
		padding: 0.75rem 1rem;
		margin-bottom: 1rem;
		display: flex; flex-direction: column; gap: 0.5rem;
	}
	.risk-header { display: flex; align-items: center; gap: 0.5rem; }
	.risk-icon { font-size: 1rem; }
	.risk-title { font-weight: 600; font-size: 0.85rem; color: var(--text); }
	.risk-list { display: flex; flex-direction: column; gap: 0.35rem; }
	.risk-item {
		display: flex; align-items: center; gap: 0.65rem;
		padding: 0.45rem 0.65rem;
		background: var(--bg); border: 1px solid var(--border);
		border-radius: 6px; text-decoration: none; color: var(--text);
		font-size: 0.82rem;
		transition: border-color 0.1s;
	}
	.risk-item:hover { border-color: var(--color-fail); background: color-mix(in srgb, var(--color-fail) 4%, var(--bg)); }
	.risk-item.overdue { border-left: 3px solid var(--color-fail); }
	.risk-version { font-weight: 700; font-family: monospace; }
	.risk-name { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 280px; }
	.risk-spacer { flex: 1; }
	.risk-target { font-size: 0.78rem; color: var(--text-secondary); }
	.risk-item.overdue .risk-target { color: var(--color-fail); font-weight: 600; }
	.risk-required {
		font-size: 0.7rem; font-weight: 600;
		padding: 0.1rem 0.45rem; border-radius: 10px;
		background: color-mix(in srgb, var(--color-fail) 15%, transparent);
		color: var(--color-fail);
	}

	/* ── Summary tiles ─────────────────────────────────────────────── */
	.summary { display: flex; gap: 0.75rem; margin-bottom: 1rem; }
	.stat {
		flex: 1; background: var(--bg); border: 1px solid var(--border);
		border-radius: 8px; padding: 0.6rem 0.9rem;
		display: flex; flex-direction: column; gap: 0.15rem;
	}
	.stat-label { font-size: 0.68rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
	.stat-value { font-size: 1.35rem; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; }
	.stat.risk {
		border-color: color-mix(in srgb, var(--color-fail) 35%, var(--border));
		background: color-mix(in srgb, var(--color-fail) 6%, var(--bg));
	}
	.stat.risk .stat-value { color: var(--color-fail); }
	.stat.done .stat-value { color: var(--color-pass); }

	/* ── Toolbar ───────────────────────────────────────────────────── */
	.toolbar {
		display: flex; justify-content: space-between; align-items: center;
		gap: 0.75rem; margin-bottom: 1rem; flex-wrap: wrap;
	}
	/* .filter-tabs / .filter-tab live in src/app.css */
	.tab-count {
		display: inline-block; margin-left: 0.3rem;
		padding: 0.05rem 0.4rem; border-radius: 8px;
		background: var(--bg-hover, var(--bg-secondary));
		color: var(--text-secondary);
		font-size: 0.68rem; font-weight: 600; line-height: 1.4;
	}
	.toolbar-right { display: flex; gap: 0.4rem; align-items: center; }
	.search-box {
		display: flex; align-items: center; gap: 0.4rem;
		padding: 0.35rem 0.6rem; border: 1px solid var(--border); border-radius: 6px;
		background: var(--bg); color: var(--text-muted);
	}
	.search-box:focus-within { border-color: var(--link); }
	.search-box input {
		border: none; background: transparent; outline: none;
		font-size: 0.8rem; color: var(--text); width: 180px;
	}
	.search-box input::placeholder { color: var(--text-muted); }
	.sort-select {
		padding: 0.4rem 0.65rem; border: 1px solid var(--border); border-radius: 6px;
		background: var(--bg); color: var(--text); font-size: 0.82rem;
		font-family: inherit;
	}
	.btn-primary {
		background: var(--link, #2563eb); color: #fff; border: 1px solid var(--link);
		padding: 0.45rem 0.9rem; border-radius: 6px; cursor: pointer;
		font-weight: 600; font-size: 0.85rem; line-height: 1.2;
	}
	.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-ghost {
		background: transparent; color: var(--text-muted); border: 1px solid var(--border);
		padding: 0.45rem 0.9rem; border-radius: 6px; cursor: pointer; font-size: 0.85rem; line-height: 1.2;
	}

	/* ── Release grid ──────────────────────────────────────────────── */
	.release-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
		gap: 0.85rem;
	}
	.release-card {
		position: relative;
		background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
		padding: 0.85rem 1rem 0.75rem 1.15rem;
		text-decoration: none; color: var(--text);
		display: flex; flex-direction: column; gap: 0.55rem;
		transition: border-color 0.15s, transform 0.1s;
		overflow: hidden;
	}
	.release-card::before {
		/* Status accent stripe on the left edge — same colour family
		   as the status badge so the card reads top-to-bottom as a
		   single coherent block. */
		content: ''; position: absolute; left: 0; top: 0; bottom: 0;
		width: 4px; background: var(--border);
	}
	.release-card.status-draft::before        { background: #9ca3af; }
	.release-card.status-in_progress::before  { background: var(--link, #2563eb); }
	.release-card.status-signed_off::before   { background: var(--color-pass, #16a34a); }
	.release-card.status-released::before     { background: #059669; }
	.release-card.status-cancelled::before    { background: var(--color-fail, #dc2626); }
	.release-card.at-risk::before             { background: var(--color-fail); }
	.release-card:hover {
		border-color: var(--link);
		transform: translateY(-1px);
	}
	.release-card.at-risk {
		border-color: color-mix(in srgb, var(--color-fail) 45%, var(--border));
		background: color-mix(in srgb, var(--color-fail) 3%, var(--bg));
	}

	.card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.5rem; }
	.card-title { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
	.version { font-weight: 700; font-size: 1.05rem; font-family: monospace; }
	.name { color: var(--text-muted); font-size: 0.82rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

	.status {
		font-size: 0.62rem; padding: 0.18rem 0.55rem; border-radius: 4px;
		text-transform: uppercase; font-weight: 700; letter-spacing: 0.04em;
		white-space: nowrap; flex-shrink: 0;
	}
	/* Status badges — color-mix against the page background so the
	   pale fills auto-adapt to dark mode instead of reading as
	   glowing patches against a dark backdrop. */
	.status-draft        { background: color-mix(in srgb, var(--text-muted) 18%, transparent); color: var(--text-secondary); }
	.status-in_progress  { background: color-mix(in srgb, var(--link) 18%, transparent); color: var(--link); }
	.status-signed_off   { background: color-mix(in srgb, var(--color-pass) 18%, transparent); color: var(--color-pass); }
	.status-released     { background: color-mix(in srgb, var(--color-pass) 22%, transparent); color: var(--color-pass); }
	.status-cancelled    { background: color-mix(in srgb, var(--color-fail) 18%, transparent); color: var(--color-fail); }

	.progress-row { display: flex; flex-direction: column; gap: 0.25rem; }
	.progress {
		background: var(--bg-secondary); border-radius: 4px; height: 6px;
		overflow: hidden;
	}
	.progress-fill {
		background: var(--link, #2563eb); height: 100%; transition: width 0.25s;
	}
	.release-card.status-signed_off .progress-fill,
	.release-card.status-released   .progress-fill { background: var(--color-pass); }
	.release-card.at-risk           .progress-fill { background: var(--color-fail); }
	.progress-label { font-size: 0.72rem; color: var(--text-muted); display: flex; gap: 0.35rem; align-items: baseline; }
	.pct { font-variant-numeric: tabular-nums; }

	.card-bottom {
		display: flex; align-items: center; gap: 0.5rem;
		font-size: 0.75rem; color: var(--text-muted); margin-top: auto;
		padding-top: 0.25rem;
		flex-wrap: wrap;
	}
	.signed { color: var(--color-pass); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.target { color: var(--text-secondary); flex: 1; min-width: 0; }
	.target.dim { color: var(--text-muted); }
	.target.risk-text { color: var(--color-fail); font-weight: 600; }
	.required-chip {
		font-size: 0.68rem; font-weight: 600;
		padding: 0.1rem 0.45rem; border-radius: 10px;
		background: color-mix(in srgb, var(--color-fail) 14%, transparent);
		color: var(--color-fail);
		flex-shrink: 0;
	}

	.empty, .muted { padding: 2rem; text-align: center; color: var(--text-muted); }

	/* ── Create modal ──────────────────────────────────────────────── */
	.modal-overlay {
		position: fixed; inset: 0; background: rgba(0,0,0,0.4);
		display: flex; align-items: center; justify-content: center; z-index: 300;
	}
	.modal {
		background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
		width: min(560px, 95vw); max-height: 92vh; overflow-y: auto;
		display: flex; flex-direction: column;
	}
	.modal-header {
		display: flex; justify-content: space-between; align-items: center;
		padding: 0.85rem 1.1rem; border-bottom: 1px solid var(--border);
	}
	.modal-header h2 { margin: 0; font-size: 1.05rem; }
	.modal-body { padding: 1rem 1.1rem; display: flex; flex-direction: column; gap: 0.65rem; }
	.modal-footer {
		display: flex; justify-content: flex-end; gap: 0.5rem;
		padding: 0.75rem 1.1rem; border-top: 1px solid var(--border);
		background: var(--bg-secondary);
	}
	.field { display: flex; flex-direction: column; gap: 0.25rem; }
	.field-label { font-size: 0.75rem; color: var(--text-muted); font-weight: 500; }
	.req { color: var(--color-fail, #dc2626); }
	.field input, .field textarea {
		padding: 0.45rem 0.6rem; border: 1px solid var(--border); border-radius: 6px;
		background: var(--bg); color: var(--text); font-size: 0.88rem; font-family: inherit;
	}
	.field textarea { resize: vertical; min-height: 4rem; }
</style>
