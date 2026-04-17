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

	interface GroupSummary {
		id: number;
		name: string;
		description: string | null;
		test_count: number;
	}

	interface TestSession {
		id: number;
		session_number: number;
		label: string | null;
		mode: 'full' | 'failures_only';
		status: 'in_progress' | 'completed';
		created_at: string;
		completed_at: string | null;
		created_by_email: string | null;
		total: number;
		passed: number;
		failed: number;
		blocked: number;
		skipped: number;
		not_run: number;
		accepted: number;
	}

	interface SessionResult {
		id: number;
		manual_test_id: number;
		status: 'not_run' | 'passed' | 'failed' | 'blocked' | 'skipped';
		notes: string | null;
		step_results: unknown[];
		run_at: string | null;
		run_by_email: string | null;
		accepted_as_known_issue: boolean;
		known_issue_ref: string | null;
		accepted_at: string | null;
		accepted_by_email: string | null;
		title: string;
		suite_name: string | null;
		priority: string;
		group_id: number | null;
		group_name: string | null;
	}

	interface SessionDetail {
		id: number;
		release_id: number;
		session_number: number;
		label: string | null;
		mode: 'full' | 'failures_only';
		status: 'in_progress' | 'completed';
		created_at: string;
		completed_at: string | null;
		created_by_email: string | null;
		results: SessionResult[];
	}

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

	// Groups — for the "Add by Group" picker
	let availableGroups = $state<GroupSummary[]>([]);
	let groupPickerOpen = $state(false);
	let groupLinkMessage = $state<string | null>(null);

	// Sessions. sessionDetails is keyed by session id so past-session expansion
	// can reuse a once-loaded result set instead of refetching on every open.
	let sessions = $state<TestSession[]>([]);
	let sessionDetails = $state<Record<number, SessionDetail>>({});
	let sessionsLoading = $state(false);
	let newSessionMode = $state<'full' | 'failures_only'>('full');
	let newSessionLabel = $state('');
	let showNewSessionForm = $state(false);
	let sessionError = $state<string | null>(null);
	let expandedSessionId = $state<number | null>(null);

	// Per-row runner state
	let runnerTestId = $state<number | null>(null);
	let runnerStatus = $state<'passed' | 'failed' | 'blocked' | 'skipped'>('passed');
	let runnerNotes = $state('');
	let runnerAcceptKnown = $state(false);
	let runnerKnownRef = $state('');

	// "Accept as known issue" dialog (triggered from a row's Accept button —
	// separate from the runner, for deferring an already-recorded failure).
	let acceptTargetTestId = $state<number | null>(null);
	let acceptKnownRef = $state('');

	// Generic confirm / alert modal. Resolved when the user clicks one of
	// the buttons, so callers can `await openConfirm(...)` just like the
	// native confirm() they're replacing.
	interface ConfirmState {
		title: string;
		message: string;
		confirmLabel: string;
		cancelLabel: string | null;  // null = alert-style (OK only)
		tone: 'default' | 'danger';
		resolve: (result: boolean) => void;
	}
	let confirmState = $state<ConfirmState | null>(null);

	function openConfirm(opts: {
		title: string;
		message: string;
		confirmLabel?: string;
		cancelLabel?: string | null;
		tone?: 'default' | 'danger';
	}): Promise<boolean> {
		return new Promise((resolve) => {
			confirmState = {
				title: opts.title,
				message: opts.message,
				confirmLabel: opts.confirmLabel ?? 'Confirm',
				cancelLabel: opts.cancelLabel === null ? null : (opts.cancelLabel ?? 'Cancel'),
				tone: opts.tone ?? 'default',
				resolve,
			};
		});
	}

	function resolveConfirm(result: boolean) {
		if (!confirmState) return;
		const { resolve } = confirmState;
		confirmState = null;
		resolve(result);
	}

	const inProgressSession = $derived(sessions.find(s => s.status === 'in_progress') ?? null);
	const activeSessionDetail = $derived(
		inProgressSession ? sessionDetails[inProgressSession.id] ?? null : null
	);

	// Failures currently blocking the release — from the active session if
	// one exists, otherwise from the most recent completed session.
	const readinessSession = $derived(
		inProgressSession
			? sessions.find(s => s.id === inProgressSession.id) ?? null
			: sessions.find(s => s.status === 'completed') ?? null
	);
	const readinessSessionDetail = $derived(
		readinessSession ? sessionDetails[readinessSession.id] ?? null : null
	);
	const blockingFailures = $derived(
		(readinessSessionDetail?.results ?? []).filter(
			r => (r.status === 'failed' || r.status === 'blocked') && !r.accepted_as_known_issue
		)
	);
	const acceptedFailures = $derived(
		(readinessSessionDetail?.results ?? []).filter(r => r.accepted_as_known_issue)
	);

	onMount(load);

	async function load() {
		loading = true;
		error = null;
		try {
			const [rRes, readyRes, sRes] = await Promise.all([
				authFetch(`${API_URL}/releases/${releaseId}`),
				authFetch(`${API_URL}/releases/${releaseId}/readiness`),
				authFetch(`${API_URL}/releases/${releaseId}/sessions`),
			]);
			if (!rRes.ok) throw new Error('Failed to load release');
			release = await rRes.json();
			readiness = readyRes.ok ? await readyRes.json() : null;
			sessions = sRes.ok ? await sRes.json() : [];

			// Detail for the "active" session drives the readiness failure
			// list + the primary execution panel. Fall back to the most recent
			// completed session when nothing is in progress.
			sessionDetails = {};
			const target = sessions.find(s => s.status === 'in_progress')
				?? sessions.find(s => s.status === 'completed');
			if (target) {
				await loadSessionDetail(target.id);
				expandedSessionId = target.id;
			}
		} catch (err) {
			error = (err as Error).message;
		} finally {
			loading = false;
		}
		// Load Jira state in the background; don't block the page on a
		// slow/flaky Jira instance.
		loadJira();
	}

	async function loadSessionDetail(sessionId: number) {
		sessionsLoading = true;
		try {
			const res = await authFetch(`${API_URL}/releases/${releaseId}/sessions/${sessionId}`);
			if (res.ok) {
				const detail = await res.json() as SessionDetail;
				sessionDetails = { ...sessionDetails, [sessionId]: detail };
			}
		} finally {
			sessionsLoading = false;
		}
	}

	async function toggleSessionExpanded(sessionId: number) {
		if (expandedSessionId === sessionId) {
			expandedSessionId = null;
			return;
		}
		expandedSessionId = sessionId;
		if (!sessionDetails[sessionId]) await loadSessionDetail(sessionId);
	}

	// Scroll a failing-test reference in the readiness panel to its row in
	// the active session table and briefly highlight it.
	function scrollToTestRow(testId: number) {
		const el = document.getElementById(`session-row-${testId}`);
		if (!el) return;
		el.scrollIntoView({ behavior: 'smooth', block: 'center' });
		el.classList.add('row-flash');
		setTimeout(() => el.classList.remove('row-flash'), 1600);
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

	// ── Add by group ─────────────────────────────────────────────────────
	async function openGroupPicker() {
		groupPickerOpen = true;
		groupLinkMessage = null;
		const res = await authFetch(`${API_URL}/manual-test-groups`);
		if (res.ok) availableGroups = await res.json();
	}

	async function linkGroup(groupId: number) {
		const res = await authFetch(
			`${API_URL}/releases/${releaseId}/manual-test-groups/${groupId}`,
			{ method: 'POST' }
		);
		if (res.ok) {
			const body = await res.json() as { linked: number; total_in_group: number };
			groupLinkMessage = `Linked ${body.linked} new test(s) (${body.total_in_group} total in group).`;
			await load();
		} else {
			const body = await res.json().catch(() => ({}));
			groupLinkMessage = (body as { error?: string }).error ?? 'Failed to link group';
		}
	}

	// ── Test sessions ────────────────────────────────────────────────────
	async function createSession() {
		sessionError = null;
		const res = await authFetch(`${API_URL}/releases/${releaseId}/sessions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				mode: newSessionMode,
				label: newSessionLabel.trim() || null,
			}),
		});
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			sessionError = (body as { error?: string }).error ?? 'Failed to create session';
			return;
		}
		newSessionLabel = '';
		newSessionMode = 'full';
		showNewSessionForm = false;
		await load();
	}

	async function completeSession(sessionId: number) {
		const ok = await openConfirm({
			title: 'Complete session?',
			message: 'Mark this session as complete? You will not be able to record more results against it.',
			confirmLabel: 'Complete session',
		});
		if (!ok) return;
		await authFetch(`${API_URL}/releases/${releaseId}/sessions/${sessionId}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'completed' }),
		});
		await load();
	}

	function openRunner(testId: number) {
		runnerTestId = testId;
		runnerStatus = 'passed';
		runnerNotes = '';
		runnerAcceptKnown = false;
		runnerKnownRef = '';
	}

	function closeRunner() {
		runnerTestId = null;
		runnerNotes = '';
		runnerAcceptKnown = false;
		runnerKnownRef = '';
	}

	async function saveRunnerResult() {
		if (!activeSessionDetail || runnerTestId === null) return;
		const sessionId = activeSessionDetail.id;
		const testId = runnerTestId;
		const res = await authFetch(
			`${API_URL}/releases/${releaseId}/sessions/${sessionId}/results/${testId}`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					status: runnerStatus,
					notes: runnerNotes || null,
				}),
			}
		);
		if (!res.ok) return;

		// If the user ticked "record and defer", chain the accept call so
		// the result lands with known_issue_ref in a single UX motion.
		if (runnerAcceptKnown && (runnerStatus === 'failed' || runnerStatus === 'blocked')) {
			await authFetch(
				`${API_URL}/releases/${releaseId}/sessions/${sessionId}/results/${testId}/accept`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ known_issue_ref: runnerKnownRef || null }),
				}
			);
		}
		closeRunner();
		await load();
	}

	// ── Accept / revoke known-issue on an already-recorded result ────────
	function openAcceptDialog(testId: number) {
		acceptTargetTestId = testId;
		acceptKnownRef = '';
	}

	function closeAcceptDialog() {
		acceptTargetTestId = null;
		acceptKnownRef = '';
	}

	async function confirmAccept() {
		if (!activeSessionDetail || acceptTargetTestId === null) return;
		const res = await authFetch(
			`${API_URL}/releases/${releaseId}/sessions/${activeSessionDetail.id}/results/${acceptTargetTestId}/accept`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ known_issue_ref: acceptKnownRef || null }),
			}
		);
		closeAcceptDialog();
		if (res.ok) await load();
	}

	async function revokeAcceptance(sessionId: number, testId: number) {
		const ok = await openConfirm({
			title: 'Revoke acceptance?',
			message: 'This test will start blocking the release again and will be included in the next failures-only rerun.',
			confirmLabel: 'Revoke',
			tone: 'danger',
		});
		if (!ok) return;
		await authFetch(
			`${API_URL}/releases/${releaseId}/sessions/${sessionId}/results/${testId}/accept`,
			{ method: 'DELETE' }
		);
		await load();
	}

	// Heuristic: treat a ref containing "://" as a URL — render as a link.
	function isRefUrl(ref: string | null): boolean {
		return !!ref && /:\/\//.test(ref);
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
			await openConfirm({
				title: 'Sign-off failed',
				message: data.error ?? 'Sign-off failed',
				confirmLabel: 'OK',
				cancelLabel: null,
				tone: 'danger',
			});
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

				{#if blockingFailures.length > 0}
					<details class="readiness-failures" open>
						<summary>
							<span class="failure-count">{blockingFailures.length}</span>
							test{blockingFailures.length === 1 ? '' : 's'} blocking this release
							— click to jump to the active session
						</summary>
						<ul class="failure-links">
							{#each blockingFailures as r}
								<li>
									<button
										type="button"
										class="failure-link"
										onclick={() => scrollToTestRow(r.manual_test_id)}
									>
										<span class={`status-pill status-${r.status.replace('_','-')}`}>
											{r.status}
										</span>
										<strong>{r.title}</strong>
										<span class="dim">
											{r.group_name ? `${r.group_name} · ` : ''}{r.priority}
										</span>
									</button>
								</li>
							{/each}
						</ul>
					</details>
				{/if}

				{#if acceptedFailures.length > 0}
					<details class="readiness-accepted">
						<summary>
							<span class="accepted-count">{acceptedFailures.length}</span>
							known issue{acceptedFailures.length === 1 ? '' : 's'} deferred to a later release
						</summary>
						<ul class="failure-links">
							{#each acceptedFailures as r}
								<li>
									<button
										type="button"
										class="failure-link"
										onclick={() => scrollToTestRow(r.manual_test_id)}
									>
										<span class="status-pill status-accepted">known</span>
										<strong>{r.title}</strong>
										{#if r.known_issue_ref}
											{#if isRefUrl(r.known_issue_ref)}
												<a href={r.known_issue_ref} target="_blank" rel="noopener" class="known-ref">
													{r.known_issue_ref}
												</a>
											{:else}
												<span class="known-ref">{r.known_issue_ref}</span>
											{/if}
										{/if}
									</button>
								</li>
							{/each}
						</ul>
					</details>
				{/if}
			</section>
		{/if}

		<!-- ── Active session (primary execution panel) ─────────────────── -->
		<section class="active-session-panel">
			<details open>
				<summary class="active-session-summary">
					<div class="summary-left">
						<h2>
							{#if inProgressSession}
								Active session · #{inProgressSession.session_number}
							{:else}
								Test execution
							{/if}
						</h2>
						{#if inProgressSession}
							<span class="mode-badge mode-{inProgressSession.mode}">
								{inProgressSession.mode === 'full' ? 'Full' : 'Rerun failures'}
							</span>
							<span class="status-pill status-in_progress">In progress</span>
						{/if}
					</div>
					<div class="summary-right">
						{#if inProgressSession}
							<span class="dim">
								{inProgressSession.passed}p · {inProgressSession.failed}f · {inProgressSession.not_run} not run
							</span>
						{:else}
							<span class="dim">No session in progress</span>
						{/if}
					</div>
				</summary>

				<div class="section-body">
					{#if inProgressSession}
						<div class="active-session-toolbar">
							{#if inProgressSession.label}
								<div class="session-label">{inProgressSession.label}</div>
							{/if}
							<div class="progress-bar full">
								{#if inProgressSession.total > 0}
									<div class="pb-passed"  style="width: {(inProgressSession.passed / inProgressSession.total) * 100}%"></div>
									<div class="pb-failed"  style="width: {(inProgressSession.failed / inProgressSession.total) * 100}%"></div>
									<div class="pb-blocked" style="width: {(inProgressSession.blocked / inProgressSession.total) * 100}%"></div>
									<div class="pb-skipped" style="width: {(inProgressSession.skipped / inProgressSession.total) * 100}%"></div>
								{/if}
							</div>
							<div class="actions">
								<button class="btn-ghost" onclick={() => completeSession(inProgressSession!.id)}>
									Mark session complete
								</button>
							</div>
						</div>

						{#if sessionsLoading && !activeSessionDetail}
							<p class="empty">Loading…</p>
						{:else if activeSessionDetail && activeSessionDetail.results.length > 0}
							<table class="session-table">
								<thead>
									<tr>
										<th>Title</th>
										<th>Group</th>
										<th>Priority</th>
										<th>Status</th>
										<th>Last run by</th>
										<th></th>
									</tr>
								</thead>
								<tbody>
									{#each activeSessionDetail.results as r}
										<tr
											id={`session-row-${r.manual_test_id}`}
											class:accepted={r.accepted_as_known_issue}
										>
											<td>
												<strong>{r.title}</strong>
												{#if r.accepted_as_known_issue}
													<div class="known-issue-inline">
														<span class="status-pill status-accepted">known issue</span>
														{#if r.known_issue_ref}
															{#if isRefUrl(r.known_issue_ref)}
																<a href={r.known_issue_ref} target="_blank" rel="noopener" class="known-ref">
																	{r.known_issue_ref}
																</a>
															{:else}
																<span class="known-ref">{r.known_issue_ref}</span>
															{/if}
														{/if}
														<button
															class="link-button"
															onclick={() => revokeAcceptance(activeSessionDetail!.id, r.manual_test_id)}
															title="Revoke acceptance"
														>revoke</button>
													</div>
												{/if}
												{#if r.notes}
													<div class="result-notes">{r.notes}</div>
												{/if}
											</td>
											<td>{r.group_name ?? '—'}</td>
											<td><span class="priority priority-{r.priority}">{r.priority}</span></td>
											<td>
												<span class={`status-pill status-${r.status.replace('_', '-')}`}>
													{r.status.replace('_', ' ')}
												</span>
											</td>
											<td class="dim">
												{#if r.run_at}
													{r.run_by_email ?? '—'}
													<br /><span class="dim small">{new Date(r.run_at).toLocaleString()}</span>
												{:else}
													—
												{/if}
											</td>
											<td class="row-actions">
												<button class="btn-ghost btn-small" onclick={() => openRunner(r.manual_test_id)}>
													Record
												</button>
												{#if (r.status === 'failed' || r.status === 'blocked') && !r.accepted_as_known_issue}
													<button
														class="btn-ghost btn-small accept-btn"
														onclick={() => openAcceptDialog(r.manual_test_id)}
														title="Defer as known issue"
													>
														Accept
													</button>
												{/if}
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						{:else if activeSessionDetail}
							<p class="empty">No tests in this session.</p>
						{/if}
					{:else}
						<!-- No active session — offer to start one -->
						<p class="empty">No session currently in progress.</p>
						{#if !showNewSessionForm}
							<button class="btn-primary" onclick={() => (showNewSessionForm = true)}>
								+ Start new session
							</button>
						{:else}
							<div class="new-session-form">
								<label class="field">
									<span class="field-label">Label (optional)</span>
									<input bind:value={newSessionLabel} placeholder="e.g. Release candidate sanity pass" />
								</label>
								<label class="field">
									<span class="field-label">Mode</span>
									<select bind:value={newSessionMode}>
										<option value="full">Full run — all linked tests</option>
										<option value="failures_only">Rerun failures — unaccepted failed/blocked from latest session</option>
									</select>
								</label>
								{#if sessionError}<p class="error inline">{sessionError}</p>{/if}
								<div class="actions">
									<button class="btn-ghost" onclick={() => (showNewSessionForm = false)}>Cancel</button>
									<button class="btn-primary" onclick={createSession}>Start session</button>
								</div>
							</div>
						{/if}
					{/if}
				</div>
			</details>
		</section>

		<!-- ── Session history (collapsible; each session expandable) ───── -->
		{#if sessions.length > 0}
			<section class="session-history-panel">
				<details>
					<summary>
						<div class="summary-left">
							<h2>Session history</h2>
							<span class="dim">{sessions.length} session{sessions.length === 1 ? '' : 's'}</span>
						</div>
						<span class="summary-right dim">click to expand</span>
					</summary>

					<ul class="session-list">
						{#each sessions as s}
							<li class="session-card" class:in-progress={s.status === 'in_progress'}>
								<!-- svelte-ignore a11y_click_events_have_key_events -->
								<!-- svelte-ignore a11y_no_static_element_interactions -->
								<div class="session-head" onclick={() => toggleSessionExpanded(s.id)}>
									<div>
										<strong>Session #{s.session_number}</strong>
										{#if s.label}<span class="session-label"> — {s.label}</span>{/if}
										<span class="mode-badge mode-{s.mode}">
											{s.mode === 'full' ? 'Full' : 'Rerun failures'}
										</span>
										<span class={`status-pill status-${s.status}`}>
											{s.status === 'in_progress' ? 'In progress' : 'Completed'}
										</span>
										{#if s.accepted > 0}
											<span class="status-pill status-accepted">{s.accepted} accepted</span>
										{/if}
									</div>
									<span class="dim">{new Date(s.created_at).toLocaleString()} · {expandedSessionId === s.id ? '▼' : '▶'}</span>
								</div>
								<div class="progress-bar">
									{#if s.total > 0}
										<div class="pb-passed"  style="width: {(s.passed / s.total) * 100}%"></div>
										<div class="pb-failed"  style="width: {(s.failed / s.total) * 100}%"></div>
										<div class="pb-blocked" style="width: {(s.blocked / s.total) * 100}%"></div>
										<div class="pb-skipped" style="width: {(s.skipped / s.total) * 100}%"></div>
									{/if}
								</div>
								<div class="session-counts">
									<span><span class="pass">{s.passed}</span> passed</span>
									<span><span class="fail">{s.failed}</span> failed</span>
									<span>{s.blocked} blocked</span>
									<span>{s.skipped} skipped</span>
									<span>{s.not_run} not run</span>
									<span class="dim">({s.total} total)</span>
								</div>

								{#if expandedSessionId === s.id}
									{@const detail = sessionDetails[s.id]}
									{#if !detail}
										<p class="empty">Loading…</p>
									{:else}
										<table class="session-table nested">
											<thead>
												<tr>
													<th>Title</th>
													<th>Group</th>
													<th>Status</th>
													<th>Notes</th>
													<th>Run by</th>
												</tr>
											</thead>
											<tbody>
												{#each detail.results as r}
													<tr class:accepted={r.accepted_as_known_issue}>
														<td><strong>{r.title}</strong></td>
														<td>{r.group_name ?? '—'}</td>
														<td>
															<span class={`status-pill status-${r.status.replace('_', '-')}`}>
																{r.status.replace('_', ' ')}
															</span>
															{#if r.accepted_as_known_issue}
																<span class="status-pill status-accepted">known</span>
																{#if r.known_issue_ref}
																	{#if isRefUrl(r.known_issue_ref)}
																		<a href={r.known_issue_ref} target="_blank" rel="noopener" class="known-ref">{r.known_issue_ref}</a>
																	{:else}
																		<span class="known-ref">{r.known_issue_ref}</span>
																	{/if}
																{/if}
															{/if}
														</td>
														<td class="notes-cell">{r.notes ?? '—'}</td>
														<td class="dim">
															{#if r.run_at}
																{r.run_by_email ?? '—'}<br />
																<span class="dim small">{new Date(r.run_at).toLocaleString()}</span>
															{:else}
																—
															{/if}
														</td>
													</tr>
												{/each}
											</tbody>
										</table>
									{/if}
								{/if}
							</li>
						{/each}
					</ul>
				</details>
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

		<section class="linked-tests-panel">
			<details>
				<summary>
					<div class="summary-left">
						<h2>Linked manual tests</h2>
						<span class="dim">{release.linked_manual_tests.length} test{release.linked_manual_tests.length === 1 ? '' : 's'}</span>
					</div>
					<div class="summary-right">
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<span
							class="btn-ghost"
							role="button"
							tabindex="0"
							onclick={(e) => { e.preventDefault(); e.stopPropagation(); openGroupPicker(); }}
						>+ Add by group</span>
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<span
							class="btn-ghost"
							role="button"
							tabindex="0"
							onclick={(e) => { e.preventDefault(); e.stopPropagation(); openManualTestPicker(); }}
						>+ Link tests</span>
					</div>
				</summary>
			<div class="section-body">
			{#if groupLinkMessage}
				<p class="import-toast">{groupLinkMessage}</p>
			{/if}

			{#if groupPickerOpen}
				<div class="picker">
					<div class="picker-header">
						<strong>Pick a group to bulk-link</strong>
						<button class="btn-ghost" onclick={() => (groupPickerOpen = false)}>Close</button>
					</div>
					<ul class="picker-list">
						{#each availableGroups as g}
							<li>
								<button type="button" class="picker-row" onclick={() => linkGroup(g.id)}>
									<strong>{g.name}</strong>
									<span class="dim">{g.description ?? '—'}</span>
									<span class="mini-stats">{g.test_count} tests</span>
								</button>
							</li>
						{:else}
							<li class="empty">No groups defined yet.</li>
						{/each}
					</ul>
				</div>
			{/if}
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
			</div>
			</details>
		</section>


		{#if runnerTestId !== null}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="modal-overlay" onclick={closeRunner}>
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="runner-modal" onclick={(e) => e.stopPropagation()}>
					<h3>Record result</h3>
					<label class="field">
						<span class="field-label">Status</span>
						<select bind:value={runnerStatus}>
							<option value="passed">Passed</option>
							<option value="failed">Failed</option>
							<option value="blocked">Blocked</option>
							<option value="skipped">Skipped</option>
						</select>
					</label>
					<label class="field">
						<span class="field-label">Notes</span>
						<textarea bind:value={runnerNotes} rows="4" placeholder="Optional"></textarea>
					</label>
					{#if runnerStatus === 'failed' || runnerStatus === 'blocked'}
						<label class="checkbox-field">
							<input type="checkbox" bind:checked={runnerAcceptKnown} />
							Accept as known issue — don't block this release
						</label>
						{#if runnerAcceptKnown}
							<label class="field">
								<span class="field-label">Bug reference (optional)</span>
								<input bind:value={runnerKnownRef} placeholder="ABC-123 or https://…" />
							</label>
						{/if}
					{/if}
					<div class="actions">
						<button class="btn-ghost" onclick={closeRunner}>Cancel</button>
						<button class="btn-primary" onclick={saveRunnerResult}>Save</button>
					</div>
				</div>
			</div>
		{/if}

		{#if acceptTargetTestId !== null}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="modal-overlay" onclick={closeAcceptDialog}>
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="runner-modal" onclick={(e) => e.stopPropagation()}>
					<h3>Accept as known issue</h3>
					<p class="dim">
						This test will stop blocking the release and will be excluded from
						failures-only reruns. The bug reference stays associated with the test
						for future releases.
					</p>
					<label class="field">
						<span class="field-label">Bug reference (optional)</span>
						<input bind:value={acceptKnownRef} placeholder="ABC-123 or https://…" />
					</label>
					<div class="actions">
						<button class="btn-ghost" onclick={closeAcceptDialog}>Cancel</button>
						<button class="btn-primary" onclick={confirmAccept}>Accept</button>
					</div>
				</div>
			</div>
		{/if}

		{#if confirmState}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="modal-overlay"
				onclick={() => resolveConfirm(false)}
			>
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="runner-modal confirm-modal" onclick={(e) => e.stopPropagation()}>
					<h3>{confirmState.title}</h3>
					<p>{confirmState.message}</p>
					<div class="actions">
						{#if confirmState.cancelLabel !== null}
							<button class="btn-ghost" onclick={() => resolveConfirm(false)}>
								{confirmState.cancelLabel}
							</button>
						{/if}
						<button
							class="btn-primary"
							class:btn-danger={confirmState.tone === 'danger'}
							onclick={() => resolveConfirm(true)}
						>
							{confirmState.confirmLabel}
						</button>
					</div>
				</div>
			</div>
		{/if}

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

	/* ── Sessions ────────────────────────────────────────────────────── */
	.header-actions { display: flex; gap: 0.4rem; }
	.import-toast {
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.4rem 0.65rem;
		margin: 0 0 0.6rem;
		font-size: 0.82rem;
		color: var(--text);
	}
	.new-session-form {
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.75rem;
		margin-bottom: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.new-session-form .field { display: flex; flex-direction: column; gap: 0.25rem; }
	.new-session-form .field-label { font-size: 0.72rem; text-transform: uppercase; color: var(--text-muted); font-weight: 600; letter-spacing: 0.04em; }
	.new-session-form input, .new-session-form select {
		padding: 0.4rem 0.55rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg);
		color: var(--text);
		font-size: 0.85rem;
	}
	.new-session-form .actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
	.error.inline { padding: 0.35rem 0.5rem; color: #991b1b; font-size: 0.82rem; background: #fef2f2; border: 1px solid #fecaca; border-radius: 4px; }

	.session-list { list-style: none; padding: 0; margin: 0 0 1rem; display: flex; flex-direction: column; gap: 0.5rem; }
	.session-card {
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.6rem 0.75rem;
		background: var(--bg-secondary);
	}
	.session-card.in-progress { border-left: 3px solid #2563eb; background: #eff6ff; }
	.session-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.4rem;
		flex-wrap: wrap;
		font-size: 0.85rem;
	}
	.session-label { color: var(--text-muted); }
	.mode-badge {
		font-size: 0.65rem;
		padding: 0.1rem 0.4rem;
		border-radius: 4px;
		text-transform: uppercase;
		font-weight: 600;
		margin-left: 0.4rem;
	}
	.mode-full { background: #dbeafe; color: #1e40af; }
	.mode-failures_only { background: #fef3c7; color: #92400e; }
	.status-pill {
		font-size: 0.65rem;
		padding: 0.1rem 0.4rem;
		border-radius: 4px;
		text-transform: uppercase;
		font-weight: 600;
		margin-left: 0.4rem;
	}
	.status-pill.status-in_progress { background: #dbeafe; color: #1e40af; }
	.status-pill.status-completed   { background: #dcfce7; color: #166534; }
	.status-pill.status-passed  { background: #dcfce7; color: #166534; }
	.status-pill.status-failed  { background: #fee2e2; color: #991b1b; }
	.status-pill.status-blocked { background: #fef3c7; color: #92400e; }
	.status-pill.status-skipped { background: #e5e7eb; color: #4b5563; }
	.status-pill.status-not-run { background: #e5e7eb; color: #4b5563; }

	.progress-bar {
		display: flex;
		height: 6px;
		background: #e5e7eb;
		border-radius: 3px;
		overflow: hidden;
		margin-bottom: 0.35rem;
	}
	.pb-passed { background: #16a34a; }
	.pb-failed { background: #dc2626; }
	.pb-blocked { background: #f59e0b; }
	.pb-skipped { background: #9ca3af; }

	.session-counts {
		display: flex;
		gap: 0.75rem;
		font-size: 0.78rem;
		color: var(--text-muted);
		flex-wrap: wrap;
	}
	.session-counts .pass { color: #16a34a; font-weight: 600; }
	.session-counts .fail { color: #dc2626; font-weight: 600; }

	.active-session { margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--border); }
	.active-session h3 { margin: 0; font-size: 0.95rem; }
	.session-table {
		width: 100%;
		border-collapse: collapse;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 6px;
		overflow: hidden;
		margin-top: 0.5rem;
	}
	.session-table th, .session-table td {
		padding: 0.45rem 0.65rem;
		text-align: left;
		font-size: 0.82rem;
		border-bottom: 1px solid var(--border);
	}
	.session-table th {
		background: var(--bg-secondary);
		color: var(--text-muted);
		font-weight: 600;
		font-size: 0.68rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.session-table tr:last-child td { border-bottom: none; }
	.priority { font-size: 0.65rem; padding: 0.1rem 0.4rem; border-radius: 4px; text-transform: uppercase; font-weight: 600; }
	.priority-low { background: #e5e7eb; color: #4b5563; }
	.priority-medium { background: #dbeafe; color: #1e40af; }
	.priority-high { background: #fef3c7; color: #92400e; }
	.priority-critical { background: #fee2e2; color: #991b1b; }
	.dim.small { font-size: 0.7rem; }
	.btn-small { font-size: 0.72rem; padding: 0.25rem 0.55rem; }

	/* ── Runner modal ────────────────────────────────────────────────── */
	.modal-overlay {
		position: fixed; inset: 0;
		background: rgba(0, 0, 0, 0.4);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 300;
	}
	.runner-modal {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 1.25rem 1.5rem;
		width: min(480px, 95vw);
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.runner-modal h3 { margin: 0 0 0.25rem; font-size: 1rem; }
	.runner-modal .field { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.8rem; color: var(--text-muted); }
	.runner-modal .field-label { font-weight: 500; }
	.runner-modal input, .runner-modal select, .runner-modal textarea {
		padding: 0.45rem 0.6rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg);
		color: var(--text);
		font-size: 0.88rem;
		font-family: inherit;
	}
	.runner-modal .actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.25rem; }

	/* ── Collapsible panels (active session, history, linked tests) ─── */
	.active-session-panel details,
	.session-history-panel details,
	.linked-tests-panel details {
		padding: 0;
	}
	.active-session-panel summary,
	.session-history-panel summary,
	.linked-tests-panel summary {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.85rem 1.25rem;
		cursor: pointer;
		list-style: none;
		gap: 0.75rem;
	}
	.active-session-panel summary::-webkit-details-marker,
	.session-history-panel summary::-webkit-details-marker,
	.linked-tests-panel summary::-webkit-details-marker { display: none; }
	.active-session-panel summary h2,
	.session-history-panel summary h2,
	.linked-tests-panel summary h2 {
		margin: 0;
		font-size: 1rem;
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
	}
	.summary-left  { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
	.summary-right { display: flex; align-items: center; gap: 0.35rem; }
	.section-body  { padding: 0 1.25rem 1rem; }
	.active-session-panel summary::before,
	.session-history-panel summary::before,
	.linked-tests-panel summary::before {
		content: "▶";
		font-size: 0.7rem;
		color: var(--text-muted);
		margin-right: 0.1rem;
		transition: transform 0.15s;
	}
	.active-session-panel details[open] > summary::before,
	.session-history-panel details[open] > summary::before,
	.linked-tests-panel details[open] > summary::before { transform: rotate(90deg); }

	.active-session-panel { border-left: 3px solid #2563eb; }
	.active-session-toolbar {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 0.6rem;
		flex-wrap: wrap;
	}
	.active-session-toolbar .session-label { font-size: 0.9rem; color: var(--text-muted); }
	.active-session-toolbar .progress-bar.full { flex: 1; min-width: 240px; height: 8px; }
	.active-session-toolbar .actions { margin-left: auto; }

	/* ── Readiness failures list ─────────────────────────────────────── */
	.readiness-failures, .readiness-accepted {
		margin-top: 0.75rem;
		background: #fef2f2;
		border: 1px solid #fecaca;
		border-radius: 6px;
		padding: 0.5rem 0.75rem;
	}
	.readiness-accepted { background: #f0f9ff; border-color: #bae6fd; }
	.readiness-failures summary,
	.readiness-accepted summary {
		cursor: pointer;
		font-size: 0.85rem;
		font-weight: 600;
		color: #991b1b;
	}
	.readiness-accepted summary { color: #075985; }
	.failure-count { background: #fee2e2; color: #991b1b; padding: 0.05rem 0.45rem; border-radius: 4px; margin-right: 0.25rem; }
	.accepted-count { background: #dbeafe; color: #1e40af; padding: 0.05rem 0.45rem; border-radius: 4px; margin-right: 0.25rem; }
	.failure-links { list-style: none; padding: 0.5rem 0 0; margin: 0; display: flex; flex-direction: column; gap: 0.3rem; }
	.failure-links li { padding: 0; }
	.failure-link {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.35rem 0.5rem;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 5px;
		cursor: pointer;
		width: 100%;
		text-align: left;
		font-size: 0.85rem;
		color: var(--text);
	}
	.failure-link:hover { background: var(--bg-secondary); border-color: var(--text-muted); }
	.known-ref {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.78rem;
		color: #2563eb;
		text-decoration: none;
	}
	.known-ref:hover { text-decoration: underline; }

	/* ── Active session table extras ─────────────────────────────────── */
	.status-pill.status-accepted { background: #dbeafe; color: #1e40af; }
	.session-table tr.accepted { background: #eff6ff; }
	.session-table tr.row-flash {
		animation: row-flash 1.6s ease-out;
	}
	@keyframes row-flash {
		0%   { background: #fef08a; }
		50%  { background: #fef9c3; }
		100% { background: inherit; }
	}
	.session-table .row-actions { display: flex; gap: 0.25rem; }
	.session-table .accept-btn { color: #0369a1; }
	.known-issue-inline {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		margin-top: 0.2rem;
		font-size: 0.78rem;
	}
	.result-notes {
		margin-top: 0.2rem;
		font-size: 0.78rem;
		color: var(--text-muted);
		white-space: pre-wrap;
	}
	.link-button {
		background: transparent;
		border: none;
		color: var(--text-muted);
		text-decoration: underline;
		cursor: pointer;
		font-size: 0.78rem;
		padding: 0;
	}
	.link-button:hover { color: var(--text); }

	/* ── Session history nested table ───────────────────────────────── */
	.session-card .session-head { cursor: pointer; }
	.session-table.nested {
		margin-top: 0.5rem;
		border: 1px solid var(--border);
	}
	.notes-cell {
		max-width: 320px;
		white-space: pre-wrap;
		color: var(--text-secondary);
	}

	/* ── Runner: known-issue checkbox ────────────────────────────────── */
	.runner-modal .checkbox-field {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.88rem;
		color: var(--text);
		padding: 0.25rem 0;
	}

	/* ── Confirm / alert modal ─────────────────────────────────────── */
	.runner-modal.confirm-modal { gap: 0.8rem; }
	.runner-modal.confirm-modal p {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.9rem;
		line-height: 1.45;
	}
	.btn-danger {
		background: #dc2626;
		color: #fff;
	}
	.btn-danger:hover { background: #b91c1c; }
</style>
