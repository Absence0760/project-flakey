<script lang="ts">
	import { onMount } from 'svelte';
	import { authFetch } from '$lib/auth';

	const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

	interface ManualTest {
		id: number;
		suite_name: string | null;
		title: string;
		description: string | null;
		priority: 'low' | 'medium' | 'high' | 'critical';
		status: 'not_run' | 'passed' | 'failed' | 'blocked' | 'skipped';
		last_run_at: string | null;
		last_run_notes: string | null;
		last_run_by_email: string | null;
		automated_test_key: string | null;
		tags: string[];
		created_at: string;
	}

	interface ManualTestDetail extends ManualTest {
		steps: Array<string | { action: string; expected?: string }>;
		expected_result: string | null;
	}

	interface Summary { total: number; passed: number; failed: number; blocked: number; skipped: number; not_run: number; }

	let tests = $state<ManualTest[]>([]);
	let summary = $state<Summary | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let filterStatus = $state<string>('');

	let showCreate = $state(false);
	let newTitle = $state('');
	let newSuite = $state('');
	let newDescription = $state('');
	let newPriority = $state<'low' | 'medium' | 'high' | 'critical'>('medium');
	let newStepsText = $state('');
	let newExpected = $state('');
	let newAutomatedKey = $state('');

	let selected = $state<ManualTestDetail | null>(null);
	let runStatus = $state<'passed' | 'failed' | 'blocked' | 'skipped'>('passed');
	let runNotes = $state('');

	onMount(load);

	async function load() {
		loading = true;
		try {
			const [listRes, sumRes] = await Promise.all([
				authFetch(`${API_URL}/manual-tests${filterStatus ? `?status=${filterStatus}` : ''}`),
				authFetch(`${API_URL}/manual-tests/summary`),
			]);
			tests = await listRes.json();
			summary = await sumRes.json();
		} catch (err) {
			error = (err as Error).message;
		} finally {
			loading = false;
		}
	}

	async function createTest() {
		if (!newTitle.trim()) return;
		const steps = newStepsText
			.split('\n')
			.map(s => s.trim())
			.filter(Boolean)
			.map(s => ({ action: s }));
		const res = await authFetch(`${API_URL}/manual-tests`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: newTitle,
				suite_name: newSuite || null,
				description: newDescription || null,
				priority: newPriority,
				steps,
				expected_result: newExpected || null,
				automated_test_key: newAutomatedKey || null,
			}),
		});
		if (res.ok) {
			showCreate = false;
			newTitle = '';
			newSuite = '';
			newDescription = '';
			newStepsText = '';
			newExpected = '';
			newAutomatedKey = '';
			await load();
		}
	}

	async function openTest(id: number) {
		const res = await authFetch(`${API_URL}/manual-tests/${id}`);
		if (res.ok) {
			selected = await res.json();
			runStatus = 'passed';
			runNotes = '';
		}
	}

	async function recordResult() {
		if (!selected) return;
		const res = await authFetch(`${API_URL}/manual-tests/${selected.id}/result`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: runStatus, notes: runNotes }),
		});
		if (res.ok) {
			selected = null;
			await load();
		}
	}

	async function deleteTest(id: number) {
		if (!confirm('Delete this manual test?')) return;
		await authFetch(`${API_URL}/manual-tests/${id}`, { method: 'DELETE' });
		if (selected?.id === id) selected = null;
		await load();
	}

	function statusClass(s: string) {
		return `status status-${s.replace('_', '-')}`;
	}
</script>

