<script lang="ts">
	import { onMount } from 'svelte';
	import { authFetch } from '$lib/auth';
	import AutomatedTestPicker from '$lib/components/AutomatedTestPicker.svelte';

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
		source: 'manual' | 'cucumber';
		source_ref: string | null;
		source_file: string | null;
		auto_last_status: 'passed' | 'failed' | 'skipped' | 'pending' | null;
		auto_last_run_at: string | null;
	}

	interface StepResult {
		status: 'passed' | 'failed' | 'blocked' | 'skipped';
		comment: string;
	}

	interface ManualTestDetail extends ManualTest {
		steps: Array<string | { action: string; data?: string; expected?: string }>;
		expected_result: string | null;
		last_step_results: StepResult[];
	}

	interface Summary { total: number; passed: number; failed: number; blocked: number; skipped: number; not_run: number; }

	let tests = $state<ManualTest[]>([]);
	let summary = $state<Summary | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let filterStatus = $state<'all' | 'not_run' | 'passed' | 'failed' | 'blocked' | 'skipped'>('all');
	let filterSuite = $state<string>('all');

	// Unique suites from the loaded tests, for the project filter
	const suites = $derived.by(() => {
		const set = new Set<string>();
		for (const t of tests) if (t.suite_name) set.add(t.suite_name);
		return Array.from(set).sort();
	});

	// Client-side counts for the filter tabs (respect the suite filter but
	// not the status filter, so counts always reflect "how many would show
	// if I clicked this tab")
	const statusCounts = $derived.by(() => {
		const scoped = filterSuite === 'all' ? tests : tests.filter(t => t.suite_name === filterSuite);
		return {
			all: scoped.length,
			not_run: scoped.filter(t => t.status === 'not_run').length,
			passed: scoped.filter(t => t.status === 'passed').length,
			failed: scoped.filter(t => t.status === 'failed').length,
			blocked: scoped.filter(t => t.status === 'blocked').length,
			skipped: scoped.filter(t => t.status === 'skipped').length,
		};
	});

	const filteredTests = $derived.by(() => {
		return tests.filter(t => {
			if (filterSuite !== 'all' && t.suite_name !== filterSuite) return false;
			if (filterStatus !== 'all' && t.status !== filterStatus) return false;
			return true;
		});
	});

	interface StepRow {
		action: string;
		data: string;
		expected: string;
	}

	function emptyStep(): StepRow {
		return { action: '', data: '', expected: '' };
	}

	let showCreate = $state(false);
	let newTitle = $state('');
	let newSuite = $state('');
	let newDescription = $state('');
	let newPriority = $state<'low' | 'medium' | 'high' | 'critical'>('medium');
	let newSteps = $state<StepRow[]>([emptyStep()]);
	let newAutomatedKey = $state('');
	let newTagsText = $state('');

	function resetCreateForm() {
		newTitle = '';
		newSuite = '';
		newDescription = '';
		newPriority = 'medium';
		newSteps = [emptyStep()];
		newAutomatedKey = '';
		newTagsText = '';
	}

	function openCreate() {
		resetCreateForm();
		showCreate = true;
	}

	function closeCreate() {
		showCreate = false;
	}

	function addStep() {
		newSteps = [...newSteps, emptyStep()];
	}

	function removeStep(index: number) {
		if (newSteps.length === 1) {
			newSteps = [emptyStep()];
			return;
		}
		newSteps = newSteps.filter((_, i) => i !== index);
	}

	function moveStep(index: number, dir: -1 | 1) {
		const target = index + dir;
		if (target < 0 || target >= newSteps.length) return;
		const copy = [...newSteps];
		[copy[index], copy[target]] = [copy[target], copy[index]];
		newSteps = copy;
	}

	let selected = $state<ManualTestDetail | null>(null);
	let runStatus = $state<'passed' | 'failed' | 'blocked' | 'skipped'>('passed');
	let runNotes = $state('');

	// Step-by-step runner state. `runMode` toggles the detail modal into an
	// interactive runner; `stepRuns` is seeded with one entry per step when
	// the runner opens and then edited row-by-row.
	let runMode = $state(false);
	let stepRuns = $state<StepResult[]>([]);

	function startRunner() {
		if (!selected) return;
		const n = selected.steps?.length ?? 0;
		stepRuns = Array.from({ length: n }, () => ({ status: 'passed' as const, comment: '' }));
		runNotes = '';
		runMode = true;
	}

	function cancelRunner() {
		runMode = false;
		stepRuns = [];
	}

	function setStepStatus(i: number, status: StepResult['status']) {
		stepRuns = stepRuns.map((s, idx) => (idx === i ? { ...s, status } : s));
	}

	// Mirror the backend's deriveOverallStatus so the user sees the final
	// result before clicking save.
	const derivedOverall = $derived.by<'passed' | 'failed' | 'blocked' | 'skipped' | 'not_run'>(() => {
		if (!stepRuns.length) return 'not_run';
		if (stepRuns.some(s => s.status === 'failed')) return 'failed';
		if (stepRuns.some(s => s.status === 'blocked')) return 'blocked';
		if (stepRuns.every(s => s.status === 'skipped')) return 'skipped';
		return 'passed';
	});

	// Auto-continue a markdown-style list when the user presses Enter on a
	// line that already starts with "- " or "* ". Pressing Enter on an empty
	// bullet cancels the list instead of making a new empty one.
	function handleNotesKey(e: KeyboardEvent) {
		if (e.key !== 'Enter' || e.shiftKey) return;
		const ta = e.currentTarget as HTMLTextAreaElement;
		const pos = ta.selectionStart;
		const before = ta.value.slice(0, pos);
		const lineStart = before.lastIndexOf('\n') + 1;
		const line = before.slice(lineStart);
		const match = line.match(/^(\s*)([-*])\s+(.*)$/);
		if (!match) return;
		const [, indent, bullet, rest] = match;
		e.preventDefault();
		if (rest.trim() === '') {
			// Empty bullet → drop it and exit the list
			const newValue = ta.value.slice(0, lineStart) + ta.value.slice(pos);
			ta.value = newValue;
			runNotes = newValue;
			ta.selectionStart = ta.selectionEnd = lineStart;
			return;
		}
		const insert = `\n${indent}${bullet} `;
		const newValue = ta.value.slice(0, pos) + insert + ta.value.slice(pos);
		ta.value = newValue;
		runNotes = newValue;
		ta.selectionStart = ta.selectionEnd = pos + insert.length;
	}

	// Close whichever modal is topmost on Esc. The runner lives inside the
	// detail modal, so if the user is in the runner we back out of it first
	// rather than nuking the whole modal.
	function handleEsc(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		if (showCreate) {
			closeCreate();
			e.preventDefault();
			return;
		}
		if (selected) {
			if (runMode) cancelRunner();
			else selected = null;
			e.preventDefault();
		}
	}

	async function saveRunnerResult() {
		if (!selected) return;
		const res = await authFetch(`${API_URL}/manual-tests/${selected.id}/result`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ step_results: stepRuns, notes: runNotes || null }),
		});
		if (res.ok) {
			runMode = false;
			selected = null;
			stepRuns = [];
			await load();
		}
	}

	onMount(load);

	async function load() {
		loading = true;
		try {
			// Load the full list; filtering happens client-side so the tab
			// counts always reflect the live set of tests.
			const [listRes, sumRes] = await Promise.all([
				authFetch(`${API_URL}/manual-tests`),
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

		// Strip fully empty rows; keep the structured {action, data, expected}
		// shape for non-empty rows.
		const steps = newSteps
			.map(s => ({
				action: s.action.trim(),
				data: s.data.trim(),
				expected: s.expected.trim(),
			}))
			.filter(s => s.action || s.data || s.expected);

		const tags = newTagsText
			.split(',')
			.map(t => t.trim())
			.filter(Boolean);

		const res = await authFetch(`${API_URL}/manual-tests`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: newTitle,
				suite_name: newSuite || null,
				description: newDescription || null,
				priority: newPriority,
				steps,
				automated_test_key: newAutomatedKey || null,
				tags,
			}),
		});
		if (res.ok) {
			closeCreate();
			await load();
		}
	}

	async function openTest(id: number) {
		const res = await authFetch(`${API_URL}/manual-tests/${id}`);
		if (res.ok) {
			selected = await res.json();
			runStatus = 'passed';
			runNotes = '';
			runMode = false;
			stepRuns = [];
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

	// ── Cucumber import ──────────────────────────────────────────────────
	let importing = $state(false);
	let importMessage = $state<string | null>(null);
	let fileInput = $state<HTMLInputElement | null>(null);

	function openImport() {
		importMessage = null;
		fileInput?.click();
	}

	async function onFilesPicked(e: Event) {
		const target = e.target as HTMLInputElement;
		const list = target.files;
		if (!list || list.length === 0) return;

		importing = true;
		importMessage = null;
		try {
			const files = await Promise.all(
				Array.from(list).map(async (f) => ({
					path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
					content: await f.text(),
				}))
			);
			const res = await authFetch(`${API_URL}/manual-tests/import-features`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ files }),
			});
			if (!res.ok) {
				importMessage = `Import failed: ${res.status}`;
			} else {
				const r = await res.json();
				importMessage = `Imported ${r.scanned} scenarios (${r.created} new, ${r.updated} updated)`;
				await load();
			}
		} catch (err) {
			importMessage = `Import error: ${(err as Error).message}`;
		} finally {
			importing = false;
			if (fileInput) fileInput.value = '';
		}
	}

	function autoStatusLabel(s: string | null): string {
		if (!s) return 'No automated run yet';
		if (s === 'passed') return 'Automated run: passing';
		if (s === 'failed') return 'Automated run: failing';
		return `Automated run: ${s}`;
	}
