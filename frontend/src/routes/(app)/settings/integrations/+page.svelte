<script lang="ts">
	import { onMount } from 'svelte';
	import { authFetch } from '$lib/auth';
	import { API_URL } from '$lib/config';

	// Jira
	let jira = $state({
		jira_base_url: '',
		jira_email: '',
		jira_project_key: '',
		jira_issue_type: 'Bug',
		jira_auto_create: false,
		has_api_token: false,
	});
	let jiraToken = $state('');
	let jiraStatus = $state<string | null>(null);

	// PagerDuty
	let pd = $state({ has_key: false, pagerduty_severity: 'error', pagerduty_auto_trigger: false });
	let pdKey = $state('');
	let pdStatus = $state<string | null>(null);

	// Coverage gating
	let coverage = $state({ coverage_threshold: 80, coverage_gate_enabled: false });

	// Scheduled reports
	interface Report {
		id: number;
		name: string;
		cadence: 'daily' | 'weekly';
		day_of_week: number | null;
		hour_utc: number;
		channel: 'email' | 'webhook' | 'slack';
		destination: string;
		suite_filter: string | null;
		active: boolean;
		last_sent_at: string | null;
	}
	let reports = $state<Report[]>([]);
	let newReport = $state({
		name: '',
		cadence: 'daily' as 'daily' | 'weekly',
		day_of_week: 1,
		hour_utc: 9,
		channel: 'email' as 'email' | 'webhook' | 'slack',
		destination: '',
		suite_filter: '',
	});

	onMount(async () => {
		await Promise.all([loadJira(), loadPagerDuty(), loadCoverage(), loadReports()]);
	});

	async function loadJira() {
		const res = await authFetch(`${API_URL}/jira/settings`);
		if (res.ok) jira = { ...jira, ...(await res.json()) };
	}
	async function saveJira() {
		const body: Record<string, unknown> = {
			base_url: jira.jira_base_url,
			email: jira.jira_email,
			project_key: jira.jira_project_key,
			issue_type: jira.jira_issue_type,
			auto_create: jira.jira_auto_create,
		};
		if (jiraToken) body.api_token = jiraToken;
		const res = await authFetch(`${API_URL}/jira/settings`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		jiraStatus = res.ok ? 'Saved.' : 'Save failed.';
		jiraToken = '';
		await loadJira();
	}
	async function testJira() {
		const res = await authFetch(`${API_URL}/jira/test`, { method: 'POST' });
		const data = await res.json();
		jiraStatus = data.ok ? 'Jira credentials OK.' : `Test failed (${data.status})`;
	}

	async function loadPagerDuty() {
		const res = await authFetch(`${API_URL}/pagerduty/settings`);
		if (res.ok) pd = { ...pd, ...(await res.json()) };
	}
	async function savePagerDuty() {
		const body: Record<string, unknown> = {
			severity: pd.pagerduty_severity,
			auto_trigger: pd.pagerduty_auto_trigger,
		};
		if (pdKey) body.integration_key = pdKey;
		const res = await authFetch(`${API_URL}/pagerduty/settings`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		pdStatus = res.ok ? 'Saved.' : 'Save failed.';
		pdKey = '';
		await loadPagerDuty();
	}
	async function testPagerDuty() {
		const res = await authFetch(`${API_URL}/pagerduty/test`, { method: 'POST' });
		const data = await res.json();
		pdStatus = data.ok ? 'Test event enqueued.' : `Test failed (${data.status})`;
	}

	async function loadCoverage() {
		const res = await authFetch(`${API_URL}/coverage/settings`);
		if (res.ok) {
			const d = await res.json();
			coverage = {
				coverage_threshold: d.coverage_threshold ?? 80,
				coverage_gate_enabled: !!d.coverage_gate_enabled,
			};
		}
	}
	async function saveCoverage() {
		await authFetch(`${API_URL}/coverage/settings`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(coverage),
		});
		await loadCoverage();
	}

	async function loadReports() {
		const res = await authFetch(`${API_URL}/reports`);
		if (res.ok) reports = await res.json();
	}
	async function createReport() {
		if (!newReport.name || !newReport.destination) return;
		const body: Record<string, unknown> = {
			name: newReport.name,
			cadence: newReport.cadence,
			hour_utc: newReport.hour_utc,
			channel: newReport.channel,
			destination: newReport.destination,
			suite_filter: newReport.suite_filter || null,
		};
		if (newReport.cadence === 'weekly') body.day_of_week = newReport.day_of_week;
		const res = await authFetch(`${API_URL}/reports`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		if (res.ok) {
			newReport = { name: '', cadence: 'daily', day_of_week: 1, hour_utc: 9, channel: 'email', destination: '', suite_filter: '' };
			await loadReports();
		}
	}
	async function toggleReport(r: Report) {
		await authFetch(`${API_URL}/reports/${r.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ active: !r.active }),
		});
		await loadReports();
	}
	async function deleteReport(id: number) {
		if (!confirm('Delete this scheduled report?')) return;
		await authFetch(`${API_URL}/reports/${id}`, { method: 'DELETE' });
		await loadReports();
	}
	async function runReport(id: number) {
		await authFetch(`${API_URL}/reports/${id}/run`, { method: 'POST' });
		await loadReports();
	}
</script>

<div class="page">
	<a href="/settings" class="back">← Settings</a>
	<h1>Integrations & automation</h1>

	<!-- Jira -->
	<section>
		<h2>Jira</h2>
		<p class="hint">Auto-create or manually open Jira issues for test failures.</p>
		<label>Base URL <input bind:value={jira.jira_base_url} placeholder="https://your-org.atlassian.net" /></label>
		<label>Email <input bind:value={jira.jira_email} placeholder="you@company.com" /></label>
		<label>API token <input type="password" bind:value={jiraToken} placeholder={jira.has_api_token ? '••• stored' : 'Paste your token'} /></label>
		<label>Project key <input bind:value={jira.jira_project_key} placeholder="QA" /></label>
		<label>Issue type <input bind:value={jira.jira_issue_type} placeholder="Bug" /></label>
		<label class="check"><input type="checkbox" bind:checked={jira.jira_auto_create} /> Auto-create tickets for new failures</label>
		<div class="actions">
			<button class="btn-primary" onclick={saveJira}>Save</button>
			<button class="btn-ghost" onclick={testJira}>Test credentials</button>
		</div>
		{#if jiraStatus}<p class="status">{jiraStatus}</p>{/if}
	</section>

	<!-- PagerDuty -->
	<section>
		<h2>PagerDuty</h2>
		<p class="hint">Trigger incidents when runs fail. Uses Events API v2.</p>
		<label>Integration key <input type="password" bind:value={pdKey} placeholder={pd.has_key ? '••• stored' : 'Routing key'} /></label>
		<label>Severity
			<select bind:value={pd.pagerduty_severity}>
				<option value="info">Info</option>
				<option value="warning">Warning</option>
				<option value="error">Error</option>
				<option value="critical">Critical</option>
			</select>
		</label>
		<label class="check"><input type="checkbox" bind:checked={pd.pagerduty_auto_trigger} /> Trigger on run failure</label>
		<div class="actions">
			<button class="btn-primary" onclick={savePagerDuty}>Save</button>
			<button class="btn-ghost" onclick={testPagerDuty}>Send test event</button>
		</div>
		{#if pdStatus}<p class="status">{pdStatus}</p>{/if}
	</section>

	<!-- Coverage PR gating -->
	<section>
		<h2>Code coverage gating</h2>
		<p class="hint">Post a commit-status pass/fail based on lines covered percentage.</p>
		<label class="check"><input type="checkbox" bind:checked={coverage.coverage_gate_enabled} /> Gate PRs on coverage</label>
		<label>Minimum % <input type="number" min="0" max="100" step="0.1" bind:value={coverage.coverage_threshold} /></label>
		<div class="actions">
			<button class="btn-primary" onclick={saveCoverage}>Save</button>
		</div>
	</section>

	<!-- Scheduled reports -->
	<section>
		<h2>Scheduled reports</h2>
		<p class="hint">Deliver daily or weekly test summaries via email, Slack, or webhook.</p>
		<div class="create-report">
			<input placeholder="Name" bind:value={newReport.name} />
			<select bind:value={newReport.cadence}>
				<option value="daily">Daily</option>
				<option value="weekly">Weekly</option>
			</select>
			{#if newReport.cadence === 'weekly'}
				<select bind:value={newReport.day_of_week}>
					<option value={0}>Sun</option>
					<option value={1}>Mon</option>
					<option value={2}>Tue</option>
					<option value={3}>Wed</option>
					<option value={4}>Thu</option>
					<option value={5}>Fri</option>
					<option value={6}>Sat</option>
				</select>
			{/if}
			<input type="number" min="0" max="23" bind:value={newReport.hour_utc} title="Hour UTC" />
			<select bind:value={newReport.channel}>
				<option value="email">Email</option>
				<option value="slack">Slack</option>
				<option value="webhook">Webhook</option>
			</select>
			<input placeholder={newReport.channel === 'email' ? 'email@co.com' : 'https://hook.url'} bind:value={newReport.destination} />
			<input placeholder="Suite filter (optional)" bind:value={newReport.suite_filter} />
			<button class="btn-primary" onclick={createReport}>Add</button>
		</div>

		{#if reports.length > 0}
			<table>
				<thead>
					<tr><th>Name</th><th>Schedule</th><th>Channel</th><th>Destination</th><th>Active</th><th>Last sent</th><th></th></tr>
				</thead>
				<tbody>
					{#each reports as r}
						<tr>
							<td>{r.name}</td>
							<td>{r.cadence} @ {String(r.hour_utc).padStart(2,'0')}:00 UTC{r.cadence === 'weekly' ? ` (day ${r.day_of_week})` : ''}</td>
							<td>{r.channel}</td>
							<td class="dest">{r.destination}</td>
							<td><input type="checkbox" checked={r.active} onchange={() => toggleReport(r)} /></td>
							<td>{r.last_sent_at ? new Date(r.last_sent_at).toLocaleString() : 'never'}</td>
							<td>
								<button class="btn-ghost" onclick={() => runReport(r.id)}>Run now</button>
								<button class="btn-ghost" onclick={() => deleteReport(r.id)}>✕</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>
</div>

<style>
	.page { max-width: 1440px; margin: 0 auto; padding: 1.5rem 2rem; }
	.back { font-size: 0.85rem; color: var(--text-muted); text-decoration: none; }
	h1 { margin: 0.5rem 0 1.25rem; }
	section { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 1rem 1.25rem; margin-bottom: 1rem; display: flex; flex-direction: column; gap: 0.5rem; }
	section h2 { margin: 0; font-size: 1rem; }
	.hint { color: var(--text-muted); font-size: 0.82rem; margin: 0 0 0.5rem; }
	label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.78rem; color: var(--text-muted); }
	label.check { flex-direction: row; align-items: center; gap: 0.4rem; font-size: 0.85rem; color: var(--text); }
	input, select { padding: 0.38rem 0.5rem; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font-size: 0.88rem; }
	.actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
	.btn-primary { background: var(--link, #2563eb); color: #fff; border: none; padding: 0.4rem 0.85rem; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 0.82rem; }
	.btn-ghost { background: transparent; color: var(--text-muted); border: 1px solid var(--border); padding: 0.32rem 0.65rem; border-radius: 6px; cursor: pointer; font-size: 0.8rem; }
	.status { font-size: 0.8rem; color: var(--text-muted); }
	.create-report { display: grid; grid-template-columns: 1.5fr 0.8fr 0.8fr 2fr 1.5fr auto; gap: 0.4rem; align-items: center; }
	.create-report input, .create-report select { font-size: 0.82rem; }
	table { width: 100%; margin-top: 0.75rem; border-collapse: collapse; }
	table th, table td { padding: 0.4rem 0.5rem; text-align: left; font-size: 0.82rem; border-bottom: 1px solid var(--border); }
	table th { color: var(--text-muted); text-transform: uppercase; font-size: 0.7rem; font-weight: 600; }
	.dest { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: monospace; font-size: 0.78rem; }
</style>
