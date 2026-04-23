<script lang="ts">
	import { authFetch } from '$lib/auth';
	import { API_URL } from '$lib/config';

	interface Props {
		value: string;
		placeholder?: string;
	}

	let { value = $bindable(''), placeholder = 'Search by title or file path…' }: Props = $props();

	interface TestResult {
		file_path: string;
		full_title: string;
		suite_name: string;
		status: 'passed' | 'failed' | 'skipped' | 'pending';
		last_run_at: string;
		run_id: number;
		test_id: number;
	}
	interface FileResult {
		file_path: string;
		suite_name: string;
		test_count: number;
		last_run_at: string;
	}

	type Mode = 'tests' | 'files';

	let query = $state(value);
	let mode = $state<Mode>('tests');
	let results = $state<TestResult[] | FileResult[]>([]);
	let open = $state(false);
	let loading = $state(false);
	let highlight = $state(0);
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	// Keep query in sync if the parent updates the value externally
	$effect(() => {
		if (value !== query && !open) query = value;
	});

	async function search(q: string) {
		if (q.trim().length < 2) {
			results = [];
			loading = false;
			return;
		}
		loading = true;
		try {
			const res = await authFetch(
				`${API_URL}/tests/search/list?q=${encodeURIComponent(q.trim())}&mode=${mode}&limit=20`
			);
			if (res.ok) results = await res.json();
			else results = [];
		} catch {
			results = [];
		} finally {
			loading = false;
		}
	}

	function onInput(e: Event) {
		query = (e.target as HTMLInputElement).value;
		value = query;
		open = true;
		highlight = 0;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => search(query), 250);
	}

	function onFocus() {
		open = true;
		if (query.trim().length >= 2 && results.length === 0) search(query);
	}

	function onBlur() {
		// Delay so click on a result still fires
		setTimeout(() => (open = false), 180);
	}

	function pickTest(r: TestResult) {
		value = `${r.file_path} :: ${r.full_title}`;
		query = value;
		open = false;
	}

	function pickFile(r: FileResult) {
		value = r.file_path;
		query = value;
		open = false;
	}

	function switchMode(m: Mode) {
		mode = m;
		highlight = 0;
		if (query.trim().length >= 2) search(query);
	}

	function onKey(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			highlight = Math.min(results.length - 1, highlight + 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			highlight = Math.max(0, highlight - 1);
		} else if (e.key === 'Enter') {
			if (results[highlight]) {
				e.preventDefault();
				const r = results[highlight];
				if (mode === 'tests') pickTest(r as TestResult);
				else pickFile(r as FileResult);
			}
		} else if (e.key === 'Escape') {
			open = false;
		}
	}

	function formatDate(d: string): string {
		try {
			return new Date(d).toLocaleDateString();
		} catch {
			return '';
		}
	}
</script>

<div class="picker">
	<input
		type="text"
		value={query}
		oninput={onInput}
		onfocus={onFocus}
		onblur={onBlur}
		onkeydown={onKey}
		{placeholder}
		autocomplete="off"
	/>
	{#if open}
		<div class="dropdown">
			<div class="mode-tabs">
				<button
					type="button"
					class="mode-tab"
					class:active={mode === 'tests'}
					onmousedown={(e) => { e.preventDefault(); switchMode('tests'); }}
				>Tests</button>
				<button
					type="button"
					class="mode-tab"
					class:active={mode === 'files'}
					onmousedown={(e) => { e.preventDefault(); switchMode('files'); }}
				>Spec files</button>
			</div>

			{#if loading}
				<div class="state">Searching…</div>
			{:else if query.trim().length < 2}
				<div class="state">Type at least 2 characters to search</div>
			{:else if results.length === 0}
				<div class="state">
					No matches. The free text is kept as-is, so you can still link to anything you type.
				</div>
			{:else if mode === 'tests'}
				<ul class="results">
					{#each results as r, i}
						{@const test = r as TestResult}
						<li
							class:highlight={i === highlight}
							onmouseenter={() => (highlight = i)}
							onmousedown={(e) => { e.preventDefault(); pickTest(test); }}
						>
							<div class="result-line1">
								<span class="status-dot status-{test.status}"></span>
								<span class="result-title">{test.full_title}</span>
							</div>
							<div class="result-line2">
								<code>{test.file_path}</code>
								<span class="sep">·</span>
								<span>{test.suite_name}</span>
								<span class="sep">·</span>
								<span>{formatDate(test.last_run_at)}</span>
							</div>
						</li>
					{/each}
				</ul>
			{:else}
				<ul class="results">
					{#each results as r, i}
						{@const file = r as FileResult}
						<li
							class:highlight={i === highlight}
							onmouseenter={() => (highlight = i)}
							onmousedown={(e) => { e.preventDefault(); pickFile(file); }}
						>
							<div class="result-line1">
								<span class="file-icon">📄</span>
								<code class="result-title">{file.file_path}</code>
							</div>
							<div class="result-line2">
								<span>{file.suite_name}</span>
								<span class="sep">·</span>
								<span>{file.test_count} test{file.test_count === 1 ? '' : 's'}</span>
								<span class="sep">·</span>
								<span>{formatDate(file.last_run_at)}</span>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>

<style>
	.picker { position: relative; }
	input {
		width: 100%;
		padding: 0.42rem 0.55rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg);
		color: var(--text);
		font-size: 0.88rem;
		font-family: inherit;
	}
	.dropdown {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		right: 0;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 8px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
		z-index: 500;
		max-height: 340px;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}
	.mode-tabs {
		display: flex;
		gap: 0.15rem;
		padding: 0.3rem;
		border-bottom: 1px solid var(--border);
		background: var(--bg-secondary);
	}
	.mode-tab {
		padding: 0.3rem 0.7rem;
		border: none;
		border-radius: 4px;
		background: transparent;
		color: var(--text-muted);
		font-size: 0.75rem;
		cursor: pointer;
		font-weight: 500;
	}
	.mode-tab.active {
		background: var(--bg);
		color: var(--text);
		font-weight: 600;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
	}
	.state {
		padding: 0.75rem;
		color: var(--text-muted);
		font-size: 0.8rem;
		text-align: center;
	}
	.results {
		list-style: none;
		padding: 0.25rem;
		margin: 0;
		overflow-y: auto;
	}
	.results li {
		padding: 0.5rem 0.6rem;
		border-radius: 5px;
		cursor: pointer;
		transition: background 0.1s;
	}
	.results li.highlight { background: var(--bg-hover); }
	.result-line1 {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-size: 0.85rem;
		color: var(--text);
		font-weight: 500;
		margin-bottom: 0.2rem;
	}
	.result-title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.result-line2 {
		font-size: 0.72rem;
		color: var(--text-muted);
		display: flex;
		gap: 0.3rem;
		align-items: center;
		overflow: hidden;
	}
	.result-line2 code {
		font-family: ui-monospace, monospace;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 40%;
	}
	.sep { color: var(--text-muted); opacity: 0.5; }
	.status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
	.status-passed  { background: var(--color-pass, #16a34a); }
	.status-failed  { background: var(--color-fail, #dc2626); }
	.status-skipped { background: var(--color-skip, #9ca3af); }
	.status-pending { background: #9ca3af; }
	.file-icon { font-size: 0.9rem; }
</style>