</script>

<svelte:window onkeydown={handleEsc} />

<div class="page">
	<header class="page-header">
		<div>
			<h1>Manual tests</h1>
			<p class="subtitle">Manage and execute manual regression tests alongside your automated suite.</p>
		</div>
		<div class="header-actions">
			<button class="btn-ghost" onclick={openImport} disabled={importing}>
				{importing ? 'Importing…' : '⇪ Import .feature files'}
			</button>
			<button class="btn-primary" onclick={openCreate}>+ New test</button>
		</div>
	</header>

	<input
		bind:this={fileInput}
		type="file"
		accept=".feature"
		multiple
		style="display: none"
		onchange={onFilesPicked}
	/>

	{#if importMessage}
		<p class="import-toast">{importMessage}</p>
	{/if}

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
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="modal-overlay" onclick={closeCreate}>
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="modal create-modal" onclick={(e) => e.stopPropagation()}>
				<header class="modal-header">
					<h2>New manual test</h2>
					<button class="btn-ghost" onclick={closeCreate} aria-label="Close">✕</button>
				</header>

				<div class="modal-body">
					<!-- ─── Details ─────────────────────────────────────────── -->
					<section class="form-section">
						<h3 class="form-section-title">Details</h3>
						<div class="form-grid">
							<label class="field field-wide">
								<span class="field-label">Summary <span class="req">*</span></span>
								<input bind:value={newTitle} placeholder="e.g. Checkout flow with expired card" />
							</label>
							<label class="field">
								<span class="field-label">Suite</span>
								<input bind:value={newSuite} placeholder="regression" list="suite-options" />
								<datalist id="suite-options">
									{#each suites as s}<option value={s}></option>{/each}
								</datalist>
							</label>
							<label class="field">
								<span class="field-label">Priority</span>
								<select bind:value={newPriority}>
									<option value="low">Low</option>
									<option value="medium">Medium</option>
									<option value="high">High</option>
									<option value="critical">Critical</option>
								</select>
							</label>
							<label class="field field-wide">
								<span class="field-label">Description</span>
								<textarea bind:value={newDescription} rows="2" placeholder="Optional — what is this test verifying?"></textarea>
							</label>
							<label class="field">
								<span class="field-label">Tags</span>
								<input bind:value={newTagsText} placeholder="smoke, billing" />
							</label>
							<label class="field">
								<span class="field-label">Linked automated test</span>
								<AutomatedTestPicker
									bind:value={newAutomatedKey}
									placeholder="Search tests or spec files from uploaded runs…"
								/>
							</label>
						</div>
					</section>

					<!-- ─── Steps grid ──────────────────────────────────────── -->
					<section class="form-section">
						<div class="form-section-header">
							<h3 class="form-section-title">Test steps</h3>
							<button type="button" class="btn-ghost btn-small" onclick={addStep}>+ Add step</button>
						</div>
						<table class="step-grid">
							<thead>
								<tr>
									<th class="col-num">#</th>
									<th class="col-action">Action</th>
									<th class="col-data">Data</th>
									<th class="col-expected">Expected result</th>
									<th class="col-actions"></th>
								</tr>
							</thead>
							<tbody>
								{#each newSteps as step, i}
									<tr>
										<td class="col-num">{i + 1}</td>
										<td>
											<textarea
												bind:value={step.action}
												rows="2"
												placeholder="Navigate to /checkout and click Pay"
											></textarea>
										</td>
										<td>
											<textarea
												bind:value={step.data}
												rows="2"
												placeholder="card: 4111… exp: 01/20"
											></textarea>
										</td>
										<td>
											<textarea
												bind:value={step.expected}
												rows="2"
												placeholder="Error banner: 'Card expired'"
											></textarea>
										</td>
										<td class="col-actions">
											<button
												type="button"
												class="icon-btn"
												title="Move up"
												disabled={i === 0}
												onclick={() => moveStep(i, -1)}
											>↑</button>
											<button
												type="button"
												class="icon-btn"
												title="Move down"
												disabled={i === newSteps.length - 1}
												onclick={() => moveStep(i, 1)}
											>↓</button>
											<button
												type="button"
												class="icon-btn danger"
												title="Remove step"
												onclick={() => removeStep(i)}
											>✕</button>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
						<p class="hint">Each step is a single user action. Use <strong>Data</strong> for test inputs (form values, credentials) and <strong>Expected result</strong> for what the tester should verify after the action.</p>
					</section>
				</div>

				<footer class="modal-footer">
					<button class="btn-ghost" onclick={closeCreate}>Cancel</button>
					<button class="btn-primary" onclick={createTest} disabled={!newTitle.trim()}>Create test</button>
				</footer>
			</div>
		</div>
	{/if}

	<div class="toolbar">
		<div class="filter-tabs">
			<button class="filter-tab" class:active={filterStatus === 'all'} onclick={() => (filterStatus = 'all')}>
				All <span class="tab-count">{statusCounts.all}</span>
			</button>
			<button class="filter-tab" class:active={filterStatus === 'not_run'} onclick={() => (filterStatus = 'not_run')}>
				<span class="dot not-run"></span> Not run <span class="tab-count">{statusCounts.not_run}</span>
			</button>
			<button class="filter-tab" class:active={filterStatus === 'passed'} onclick={() => (filterStatus = 'passed')}>
				<span class="dot pass"></span> Passed <span class="tab-count">{statusCounts.passed}</span>
			</button>
			<button class="filter-tab" class:active={filterStatus === 'failed'} onclick={() => (filterStatus = 'failed')}>
				<span class="dot fail"></span> Failed <span class="tab-count">{statusCounts.failed}</span>
			</button>
			<button class="filter-tab" class:active={filterStatus === 'blocked'} onclick={() => (filterStatus = 'blocked')}>
				<span class="dot blocked"></span> Blocked <span class="tab-count">{statusCounts.blocked}</span>
			</button>
			<button class="filter-tab" class:active={filterStatus === 'skipped'} onclick={() => (filterStatus = 'skipped')}>
				<span class="dot skip"></span> Skipped <span class="tab-count">{statusCounts.skipped}</span>
			</button>
		</div>

		<div class="suite-filter">
			<label for="suite-select">Suite</label>
			<select id="suite-select" bind:value={filterSuite}>
				<option value="all">All suites</option>
				{#each suites as s}
					<option value={s}>{s}</option>
				{/each}
			</select>
		</div>
	</div>

	{#if loading}
		<p>Loading…</p>
	{:else if error}
		<p class="error">{error}</p>
	{:else if tests.length === 0}
		<p class="empty">No manual tests yet.</p>
	{:else if filteredTests.length === 0}
		<p class="empty">No tests match the current filters.</p>
	{:else}
		<table class="tests">
			<thead>
				<tr>
					<th>Title</th>
					<th>Suite</th>
					<th>Type</th>
					<th>Priority</th>
					<th>Status</th>
					<th>Last run</th>
					<th></th>
				</tr>
			</thead>
			<tbody>
				{#each filteredTests as t}
					<tr>
						<td>
							<!-- svelte-ignore a11y_invalid_attribute -->
							<a href="#" onclick={(e) => { e.preventDefault(); openTest(t.id); }}>{t.title}</a>
						</td>
						<td>{t.suite_name ?? '—'}</td>
						<td>
							{#if t.source === 'cucumber'}
								<span class="badge automated" title="Imported from {t.source_file}">
									{#if t.auto_last_status === 'passed'}
										<span class="dot pass"></span>
									{:else if t.auto_last_status === 'failed'}
										<span class="dot fail"></span>
									{:else}
										<span class="dot not-run"></span>
									{/if}
									Automated
								</span>
							{:else}
								<span class="badge manual">Manual</span>
							{/if}
						</td>
						<td><span class="priority priority-{t.priority}">{t.priority}</span></td>
						<td>
							{#if t.source === 'cucumber'}
								<span class={statusClass(t.auto_last_status ?? 'not_run')}>
									{(t.auto_last_status ?? 'not run').replace('_', ' ')}
								</span>
							{:else}
								<span class={statusClass(t.status)}>{t.status.replace('_', ' ')}</span>
							{/if}
						</td>
						<td>
							{#if t.source === 'cucumber'}
								{t.auto_last_run_at ? new Date(t.auto_last_run_at).toLocaleString() : '—'}
							{:else}
								{t.last_run_at ? new Date(t.last_run_at).toLocaleString() : '—'}
							{/if}
						</td>
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

				{#if selected.source === 'cucumber'}
					<div class="auto-banner" class:pass={selected.auto_last_status === 'passed'} class:fail={selected.auto_last_status === 'failed'}>
						<strong>✓ Covered by automation.</strong>
						You do not need to run this manually — it is executed on every CI run from
						<code>{selected.source_file}</code>.
						<div class="auto-banner-status">
							{autoStatusLabel(selected.auto_last_status)}
							{#if selected.auto_last_run_at}
								· {new Date(selected.auto_last_run_at).toLocaleString()}
							{/if}
						</div>
					</div>
				{/if}

				{#if selected.description}
					<p>{selected.description}</p>
				{/if}
				{#if selected.steps?.length}
					<div class="steps-header">
						<h3>Test steps</h3>
						{#if selected.source !== 'cucumber' && !runMode}
							<button class="btn-primary" onclick={startRunner}>▶ Run test</button>
						{/if}
					</div>

					{#if runMode}
						<table class="step-grid runner">
							<thead>
								<tr>
									<th class="col-num">#</th>
									<th class="col-action">Action</th>
									<th class="col-data">Data</th>
									<th class="col-expected">Expected</th>
									<th class="col-result">Result</th>
									<th class="col-comment">Comment</th>
								</tr>
							</thead>
							<tbody>
								{#each selected.steps as step, i}
									{@const s = typeof step === 'string' ? { action: step, data: '', expected: '' } : { action: step.action ?? '', data: (step as { data?: string }).data ?? '', expected: step.expected ?? '' }}
									<tr class={`runner-row runner-${stepRuns[i]?.status}`}>
										<td class="col-num">{i + 1}</td>
										<td>{s.action || '—'}</td>
										<td>{s.data || '—'}</td>
										<td>{s.expected || '—'}</td>
										<td class="col-result">
											<div class="result-buttons">
												{#each (['passed', 'failed', 'blocked', 'skipped'] as const) as opt}
													<button
														type="button"
														class="result-btn result-{opt}"
														class:active={stepRuns[i]?.status === opt}
														onclick={() => setStepStatus(i, opt)}
														title={opt}
													>
														{opt === 'passed' ? '✓' : opt === 'failed' ? '✕' : opt === 'blocked' ? '⊘' : '—'}
													</button>
												{/each}
											</div>
										</td>
										<td class="col-comment">
											<textarea
												rows="3"
												placeholder="Optional comment…"
												bind:value={stepRuns[i].comment}
											></textarea>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					{:else}
						<table class="step-grid readonly">
							<thead>
								<tr>
									<th class="col-num">#</th>
									<th class="col-action">Action</th>
									<th class="col-data">Data</th>
									<th class="col-expected">Expected result</th>
									{#if selected.last_step_results?.length}
										<th class="col-result">Last result</th>
										<th class="col-comment">Comment</th>
									{/if}
								</tr>
							</thead>
							<tbody>
								{#each selected.steps as step, i}
									{@const s = typeof step === 'string' ? { action: step, data: '', expected: '' } : { action: step.action ?? '', data: (step as { data?: string }).data ?? '', expected: step.expected ?? '' }}
									{@const sr = selected.last_step_results?.[i]}
									<tr>
										<td class="col-num">{i + 1}</td>
										<td>{s.action || '—'}</td>
										<td>{s.data || '—'}</td>
										<td>{s.expected || '—'}</td>
										{#if selected.last_step_results?.length}
											<td class="col-result">
												{#if sr}<span class={statusClass(sr.status)}>{sr.status}</span>{:else}—{/if}
											</td>
											<td class="col-comment">{sr?.comment || '—'}</td>
										{/if}
									</tr>
								{/each}
							</tbody>
						</table>
					{/if}
				{/if}

				{#if selected.expected_result}
					<h3>Overall expected result</h3>
					<p>{selected.expected_result}</p>
				{/if}
				{#if selected.last_run_at && !runMode}
					<p class="dim">
						Last run: <span class={statusClass(selected.status)}>{selected.status.replace('_', ' ')}</span>
						by {selected.last_run_by_email ?? '—'} at {new Date(selected.last_run_at).toLocaleString()}
					</p>
				{/if}

				{#if runMode}
					<label class="notes-label">
					Notes
					<textarea
						class="notes-area"
						bind:value={runNotes}
						onkeydown={handleNotesKey}
						rows="8"
						placeholder={"Overall notes — bullet lists auto-continue on Enter:\n- first observation\n- second observation"}
					></textarea>
				</label>
					<div class="runner-footer">
						<div class="derived">
							Overall: <span class={statusClass(derivedOverall)}>{derivedOverall.replace('_', ' ')}</span>
						</div>
						<div class="actions">
							<button class="btn-ghost" onclick={cancelRunner}>Cancel</button>
							<button class="btn-primary" onclick={saveRunnerResult}>Save run</button>
						</div>
					</div>
				{:else if selected.source !== 'cucumber'}
					<details class="quick-result">
						<summary>Record result without running</summary>
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
					</details>
				{/if}
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
	/* ── Xray-style create modal ─────────────────────────────────────── */
	/* Override the generic .modal (600px) with a wider, taller layout */
	.modal.create-modal {
		width: min(1100px, 95vw);
		max-width: 1100px;
		height: min(850px, 92vh);
		max-height: 92vh;
		padding: 0;
		gap: 0;
	}
	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1rem 1.25rem;
		border-bottom: 1px solid var(--border);
	}
	.modal-header h2 { margin: 0; font-size: 1.05rem; }
	.modal-body {
		padding: 1rem 1.25rem;
		overflow-y: auto;
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}
	.modal-footer {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		padding: 0.85rem 1.25rem;
		border-top: 1px solid var(--border);
		background: var(--bg-secondary);
	}
	.form-section { display: flex; flex-direction: column; gap: 0.5rem; }
	.form-section-header { display: flex; justify-content: space-between; align-items: center; }
	.form-section-title {
		margin: 0;
		font-size: 0.72rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-muted);
	}
	.form-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem 1rem;
	}
	.field { display: flex; flex-direction: column; gap: 0.25rem; }
	.field-wide { grid-column: 1 / -1; }
	.field-label { font-size: 0.75rem; color: var(--text-muted); font-weight: 500; }
	.req { color: var(--color-fail, #dc2626); }
	.field input, .field textarea, .field select {
		padding: 0.42rem 0.55rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg);
		color: var(--text);
		font-size: 0.88rem;
		font-family: inherit;
	}
	.field textarea { resize: vertical; }

	/* ── Step grid ───────────────────────────────────────────────────── */
	.step-grid {
		width: 100%;
		border-collapse: separate;
		border-spacing: 0;
		border: 1px solid var(--border);
		border-radius: 6px;
		overflow: hidden;
		font-size: 0.85rem;
	}
	.step-grid thead th {
		background: var(--bg-secondary);
		color: var(--text-muted);
		font-weight: 600;
		font-size: 0.68rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		text-align: left;
		padding: 0.5rem 0.65rem;
		border-bottom: 1px solid var(--border);
	}
	.step-grid tbody td {
		padding: 0.45rem 0.5rem;
		border-bottom: 1px solid var(--border);
		vertical-align: top;
	}
	.step-grid tbody tr:last-child td { border-bottom: none; }
	.step-grid .col-num {
		width: 36px;
		text-align: center;
		font-weight: 600;
		color: var(--text-muted);
		background: var(--bg-secondary);
	}
	.step-grid .col-action    { width: 32%; }
	.step-grid .col-data      { width: 24%; }
	.step-grid .col-expected  { width: 32%; }
	.step-grid .col-actions   { width: 92px; text-align: right; white-space: nowrap; }
	.step-grid textarea {
		width: 100%;
		padding: 0.35rem 0.45rem;
		border: 1px solid transparent;
		border-radius: 4px;
		background: transparent;
		color: var(--text);
		font-family: inherit;
		font-size: 0.82rem;
		resize: vertical;
	}
	.step-grid textarea:hover { border-color: var(--border); }
	.step-grid textarea:focus {
		outline: none;
		border-color: var(--link, #2563eb);
		background: var(--bg);
	}
	.step-grid.readonly td { color: var(--text); white-space: pre-wrap; }

	.icon-btn {
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 4px;
		width: 24px;
		height: 24px;
		padding: 0;
		font-size: 0.78rem;
		color: var(--text-muted);
		cursor: pointer;
		margin-left: 0.15rem;
		transition: all 0.1s;
	}
	.icon-btn:hover:not(:disabled) { background: var(--bg-hover); color: var(--text); }
	.icon-btn:disabled { opacity: 0.3; cursor: not-allowed; }
	.icon-btn.danger:hover:not(:disabled) { background: #fee2e2; color: #991b1b; border-color: #fca5a5; }

	.btn-small { font-size: 0.75rem; padding: 0.3rem 0.6rem; }
	.hint { font-size: 0.75rem; color: var(--text-muted); margin: 0.5rem 0 0; }
	.hint strong { color: var(--text-secondary); }
	.actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
	.btn-primary { background: var(--link, #2563eb); color: #fff; border: none; padding: 0.45rem 0.9rem; border-radius: 6px; cursor: pointer; font-size: 0.85rem; font-weight: 600; }
	.btn-ghost { background: transparent; color: var(--text-muted); border: 1px solid var(--border); padding: 0.35rem 0.7rem; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
	.toolbar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 0.75rem;
		flex-wrap: wrap;
	}
	.filter-tabs {
		display: flex;
		gap: 0.2rem;
		background: var(--bg-secondary);
		border-radius: 6px;
		padding: 0.2rem;
	}
	.filter-tab {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.35rem 0.65rem;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: var(--text-secondary);
		font-size: 0.78rem;
		cursor: pointer;
		transition: all 0.15s;
		white-space: nowrap;
	}
	.filter-tab:hover { color: var(--text); }
	.filter-tab.active {
		background: var(--bg);
		color: var(--text);
		font-weight: 600;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
	}
	.tab-count {
		font-size: 0.7rem;
		color: var(--text-muted);
		font-weight: 400;
	}
	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		display: inline-block;
	}
	.dot.pass    { background: var(--color-pass, #16a34a); }
	.dot.fail    { background: var(--color-fail, #dc2626); }
	.dot.skip    { background: var(--color-skip, #9ca3af); }
	.dot.blocked { background: #f59e0b; }
	.dot.not-run { background: #9ca3af; }

	.suite-filter {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.78rem;
		color: var(--text-muted);
	}
	.suite-filter select {
		padding: 0.35rem 0.55rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg);
		color: var(--text);
		font-size: 0.82rem;
	}
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
	.modal {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 1.5rem 1.75rem;
		width: min(1100px, 95vw);
		max-height: 92vh;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		box-sizing: border-box;
	}
	.modal header { display: flex; justify-content: space-between; align-items: center; }
	.modal h2 { margin: 0; }
	.modal h3 { margin: 0.5rem 0 0.25rem; font-size: 0.9rem; text-transform: uppercase; color: var(--text-muted); }
	.steps { margin: 0; padding-left: 1.25rem; }
	.modal label {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.8rem;
		color: var(--text-muted);
		width: 100%;
	}
	.modal input, .modal textarea, .modal select {
		padding: 0.55rem 0.7rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg);
		color: var(--text);
		font-size: 0.92rem;
		font-family: inherit;
		width: 100%;
		box-sizing: border-box;
	}
	.modal textarea { min-height: 4.5rem; resize: vertical; }
	.dim { color: var(--text-muted); font-size: 0.8rem; }
	.header-actions { display: flex; gap: 0.5rem; align-items: center; }
	.import-toast {
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.5rem 0.75rem;
		margin: 0 0 0.75rem;
		font-size: 0.82rem;
		color: var(--text);
	}
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.7rem;
		padding: 0.15rem 0.5rem;
		border-radius: 4px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.badge.manual    { background: #e5e7eb; color: #4b5563; }
	.badge.automated { background: #dbeafe; color: #1e40af; }
	.auto-banner {
		background: #eff6ff;
		border: 1px solid #bfdbfe;
		color: #1e3a8a;
		border-radius: 6px;
		padding: 0.6rem 0.8rem;
		font-size: 0.82rem;
		line-height: 1.4;
	}
	.auto-banner.pass { background: #ecfdf5; border-color: #a7f3d0; color: #065f46; }
	.auto-banner.fail { background: #fef2f2; border-color: #fecaca; color: #991b1b; }
	.auto-banner code {
		background: rgba(0, 0, 0, 0.05);
		padding: 0.05rem 0.3rem;
		border-radius: 3px;
		font-size: 0.78rem;
	}
	.auto-banner-status {
		margin-top: 0.3rem;
		font-size: 0.75rem;
		opacity: 0.85;
	}

	/* ── Step-by-step runner ──────────────────────────────────────────── */
	.steps-header { display: flex; justify-content: space-between; align-items: center; }
	.steps-header h3 { margin: 1rem 0 0.5rem; }
	.step-grid.runner .col-result { width: 160px; }
	.step-grid.runner .col-comment { min-width: 340px; }
	.step-grid.runner .col-comment textarea {
		width: 100%;
		min-height: 4.5rem;
		padding: 0.5rem 0.65rem;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--bg);
		color: var(--text);
		font-family: inherit;
		font-size: 0.88rem;
		resize: vertical;
		box-sizing: border-box;
	}
	.result-buttons { display: flex; gap: 0.25rem; }
	.result-btn {
		width: 28px; height: 28px;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--bg);
		color: var(--text-muted);
		font-weight: 700;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
	.result-btn:hover { border-color: var(--text-muted); }
	.result-btn.active.result-passed  { background: #16a34a; border-color: #16a34a; color: #fff; }
	.result-btn.active.result-failed  { background: #dc2626; border-color: #dc2626; color: #fff; }
	.result-btn.active.result-blocked { background: #d97706; border-color: #d97706; color: #fff; }
	.result-btn.active.result-skipped { background: #6b7280; border-color: #6b7280; color: #fff; }
	.runner-row.runner-failed  td { background: rgba(220, 38, 38, 0.06); }
	.runner-row.runner-blocked td { background: rgba(217, 119, 6, 0.06); }
	.runner-row.runner-skipped td { background: rgba(107, 114, 128, 0.06); }
	.runner-footer {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		margin-top: 0.75rem;
	}
	.runner-footer .derived { font-size: 0.88rem; color: var(--text-muted); }
	.notes-area {
		min-height: 10rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.88rem;
		line-height: 1.45;
	}
	.quick-result { margin-top: 1rem; }
	.quick-result summary { cursor: pointer; font-size: 0.85rem; color: var(--text-muted); }
	.quick-result summary:hover { color: var(--text); }
</style>
