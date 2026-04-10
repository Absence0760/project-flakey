<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { authFetch } from '$lib/auth';

	const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

	interface ChecklistItem {
		id: number;
		label: string;
		required: boolean;
		checked: boolean;
		position: number;
		notes: string | null;
		checked_at: string | null;
		checked_by_email: string | null;
	}

	interface Release {
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
		items: ChecklistItem[];
	}

	const releaseId = $derived($page.params.id);

	let release = $state<Release | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let newItemLabel = $state('');
	let newItemRequired = $state(true);

	onMount(load);

	async function load() {
		loading = true;
		error = null;
		try {
			const res = await authFetch(`${API_URL}/releases/${releaseId}`);
			if (!res.ok) throw new Error('Failed to load release');
			release = await res.json();
		} catch (err) {
			error = (err as Error).message;
		} finally {
			loading = false;
		}
	}

	async function toggleItem(item: ChecklistItem) {
		await authFetch(`${API_URL}/releases/${releaseId}/items/${item.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ checked: !item.checked }),
		});
		await load();
	}

	async function addItem() {
		if (!newItemLabel.trim()) return;
		await authFetch(`${API_URL}/releases/${releaseId}/items`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ label: newItemLabel, required: newItemRequired }),
		});
		newItemLabel = '';
		newItemRequired = true;
		await load();
	}

	async function deleteItem(itemId: number) {
		await authFetch(`${API_URL}/releases/${releaseId}/items/${itemId}`, { method: 'DELETE' });
		await load();
	}

	async function signOff() {
		const res = await authFetch(`${API_URL}/releases/${releaseId}/sign-off`, { method: 'POST' });
		if (!res.ok) {
			const data = await res.json();
			alert(data.error ?? 'Sign-off failed');
			return;
		}
		await load();
	}

	async function changeStatus(status: string) {
		await authFetch(`${API_URL}/releases/${releaseId}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ status }),
		});
		await load();
	}

	const checked = $derived(release?.items.filter(i => i.checked).length ?? 0);
	const total = $derived(release?.items.length ?? 0);
	const requiredRemaining = $derived(release?.items.filter(i => i.required && !i.checked).length ?? 0);
</script>

