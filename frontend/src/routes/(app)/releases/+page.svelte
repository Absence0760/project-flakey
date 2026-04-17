<script lang="ts">
	import { onMount } from 'svelte';
	import { authFetch } from '$lib/auth';

	const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

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

	let releases = $state<ReleaseSummary[]>([]);
	let loading = $state(true);
	let showCreate = $state(false);

	let newVersion = $state('');
	let newName = $state('');
	let newTargetDate = $state('');
	let newDescription = $state('');

	onMount(load);

	async function load() {
		loading = true;
		const res = await authFetch(`${API_URL}/releases`);
		releases = await res.json();
		loading = false;
	}

	async function createRelease() {
		if (!newVersion.trim()) return;
		const res = await authFetch(`${API_URL}/releases`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				version: newVersion,
				name: newName || null,
				target_date: newTargetDate || null,
				description: newDescription || null,
			}),
		});
		if (res.ok) {
			showCreate = false;
			newVersion = newName = newTargetDate = newDescription = '';
			await load();
		}
	}
</script>

<div class="page">
	<header class="page-header">
		<div>
			<h1>Releases</h1>
			<p class="subtitle">Track release checklists, required approvals, and sign-off.</p>
		</div>
		<button class="btn-primary" onclick={() => (showCreate = !showCreate)}>+ New release</button>
	</header>

	{#if showCreate}
		<section class="create-card">
			<h2>New release</h2>
			<label>Version <input bind:value={newVersion} placeholder="v1.2.0" /></label>
			<label>Name (optional) <input bind:value={newName} placeholder="February release" /></label>
			<label>Target date <input type="date" bind:value={newTargetDate} /></label>
			<label>Description <textarea bind:value={newDescription} rows="3"></textarea></label>
			<div class="actions">
				<button class="btn-primary" onclick={createRelease}>Create</button>
				<button class="btn-ghost" onclick={() => (showCreate = false)}>Cancel</button>
			</div>
		</section>
	{/if}

	{#if loading}
		<p>Loading…</p>
	{:else if releases.length === 0}
		<p class="empty">No releases yet. Create one to get started with a default sign-off checklist.</p>
	{:else}
		<div class="release-grid">
			{#each releases as r}
				<a class="release-card" href={`/releases/${r.id}`}>
					<div class="release-top">
						<span class="version">{r.version}</span>
						<span class="status status-{r.status}">{r.status.replace('_', ' ')}</span>
					</div>
					{#if r.name}
						<div class="name">{r.name}</div>
					{/if}
					<div class="progress-wrap">
						<div class="progress">
							<div class="progress-fill" style="width: {r.item_count > 0 ? (r.checked_count / r.item_count) * 100 : 0}%"></div>
						</div>
						<div class="progress-label">{r.checked_count}/{r.item_count} checklist items</div>
					</div>
					{#if r.required_remaining > 0}
						<div class="warn">{r.required_remaining} required item(s) remaining</div>
					{/if}
					{#if r.signed_off_at}
						<div class="signed">Signed off by {r.signed_off_by_email} · {new Date(r.signed_off_at).toLocaleDateString()}</div>
					{:else if r.target_date}
						<div class="target">Target: {r.target_date}</div>
					{/if}
				</a>
			{/each}
		</div>
	{/if}
</div>

<style>
	.page { max-width: 1440px; margin: 0 auto; padding: 1.5rem 2rem; }
	.page-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1.25rem; }
	.subtitle { color: var(--text-muted); font-size: 0.9rem; }
	.create-card { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin-bottom: 1.25rem; display: flex; flex-direction: column; gap: 0.5rem; }
	.create-card h2 { margin: 0 0 0.5rem; }
	.create-card label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.8rem; color: var(--text-muted); }
	.create-card input, .create-card textarea { padding: 0.4rem 0.5rem; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font-size: 0.88rem; }
	.actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
	.btn-primary { background: var(--link, #2563eb); color: #fff; border: none; padding: 0.45rem 0.9rem; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 0.85rem; }
	.btn-ghost { background: transparent; color: var(--text-muted); border: 1px solid var(--border); padding: 0.35rem 0.7rem; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
	.release-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 0.9rem; }
	.release-card { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 1rem; text-decoration: none; color: var(--text); display: flex; flex-direction: column; gap: 0.5rem; transition: border-color 0.15s; }
	.release-card:hover { border-color: var(--link, #2563eb); }
	.release-top { display: flex; justify-content: space-between; align-items: center; }
	.version { font-weight: 700; font-size: 1rem; }
	.status { font-size: 0.65rem; padding: 0.15rem 0.5rem; border-radius: 4px; text-transform: uppercase; font-weight: 600; }
	.status-draft { background: #e5e7eb; color: #4b5563; }
	.status-in_progress { background: #dbeafe; color: #1e40af; }
	.status-signed_off { background: #dcfce7; color: #166534; }
	.status-released { background: #d1fae5; color: #065f46; }
	.status-cancelled { background: #fee2e2; color: #991b1b; }
	.name { color: var(--text-muted); font-size: 0.85rem; }
	.progress-wrap { margin-top: 0.35rem; }
	.progress { background: var(--bg-secondary); border-radius: 4px; height: 6px; overflow: hidden; }
	.progress-fill { background: var(--link, #2563eb); height: 100%; transition: width 0.25s; }
	.progress-label { font-size: 0.72rem; color: var(--text-muted); margin-top: 0.25rem; }
	.warn { font-size: 0.75rem; color: #92400e; }
	.signed { font-size: 0.75rem; color: #166534; }
	.target { font-size: 0.75rem; color: var(--text-muted); }
	.empty { padding: 2rem; text-align: center; color: var(--text-muted); }
</style>
