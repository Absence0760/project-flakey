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
		auto_rule: string | null;
		auto_details: string | null;
	}

	interface LinkedRun {
		id: number;
		suite_name: string;
		branch: string;
		commit_sha: string;
		total: number;
		passed: number;
		failed: number;
		skipped: number;
		duration_ms: number;
		created_at: string;
	}

	interface LinkedManualTest {
		id: number;
		title: string;
		suite_name: string | null;
		priority: string;
		status: string;
		last_run_at: string | null;
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
		linked_runs: LinkedRun[];
		linked_manual_tests: LinkedManualTest[];
	}

	interface Readiness {
		runs: { linked: number; total: number; passed: number; failed: number; skipped: number };
		manual_tests: { linked: number; passed: number; failed: number; blocked: number; skipped: number; not_run: number };
		rules: Record<string, { met: boolean; details: string }>;
		blocking_items: Array<{ id: number; label: string; auto_rule: string | null; auto_details: string | null }>;
		ready: boolean;
	}

	interface RunSummary { id: number; suite_name: string; branch: string; created_at: string; total: number; passed: number; failed: number }
	interface ManualTestSummary { id: number; title: string; suite_name: string | null; priority: string; status: string }

	interface JiraVersion {
		id: string;
		name: string;
		released: boolean;
		archived: boolean;
		releaseDate?: string;
		overdue?: boolean;
	}
	interface JiraIssue {
		key: string;
		url: string;
		summary: string;
		status: string;
		statusCategory: string;
		assignee: string | null;
	}
	interface JiraCounts {
		issuesAffectedCount: number;
		issuesFixedCount: number;
	}
	interface JiraState {
		configured: boolean;
		matched?: boolean;
		error?: string;
		release_version?: string;
		available_versions?: JiraVersion[];
		project_key?: string;
		version?: JiraVersion;
		browse_url?: string;
		counts?: JiraCounts | null;
		issues?: JiraIssue[];
	}

	const releaseId = $derived($page.params.id);

	let release = $state<Release | null>(null);
	let readiness = $state<Readiness | null>(null);
	let jira = $state<JiraState | null>(null);
	let jiraLoading = $state(false);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let newItemLabel = $state('');
	let newItemRequired = $state(true);

	// Linker state — lazily populated when the user opens either link panel
	let availableRuns = $state<RunSummary[]>([]);
	let runPickerOpen = $state(false);
	let availableManualTests = $state<ManualTestSummary[]>([]);
	let manualTestPickerOpen = $state(false);
	let manualTestSelection = $state<Set<number>>(new Set());

	onMount(load);

	async function load() {
		loading = true;
		error = null;
		try {
			const [rRes, readyRes] = await Promise.all([
				authFetch(`${API_URL}/releases/${releaseId}`),
				authFetch(`${API_URL}/releases/${releaseId}/readiness`),
			]);
			if (!rRes.ok) throw new Error('Failed to load release');
			release = await rRes.json();
			readiness = readyRes.ok ? await readyRes.json() : null;
		} catch (err) {
			error = (err as Error).message;
		} finally {
			loading = false;
		}
		// Load Jira state in the background; don't block the page on a
		// slow/flaky Jira instance.
		loadJira();
	}

	async function loadJira() {
		jiraLoading = true;
		try {
			const res = await authFetch(`${API_URL}/releases/${releaseId}/jira`);
			if (res.ok) jira = await res.json();
			else jira = null;
		} catch {
			jira = null;
		} finally {
			jiraLoading = false;
		}
	}

	async function pinJiraVersion(v: JiraVersion) {
		await authFetch(`${API_URL}/releases/${releaseId}/jira/match`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ version_id: v.id, version_name: v.name }),
		});
		await loadJira();
	}

	async function clearJiraMatch() {
		await authFetch(`${API_URL}/releases/${releaseId}/jira/match`, { method: 'DELETE' });
		await loadJira();
	}

	async function toggleItem(item: ChecklistItem) {
		if (item.auto_rule) return; // auto-ruled — click is a no-op
		await authFetch(`${API_URL}/releases/${releaseId}/items/${item.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ checked: !item.checked }),
		});
		await load();
	}

	// ── Linked runs ──────────────────────────────────────────────────────
	async function openRunPicker() {
		runPickerOpen = true;
		if (availableRuns.length === 0) {
			const res = await authFetch(`${API_URL}/runs?limit=50`);
			if (res.ok) {
				const data = await res.json();
				availableRuns = Array.isArray(data) ? data : (data.runs ?? []);
			}
		}
	}

	async function linkRun(runId: number) {
		await authFetch(`${API_URL}/releases/${releaseId}/runs`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ run_id: runId }),
		});
		runPickerOpen = false;
		await load();
	}

	async function unlinkRun(runId: number) {
		await authFetch(`${API_URL}/releases/${releaseId}/runs/${runId}`, { method: 'DELETE' });
		await load();
	}

	// ── Linked manual tests ──────────────────────────────────────────────
	async function openManualTestPicker() {
		manualTestPickerOpen = true;
		manualTestSelection = new Set();
		if (availableManualTests.length === 0) {
			const res = await authFetch(`${API_URL}/manual-tests`);
			if (res.ok) availableManualTests = await res.json();
		}
	}

	function toggleManualTestSelection(id: number) {
		const next = new Set(manualTestSelection);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		manualTestSelection = next;
	}

	async function linkManualTests() {
		if (manualTestSelection.size === 0) {
			manualTestPickerOpen = false;
			return;
		}
		await authFetch(`${API_URL}/releases/${releaseId}/manual-tests`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ manual_test_ids: Array.from(manualTestSelection) }),
		});
		manualTestPickerOpen = false;
		await load();
	}

	async function unlinkManualTest(mtId: number) {
		await authFetch(`${API_URL}/releases/${releaseId}/manual-tests/${mtId}`, { method: 'DELETE' });
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

		{#if readiness}
			<section class="readiness" class:ready={readiness.ready}>
				<div class="section-header">
					<h2>Release readiness</h2>
					<span class={readiness.ready ? 'ready-pill' : 'blocked-pill'}>
						{readiness.ready ? '✓ Ready to ship' : `${readiness.blocking_items.length} blocker(s)`}
					</span>
				</div>

				<div class="readiness-grid">
					<div class="readiness-card">
						<div class="card-title">Automated runs</div>
						{#if readiness.runs.linked > 0}
							<div class="card-big">{readiness.runs.passed}/{readiness.runs.total} passing</div>
							<div class="card-sub">
								{readiness.runs.linked} linked run(s) ·
								{readiness.runs.failed} failed ·
								{readiness.runs.skipped} skipped
							</div>
						{:else}
							<div class="card-sub">No runs linked yet — falling back to latest run for the org.</div>
						{/if}
					</div>

					<div class="readiness-card">
						<div class="card-title">Manual tests</div>
						{#if readiness.manual_tests.linked > 0}
							<div class="card-big">{readiness.manual_tests.passed}/{readiness.manual_tests.linked} passed</div>
							<div class="card-sub">
								{readiness.manual_tests.failed} failed ·
								{readiness.manual_tests.blocked} blocked ·
								{readiness.manual_tests.not_run} not run
							</div>
						{:else}
							<div class="card-sub">No manual tests linked — falling back to high/critical priority tests org-wide.</div>
						{/if}
					</div>
				</div>

				<div class="rules">
					{#each Object.entries(readiness.rules) as [key, rule]}
						<div class="rule" class:met={rule.met}>
							<span class="rule-icon">{rule.met ? '✓' : '✗'}</span>
							<div>
								<div class="rule-name">{key.replace(/_/g, ' ')}</div>
								<div class="rule-detail">{rule.details}</div>
							</div>
						</div>
					{/each}
				</div>

				{#if !readiness.ready && readiness.blocking_items.length > 0}
					<div class="blockers">
						<strong>Blocking:</strong>
						<ul>
							{#each readiness.blocking_items as b}
								<li>{b.label}{#if b.auto_details} — <span class="dim">{b.auto_details}</span>{/if}</li>
							{/each}
						</ul>
					</div>
				{/if}
			</section>
		{/if}

		{#if jira && jira.configured}
			<section class="jira">
				<div class="section-header">
					<h2>Jira release</h2>
					{#if jira.matched && jira.version}
						<button class="btn-ghost" onclick={clearJiraMatch}>Clear match</button>
					{/if}
				</div>

				{#if jiraLoading}
					<p class="empty">Loading Jira…</p>
				{:else if jira.error}
					<p class="error">Jira error: {jira.error}</p>
				{:else if jira.matched && jira.version}
					{@const v = jira.version}
					<div class="jira-head">
						<div>
							<a class="jira-version-name" href={jira.browse_url} target="_blank" rel="noopener">
								{jira.project_key} / {v.name}
							</a>
							<div class="jira-sub">
								{v.released ? '✓ Released' : v.archived ? 'Archived' : v.overdue ? '⚠ Overdue' : 'Unreleased'}
								{#if v.releaseDate} · {v.releaseDate}{/if}
							</div>
						</div>
						{#if jira.counts}
							<div class="jira-counts">
								<div><span class="big">{jira.counts.issuesFixedCount}</span><span class="dim">fixed</span></div>
								<div><span class="big">{jira.counts.issuesAffectedCount}</span><span class="dim">affected</span></div>
							</div>
						{/if}
					</div>

					{#if jira.issues && jira.issues.length > 0}
						<ul class="jira-issues">
							{#each jira.issues as issue}
								<li class={`jira-cat-${issue.statusCategory}`}>
									<a href={issue.url} target="_blank" rel="noopener" class="issue-key">{issue.key}</a>
									<span class="issue-summary">{issue.summary}</span>
									<span class="issue-status">{issue.status}</span>
									{#if issue.assignee}<span class="issue-assignee dim">{issue.assignee}</span>{/if}
								</li>
							{/each}
						</ul>
					{:else}
						<p class="empty">No issues found for this fix version.</p>
					{/if}
				{:else}
					<p class="empty">
						No Jira version matches <code>{jira.release_version ?? release.version}</code>.
						Pick one to pin:
					</p>
					{#if jira.available_versions && jira.available_versions.length > 0}
						<ul class="version-list">
							{#each jira.available_versions as v}
								<li>
									<button type="button" class="picker-row" onclick={() => pinJiraVersion(v)}>
										<strong>{v.name}</strong>
										<span class="dim">
											{v.released ? 'released' : v.archived ? 'archived' : 'unreleased'}
											{#if v.releaseDate} · {v.releaseDate}{/if}
										</span>
									</button>
								</li>
							{/each}
						</ul>
					{:else}
						<p class="dim">No versions found in the Jira project.</p>
					{/if}
				{/if}
			</section>
		{/if}

		<section>
			<div class="section-header">
				<h2>Linked automated runs</h2>
				<button class="btn-ghost" onclick={openRunPicker}>+ Link run</button>
			</div>
			{#if release.linked_runs.length === 0}
				<p class="empty">No runs linked. Readiness will use the latest run for the org.</p>
			{:else}
				<ul class="link-list">
					{#each release.linked_runs as r}
						<li>
							<a href={`/runs/${r.id}`}>
								<strong>{r.suite_name}</strong>
								<span class="dim">#{r.id} · {r.branch || 'main'} · {new Date(r.created_at).toLocaleString()}</span>
							</a>
							<span class="mini-stats">
								<span class="pass">{r.passed}</span> /
								<span class="fail">{r.failed}</span> /
								{r.total}
							</span>
							<button class="del" title="Unlink" onclick={() => unlinkRun(r.id)}>✕</button>
						</li>
					{/each}
				</ul>
			{/if}

			{#if runPickerOpen}
				<div class="picker">
					<div class="picker-header">
						<strong>Pick a run to link</strong>
						<button class="btn-ghost" onclick={() => (runPickerOpen = false)}>Close</button>
					</div>
					<ul class="picker-list">
						{#each availableRuns as r}
							<li>
								<button type="button" class="picker-row" onclick={() => linkRun(r.id)}>
									<strong>{r.suite_name}</strong>
									<span class="dim">#{r.id} · {r.branch || 'main'} · {new Date(r.created_at).toLocaleString()}</span>
									<span class="mini-stats">{r.passed}/{r.failed}/{r.total}</span>
								</button>
							</li>
						{:else}
							<li class="empty">No runs found.</li>
						{/each}
					</ul>
				</div>
			{/if}
		</section>

		<section>
			<div class="section-header">
				<h2>Linked manual tests</h2>
				<button class="btn-ghost" onclick={openManualTestPicker}>+ Link manual tests</button>
			</div>
			{#if release.linked_manual_tests.length === 0}
				<p class="empty">No manual tests linked. Readiness will use all high/critical priority manual tests.</p>
			{:else}
				<ul class="link-list">
					{#each release.linked_manual_tests as mt}
						<li>
							<a href="/manual-tests">
								<strong>{mt.title}</strong>
								<span class="dim">{mt.suite_name ?? '—'} · {mt.priority}</span>
							</a>
							<span class={`status status-${mt.status.replace('_', '-')}`}>{mt.status.replace('_', ' ')}</span>
							<button class="del" title="Unlink" onclick={() => unlinkManualTest(mt.id)}>✕</button>
						</li>
					{/each}
				</ul>
			{/if}

			{#if manualTestPickerOpen}
				<div class="picker">
					<div class="picker-header">
						<strong>Pick manual tests to link ({manualTestSelection.size} selected)</strong>
						<div>
							<button class="btn-ghost" onclick={() => (manualTestPickerOpen = false)}>Cancel</button>
							<button class="btn-primary" onclick={linkManualTests}>Link selected</button>
						</div>
					</div>
					<ul class="picker-list">
						{#each availableManualTests as mt}
							{@const alreadyLinked = release.linked_manual_tests.some(x => x.id === mt.id)}
							<li>
								<label class="picker-row" class:disabled={alreadyLinked}>
									<input
										type="checkbox"
										disabled={alreadyLinked}
										checked={manualTestSelection.has(mt.id)}
										onchange={() => toggleManualTestSelection(mt.id)}
									/>
									<strong>{mt.title}</strong>
									<span class="dim">{mt.suite_name ?? '—'} · {mt.priority}</span>
									<span class={`status status-${mt.status.replace('_', '-')}`}>{mt.status.replace('_', ' ')}</span>
									{#if alreadyLinked}<span class="dim">(linked)</span>{/if}
								</label>
							</li>
						{:else}
							<li class="empty">No manual tests found.</li>
						{/each}
					</ul>
				</div>
			{/if}
		</section>

		<section>
			<div class="section-header">
				<h2>Checklist</h2>
				<span class="progress-text">{checked}/{total} complete · {requiredRemaining} required remaining</span>
			</div>
			<ul class="items">
				{#each release.items as item}
					<li class:checked={item.checked} class:auto={item.auto_rule}>
						<label>
							<input
								type="checkbox"
								checked={item.checked}
								disabled={!!item.auto_rule}
								onchange={() => toggleItem(item)}
							/>
							<span class="item-label">
								{item.label}
								{#if item.required}<span class="req">required</span>{/if}
								{#if item.auto_rule}<span class="auto-badge" title="Auto-evaluated">auto</span>{/if}
							</span>
						</label>
						{#if item.auto_rule && item.auto_details}
							<span class="auto-details">{item.auto_details}</span>
						{:else if item.checked && item.checked_by_email}
							<span class="checked-by">✓ {item.checked_by_email}</span>
						{/if}
						{#if !item.auto_rule}
							<button class="del" title="Remove" onclick={() => deleteItem(item.id)}>✕</button>
						{/if}
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

	/* ── Readiness panel ─────────────────────────────────────────────── */
	.readiness { border-left: 3px solid #f59e0b; }
	.readiness.ready { border-left-color: #16a34a; }
	.ready-pill { background: #dcfce7; color: #166534; padding: 0.2rem 0.6rem; border-radius: 4px; font-size: 0.72rem; font-weight: 600; text-transform: uppercase; }
	.blocked-pill { background: #fef3c7; color: #92400e; padding: 0.2rem 0.6rem; border-radius: 4px; font-size: 0.72rem; font-weight: 600; text-transform: uppercase; }
	.readiness-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin-bottom: 0.75rem; }
	.readiness-card { background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 6px; padding: 0.75rem 1rem; }
	.card-title { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); font-weight: 600; }
	.card-big { font-size: 1.3rem; font-weight: 700; margin: 0.25rem 0 0.1rem; color: var(--text); }
	.card-sub { font-size: 0.78rem; color: var(--text-muted); }
	.rules { display: flex; flex-direction: column; gap: 0.4rem; }
	.rule { display: flex; align-items: flex-start; gap: 0.5rem; padding: 0.45rem 0.6rem; border-radius: 6px; background: #fef2f2; border: 1px solid #fecaca; }
	.rule.met { background: #f0fdf4; border-color: #bbf7d0; }
	.rule-icon { font-weight: 700; color: #dc2626; }
	.rule.met .rule-icon { color: #16a34a; }
	.rule-name { font-size: 0.82rem; font-weight: 600; text-transform: capitalize; }
	.rule-detail { font-size: 0.75rem; color: var(--text-muted); }
	.blockers { margin-top: 0.75rem; font-size: 0.82rem; }
	.blockers ul { margin: 0.3rem 0 0 1rem; padding: 0; }
	.dim { color: var(--text-muted); }

	/* ── Linked runs / manual tests ──────────────────────────────────── */
	.link-list { list-style: none; padding: 0; margin: 0; }
	.link-list li { display: flex; align-items: center; gap: 0.75rem; padding: 0.55rem 0; border-bottom: 1px solid var(--border); font-size: 0.85rem; }
	.link-list li:last-child { border-bottom: none; }
	.link-list a { flex: 1; color: var(--text); text-decoration: none; display: flex; flex-direction: column; gap: 0.15rem; }
	.link-list a:hover strong { text-decoration: underline; }
	.mini-stats { font-size: 0.78rem; color: var(--text-muted); white-space: nowrap; }
	.mini-stats .pass { color: #16a34a; font-weight: 600; }
	.mini-stats .fail { color: #dc2626; font-weight: 600; }
	.empty { color: var(--text-muted); font-size: 0.85rem; margin: 0.5rem 0; }

	/* ── Pickers ─────────────────────────────────────────────────────── */
	.picker { margin-top: 0.75rem; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-secondary); padding: 0.75rem; }
	.picker-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; font-size: 0.85rem; }
	.picker-header button + button { margin-left: 0.4rem; }
	.picker-list { list-style: none; padding: 0; margin: 0; max-height: 320px; overflow-y: auto; }
	.picker-list li { border-bottom: 1px solid var(--border); }
	.picker-list li:last-child { border-bottom: none; }
	.picker-row {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.5rem 0.25rem;
		width: 100%;
		background: transparent;
		border: none;
		text-align: left;
		cursor: pointer;
		font-size: 0.82rem;
		color: var(--text);
	}
	.picker-row:hover { background: var(--bg); }
	.picker-row.disabled { opacity: 0.5; cursor: not-allowed; }

	/* ── Auto-ruled checklist items ──────────────────────────────────── */
	.items li.auto { background: linear-gradient(to right, rgba(37, 99, 235, 0.04), transparent); }
	.items li.auto label { cursor: default; }
	.auto-badge { font-size: 0.62rem; padding: 0.1rem 0.4rem; background: #dbeafe; color: #1e40af; border-radius: 3px; margin-left: 0.4rem; text-transform: uppercase; font-weight: 600; }
	.auto-details { font-size: 0.72rem; color: var(--text-muted); font-style: italic; }
	.btn-ghost { background: transparent; color: var(--text-muted); border: 1px solid var(--border); padding: 0.35rem 0.7rem; border-radius: 6px; cursor: pointer; font-size: 0.8rem; }
	.btn-ghost:hover { color: var(--text); }

	.status-passed { background: #dcfce7; color: #166534; padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.7rem; text-transform: uppercase; font-weight: 600; }
	.status-failed { background: #fee2e2; color: #991b1b; padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.7rem; text-transform: uppercase; font-weight: 600; }
	.status-blocked { background: #fef3c7; color: #92400e; padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.7rem; text-transform: uppercase; font-weight: 600; }
	.status-skipped { background: #e5e7eb; color: #4b5563; padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.7rem; text-transform: uppercase; font-weight: 600; }
	.status-not-run { background: #e5e7eb; color: #4b5563; padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.7rem; text-transform: uppercase; font-weight: 600; }

	/* ── Jira panel ──────────────────────────────────────────────────── */
	.jira { border-left: 3px solid #2563eb; }
	.jira-head {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 1rem;
		margin-bottom: 0.75rem;
	}
	.jira-version-name {
		font-size: 1.1rem;
		font-weight: 700;
		color: #2563eb;
		text-decoration: none;
	}
	.jira-version-name:hover { text-decoration: underline; }
	.jira-sub { font-size: 0.78rem; color: var(--text-muted); margin-top: 0.15rem; }
	.jira-counts { display: flex; gap: 1.25rem; }
	.jira-counts > div { display: flex; flex-direction: column; align-items: flex-end; }
	.jira-counts .big { font-size: 1.4rem; font-weight: 700; color: var(--text); }
	.jira-counts .dim { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.04em; }

	.jira-issues { list-style: none; padding: 0; margin: 0; border-top: 1px solid var(--border); }
	.jira-issues li {
		display: grid;
		grid-template-columns: 96px 1fr auto auto;
		align-items: center;
		gap: 0.75rem;
		padding: 0.5rem 0;
		border-bottom: 1px solid var(--border);
		font-size: 0.85rem;
	}
	.jira-issues li:last-child { border-bottom: none; }
	.issue-key { color: #2563eb; text-decoration: none; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8rem; font-weight: 600; }
	.issue-key:hover { text-decoration: underline; }
	.issue-summary { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.issue-status {
		font-size: 0.68rem;
		text-transform: uppercase;
		padding: 0.15rem 0.5rem;
		border-radius: 4px;
		font-weight: 600;
		background: #e5e7eb;
		color: #4b5563;
	}
	.jira-cat-done    .issue-status { background: #dcfce7; color: #166534; }
	.jira-cat-indeterminate .issue-status { background: #dbeafe; color: #1e40af; }
	.jira-cat-new     .issue-status { background: #fef3c7; color: #92400e; }
	.issue-assignee { font-size: 0.75rem; }

	.version-list { list-style: none; padding: 0; margin: 0.5rem 0 0; max-height: 280px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; }
	.version-list li { border-bottom: 1px solid var(--border); }
	.version-list li:last-child { border-bottom: none; }
</style>