<div class="page">
	<header class="page-header">
		<div>
			<h1>Manual tests</h1>
			<p class="subtitle">Manage and execute manual regression tests alongside your automated suite.</p>
		</div>
		<button class="btn-primary" onclick={() => (showCreate = !showCreate)}>+ New test</button>
	</header>

	{#if summary}
		<section class="summary">
			<div class="stat"><span class="stat-label">Total</span><span class="stat-value">{summary.total}</span></div>
			<div class="stat pass"><span class="stat-label">Passed</span><span class="stat-value">{summary.passed}</span></div>
			<div class="stat fail"><span class="stat-label">Failed</span><span class="stat-value">{summary.failed}</span></div>
			<div class="stat"><span class="stat-label">Blocked</span><span class="stat-value">{summary.blocked}</span></div>
			<div class="stat"><span class="stat-label">Not run</span><span class="stat-value">{summary.not_run}</span></div>
		</section>
	{/if}

	{#if showCreate}
		<section class="create-card">
			<h2>New manual test</h2>
			<label>Title <input bind:value={newTitle} placeholder="e.g. Checkout flow with expired card" /></label>
			<label>Suite <input bind:value={newSuite} placeholder="regression" /></label>
			<label>Description <textarea bind:value={newDescription} rows="2"></textarea></label>
			<label>Priority
				<select bind:value={newPriority}>
					<option value="low">Low</option>
					<option value="medium">Medium</option>
					<option value="high">High</option>
					<option value="critical">Critical</option>
				</select>
			</label>
			<label>Steps (one per line) <textarea bind:value={newStepsText} rows="4" placeholder="Navigate to /checkout&#10;Enter expired card&#10;Submit"></textarea></label>
			<label>Expected result <textarea bind:value={newExpected} rows="2"></textarea></label>
			<label>Linked automated test key (optional) <input bind:value={newAutomatedKey} placeholder="checkout > handles expired cards" /></label>
			<div class="actions">
				<button class="btn-primary" onclick={createTest}>Create</button>
				<button class="btn-ghost" onclick={() => (showCreate = false)}>Cancel</button>
			</div>
		</section>
	{/if}

	<div class="filter-bar">
		<label>
			Status filter:
			<select bind:value={filterStatus} onchange={load}>
				<option value="">All</option>
				<option value="not_run">Not run</option>
				<option value="passed">Passed</option>
				<option value="failed">Failed</option>
				<option value="blocked">Blocked</option>
				<option value="skipped">Skipped</option>
			</select>
		</label>
	</div>

	{#if loading}
		<p>Loading…</p>
	{:else if error}
		<p class="error">{error}</p>
	{:else if tests.length === 0}
		<p class="empty">No manual tests yet.</p>
	{:else}
		<table class="tests">
			<thead>
				<tr>
					<th>Title</th>
					<th>Suite</th>
					<th>Priority</th>
					<th>Status</th>
					<th>Last run</th>
					<th></th>
				</tr>
			</thead>
			<tbody>
				{#each tests as t}
					<tr>
						<td>
							<!-- svelte-ignore a11y_invalid_attribute -->
							<a href="#" onclick={(e) => { e.preventDefault(); openTest(t.id); }}>{t.title}</a>
						</td>
						<td>{t.suite_name ?? '—'}</td>
						<td><span class="priority priority-{t.priority}">{t.priority}</span></td>
						<td><span class={statusClass(t.status)}>{t.status.replace('_', ' ')}</span></td>
						<td>{t.last_run_at ? new Date(t.last_run_at).toLocaleString() : '—'}</td>
						<td><button class="btn-ghost" onclick={() => deleteTest(t.id)}>✕</button></td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}

	{#if selected}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="modal-overlay" onclick={() => (selected = null)}>
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="modal" onclick={(e) => e.stopPropagation()}>
				<header>
					<h2>{selected.title}</h2>
					<button class="btn-ghost" onclick={() => (selected = null)}>✕</button>
				</header>
				{#if selected.description}
					<p>{selected.description}</p>
				{/if}
				{#if selected.steps?.length}
					<h3>Steps</h3>
					<ol class="steps">
						{#each selected.steps as step}
							<li>{typeof step === 'string' ? step : step.action}</li>
						{/each}
					</ol>
				{/if}
				{#if selected.expected_result}
					<h3>Expected</h3>
					<p>{selected.expected_result}</p>
				{/if}
				{#if selected.last_run_at}
					<p class="dim">
						Last run: <span class={statusClass(selected.status)}>{selected.status.replace('_', ' ')}</span>
						by {selected.last_run_by_email ?? '—'} at {new Date(selected.last_run_at).toLocaleString()}
					</p>
				{/if}

				<h3>Record result</h3>
				<label>Status
					<select bind:value={runStatus}>
						<option value="passed">Passed</option>
						<option value="failed">Failed</option>
						<option value="blocked">Blocked</option>
						<option value="skipped">Skipped</option>
					</select>
				</label>
				<label>Notes <textarea bind:value={runNotes} rows="3"></textarea></label>
				<div class="actions">
					<button class="btn-primary" onclick={recordResult}>Save result</button>
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.page { max-width: 1000px; margin: 0 auto; padding: 1.5rem; }
	.page-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1.25rem; }
	.subtitle { color: var(--text-muted); font-size: 0.9rem; }
	.summary { display: flex; gap: 0.75rem; margin-bottom: 1.25rem; }
	.stat { flex: 1; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem 1rem; display: flex; flex-direction: column; }
	.stat-label { font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
	.stat-value { font-size: 1.4rem; font-weight: 700; color: var(--text); }
	.stat.pass .stat-value { color: var(--color-pass, #16a34a); }
	.stat.fail .stat-value { color: var(--color-fail, #dc2626); }
	.create-card { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin-bottom: 1.25rem; display: flex; flex-direction: column; gap: 0.5rem; }
	.create-card h2 { margin: 0 0 0.5rem; font-size: 1.1rem; }
	.create-card label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.8rem; color: var(--text-muted); }
	.create-card input, .create-card textarea, .create-card select { padding: 0.4rem 0.5rem; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font-size: 0.88rem; }
	.actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
	.btn-primary { background: var(--link, #2563eb); color: #fff; border: none; padding: 0.45rem 0.9rem; border-radius: 6px; cursor: pointer; font-size: 0.85rem; font-weight: 600; }
	.btn-ghost { background: transparent; color: var(--text-muted); border: 1px solid var(--border); padding: 0.35rem 0.7rem; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
	.filter-bar { margin-bottom: 0.75rem; }
	.filter-bar select { padding: 0.3rem 0.5rem; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); }
	table.tests { width: 100%; border-collapse: collapse; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
	table.tests th, table.tests td { padding: 0.55rem 0.75rem; text-align: left; font-size: 0.85rem; border-bottom: 1px solid var(--border); }
	table.tests th { background: var(--bg-secondary); color: var(--text-muted); font-weight: 600; text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.04em; }
	.priority { font-size: 0.7rem; padding: 0.1rem 0.4rem; border-radius: 4px; text-transform: uppercase; font-weight: 600; }
	.priority-low { background: #e5e7eb; color: #4b5563; }
	.priority-medium { background: #dbeafe; color: #1e40af; }
	.priority-high { background: #fef3c7; color: #92400e; }
	.priority-critical { background: #fee2e2; color: #991b1b; }
	.status { font-size: 0.7rem; padding: 0.15rem 0.5rem; border-radius: 4px; text-transform: uppercase; font-weight: 600; }
	.status-passed { background: #dcfce7; color: #166534; }
	.status-failed { background: #fee2e2; color: #991b1b; }
	.status-blocked { background: #fef3c7; color: #92400e; }
	.status-skipped { background: #e5e7eb; color: #4b5563; }
	.status-not-run { background: #e5e7eb; color: #4b5563; }
	.empty, .error { padding: 2rem; text-align: center; color: var(--text-muted); }
	.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 300; }
	.modal { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 1.25rem; width: min(600px, 90vw); max-height: 85vh; overflow-y: auto; display: flex; flex-direction: column; gap: 0.5rem; }
	.modal header { display: flex; justify-content: space-between; align-items: center; }
	.modal h2 { margin: 0; }
	.modal h3 { margin: 0.5rem 0 0.25rem; font-size: 0.9rem; text-transform: uppercase; color: var(--text-muted); }
	.steps { margin: 0; padding-left: 1.25rem; }
	.modal label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.8rem; color: var(--text-muted); }
	.modal input, .modal textarea, .modal select { padding: 0.4rem 0.5rem; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font-size: 0.88rem; }
	.dim { color: var(--text-muted); font-size: 0.8rem; }
</style>