<div class="page">
	<a href="/releases" class="back">← All releases</a>

	{#if loading}
		<p>Loading…</p>
	{:else if error}
		<p class="error">{error}</p>
	{:else if release}
		<header class="release-header">
			<div>
				<h1>{release.version}</h1>
				{#if release.name}<p class="name">{release.name}</p>{/if}
				{#if release.description}<p class="description">{release.description}</p>{/if}
			</div>
			<div class="header-side">
				<span class="status status-{release.status}">{release.status.replace('_', ' ')}</span>
				{#if release.target_date}
					<span class="target">Target {release.target_date}</span>
				{/if}
			</div>
		</header>

		<section>
			<div class="section-header">
				<h2>Checklist</h2>
				<span class="progress-text">{checked}/{total} complete · {requiredRemaining} required remaining</span>
			</div>
			<ul class="items">
				{#each release.items as item}
					<li class:checked={item.checked}>
						<label>
							<input type="checkbox" checked={item.checked} onchange={() => toggleItem(item)} />
							<span class="item-label">
								{item.label}
								{#if item.required}<span class="req">required</span>{/if}
							</span>
						</label>
						{#if item.checked && item.checked_by_email}
							<span class="checked-by">✓ {item.checked_by_email}</span>
						{/if}
						<button class="del" title="Remove" onclick={() => deleteItem(item.id)}>✕</button>
					</li>
				{/each}
			</ul>
			<div class="add-item">
				<input bind:value={newItemLabel} placeholder="Add checklist item…" />
				<label class="req-toggle">
					<input type="checkbox" bind:checked={newItemRequired} /> required
				</label>
				<button class="btn-primary" onclick={addItem}>Add</button>
			</div>
		</section>

		<section class="actions-section">
			<h2>Actions</h2>
			{#if release.signed_off_at}
				<p class="signed-off">
					✅ Signed off by <strong>{release.signed_off_by_email}</strong>
					on {new Date(release.signed_off_at).toLocaleString()}
				</p>
				<button class="btn-primary" onclick={() => changeStatus('released')} disabled={release.status === 'released'}>
					Mark released
				</button>
			{:else}
				<button class="btn-primary" onclick={signOff} disabled={requiredRemaining > 0}>
					Sign off release
				</button>
				{#if requiredRemaining > 0}
					<p class="hint">Complete all required checklist items to sign off.</p>
				{/if}
			{/if}
			<div class="status-actions">
				<label>Status:
					<select value={release.status} onchange={(e) => changeStatus((e.target as HTMLSelectElement).value)}>
						<option value="draft">Draft</option>
						<option value="in_progress">In progress</option>
						<option value="signed_off">Signed off</option>
						<option value="released">Released</option>
						<option value="cancelled">Cancelled</option>
					</select>
				</label>
			</div>
		</section>
	{/if}
</div>

<style>
	.page { max-width: 880px; margin: 0 auto; padding: 1.5rem; }
	.back { font-size: 0.85rem; color: var(--text-muted); text-decoration: none; }
	.back:hover { color: var(--text); }
	.release-header { display: flex; justify-content: space-between; align-items: flex-start; margin: 0.75rem 0 1.5rem; gap: 1rem; }
	.release-header h1 { margin: 0.25rem 0 0.5rem; }
	.name { color: var(--text-muted); margin: 0 0 0.5rem; }
	.description { color: var(--text-secondary); margin: 0; }
	.header-side { display: flex; flex-direction: column; gap: 0.5rem; align-items: flex-end; }
	.status { font-size: 0.7rem; padding: 0.2rem 0.6rem; border-radius: 4px; text-transform: uppercase; font-weight: 600; }
	.status-draft { background: #e5e7eb; color: #4b5563; }
	.status-in_progress { background: #dbeafe; color: #1e40af; }
	.status-signed_off { background: #dcfce7; color: #166534; }
	.status-released { background: #d1fae5; color: #065f46; }
	.status-cancelled { background: #fee2e2; color: #991b1b; }
	.target { font-size: 0.8rem; color: var(--text-muted); }
	section { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
	.section-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 0.75rem; }
	.section-header h2 { margin: 0; font-size: 1rem; }
	.progress-text { font-size: 0.78rem; color: var(--text-muted); }
	.items { list-style: none; padding: 0; margin: 0; }
	.items li { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0; border-bottom: 1px solid var(--border); }
	.items li:last-child { border-bottom: none; }
	.items label { display: flex; align-items: center; gap: 0.5rem; flex: 1; cursor: pointer; }
	.items li.checked .item-label { color: var(--text-muted); text-decoration: line-through; }
	.req { font-size: 0.65rem; padding: 0.1rem 0.4rem; background: #fee2e2; color: #991b1b; border-radius: 3px; margin-left: 0.4rem; text-transform: uppercase; font-weight: 600; }
	.checked-by { font-size: 0.72rem; color: #166534; }
	.del { background: transparent; border: none; color: var(--text-muted); cursor: pointer; padding: 0.2rem 0.4rem; }
	.del:hover { color: var(--text); }
	.add-item { display: flex; gap: 0.5rem; margin-top: 0.75rem; align-items: center; }
	.add-item input[type="text"], .add-item input:not([type]) { flex: 1; padding: 0.4rem 0.5rem; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); }
	.req-toggle { font-size: 0.8rem; color: var(--text-muted); display: flex; align-items: center; gap: 0.25rem; }
	.btn-primary { background: var(--link, #2563eb); color: #fff; border: none; padding: 0.45rem 0.9rem; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 0.85rem; }
	.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
	.actions-section h2 { margin-top: 0; font-size: 1rem; }
	.hint { font-size: 0.8rem; color: var(--text-muted); margin: 0.5rem 0 0; }
	.signed-off { color: #166534; margin: 0 0 0.75rem; }
	.status-actions { margin-top: 0.75rem; }
	.status-actions select { padding: 0.3rem 0.5rem; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); margin-left: 0.5rem; }
	.error { color: var(--color-fail, #dc2626); }
</style>
