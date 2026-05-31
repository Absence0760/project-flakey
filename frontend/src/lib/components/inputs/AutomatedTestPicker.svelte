<script lang="ts">
	import { authFetch } from '$lib/stores/auth';
	import { absoluteDate } from "$lib/utils/format";
	import { API_URL } from '$lib/utils/config';

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
	const listboxId = `atp-listbox-${Math.random().toString(36).slice(2, 8)}`;

	// Keep query mirrored to the bound value when the parent resets us
	// (e.g. modal close → newAutomatedKey = ''). Don't fight the user
	// while the dropdown is open.
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
		// Delay so a mousedown on a result still fires before the dropdown closes.
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

	function clearSelection() {
		value = '';
		query = '';
		results = [];
		open = false;
	}

	function switchMode(m: Mode) {
		mode = m;
		highlight = 0;
		if (query.trim().length >= 2) search(query);
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			if (open) {
				open = false;
			} else if (value) {
				clearSelection();
			}
			return;
		}
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
		}
	}

	function relativeDate(iso: string): string {
		try {
			const diff = Date.now() - new Date(iso).getTime();
			const mins = Math.floor(diff / 60000);
			if (mins < 1) return 'just now';
			if (mins < 60) return `${mins}m ago`;
			const hrs = Math.floor(mins / 60);
			if (hrs < 24) return `${hrs}h ago`;
			const days = Math.floor(hrs / 24);
			if (days < 30) return `${days}d ago`;
			const months = Math.floor(days / 30);
			if (months < 12) return `${months}mo ago`;
			return `${Math.floor(months / 12)}y ago`;
		} catch {
			return '';
		}
	}

	// Parse the bound value back into a "selected chip" representation.
	// Tests-mode picks set value to "<file_path> :: <full_title>"; spec-file
	// picks set value to "<file_path>". Free text the user typed but never
	// picked from the dropdown is shown verbatim — there's nothing to split.
	let selectedChip = $derived.by(() => {
		if (!value) return null;
		const sep = value.indexOf(' :: ');
		if (sep > 0) {
			return { kind: 'test' as const, file: value.slice(0, sep), title: value.slice(sep + 4) };
		}
		return { kind: 'free' as const, text: value };
	});
</script>

<div class="picker">
	{#if selectedChip}
		<div class="selected-chip" data-testid="automated-test-picker-selected">
			<span class="chip-label">Linked</span>
			{#if selectedChip.kind === 'test'}
				<span class="chip-title">{selectedChip.title}</span>
				<code class="chip-path">{selectedChip.file}</code>
			{:else}
				<code class="chip-path chip-path-only">{selectedChip.text}</code>
			{/if}
			<button type="button" class="chip-clear" onclick={clearSelection} aria-label="Clear linked test">×</button>
		</div>
	{/if}
	<input
		type="text"
		role="combobox"
		aria-autocomplete="list"
		aria-expanded={open}
		aria-controls={listboxId}
		aria-activedescendant={open && results[highlight] ? `${listboxId}-opt-${highlight}` : undefined}
		value={query}
		oninput={onInput}
		onfocus={onFocus}
		onblur={onBlur}
		onkeydown={onKey}
		{placeholder}
		autocomplete="off"
		class="picker-input"
	/>
	{#if open}
		<div class="dropdown" role="presentation">
			<div class="mode-tabs" role="tablist" aria-label="Search target">
				<button
					type="button"
					role="tab"
					aria-selected={mode === 'tests'}
					class="mode-tab"
					class:active={mode === 'tests'}
					onmousedown={(e) => { e.preventDefault(); switchMode('tests'); }}
				>Tests</button>
				<button
					type="button"
					role="tab"
					aria-selected={mode === 'files'}
					class="mode-tab"
					class:active={mode === 'files'}
					onmousedown={(e) => { e.preventDefault(); switchMode('files'); }}
				>Spec files</button>
				{#if loading}
					<span class="loading-pip" aria-hidden="true">searching…</span>
				{/if}
			</div>

			{#if query.trim().length < 2}
				<div class="state">Type at least 2 characters to search uploaded runs</div>
			{:else if loading && results.length === 0}
				<div class="state">Searching…</div>
			{:else if results.length === 0}
				<div class="state empty">
					<div>No {mode === 'tests' ? 'tests' : 'spec files'} match <code>{query.trim()}</code>.</div>
					<button
						type="button"
						class="state-link"
						onmousedown={(e) => { e.preventDefault(); switchMode(mode === 'tests' ? 'files' : 'tests'); }}
					>Try {mode === 'tests' ? 'spec files' : 'tests'} instead</button>
					<div class="state-fine">Or keep your text — it's saved as the link verbatim.</div>
				</div>
			{:else}
				<ul
					id={listboxId}
					role="listbox"
					aria-label={mode === 'tests' ? 'Matching tests' : 'Matching spec files'}
					class="results"
				>
					{#each results as r, i (mode === 'tests' ? `t-${(r as TestResult).test_id}-${(r as TestResult).run_id}` : `f-${(r as FileResult).file_path}`)}
						<li role="option" aria-selected={i === highlight} id={`${listboxId}-opt-${i}`}>
							<button
								type="button"
								class="result-btn"
								class:highlight={i === highlight}
								onmouseenter={() => (highlight = i)}
								onmousedown={(e) => {
									e.preventDefault();
									if (mode === 'tests') pickTest(r as TestResult);
									else pickFile(r as FileResult);
								}}
							>
								{#if mode === 'tests'}
									{@const test = r as TestResult}
									<div class="result-line1">
										<span class="status-dot status-{test.status}" title={test.status}></span>
										<span class="result-title">{test.full_title}</span>
									</div>
									<div class="result-line2">
										<code>{test.file_path}</code>
										<span class="sep">·</span>
										<span class="suite">{test.suite_name}</span>
										<span class="sep">·</span>
										<span title={absoluteDate(test.last_run_at)}>{relativeDate(test.last_run_at)}</span>
									</div>
								{:else}
									{@const file = r as FileResult}
									<div class="result-line1">
										<span class="file-icon" aria-hidden="true">📄</span>
										<code class="result-title">{file.file_path}</code>
									</div>
									<div class="result-line2">
										<span class="suite">{file.suite_name}</span>
										<span class="sep">·</span>
										<span>{file.test_count} test{file.test_count === 1 ? '' : 's'}</span>
										<span class="sep">·</span>
										<span title={absoluteDate(file.last_run_at)}>{relativeDate(file.last_run_at)}</span>
									</div>
								{/if}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>

<style>
	.picker { position: relative; }

	.picker-input {
		width: 100%;
		padding: 0.42rem 0.55rem;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg);
		color: var(--text);
		font-size: 0.88rem;
		font-family: inherit;
	}

	/* Selected chip — sits ABOVE the input so the user can always see what's
	   currently linked, including after the dropdown closes. The chip is the
	   primary affordance for "swap or clear the linked test". */
	.selected-chip {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.35rem 0.55rem;
		margin-bottom: 0.35rem;
		background: color-mix(in srgb, var(--color-pass, #16a34a) 8%, var(--bg-secondary, var(--bg)));
		border: 1px solid color-mix(in srgb, var(--color-pass, #16a34a) 25%, var(--border));
		border-left: 3px solid var(--color-pass, #16a34a);
		border-radius: 5px;
		font-size: 0.78rem;
		min-width: 0;
	}
	.chip-label {
		text-transform: uppercase;
		letter-spacing: 0.04em;
		font-weight: 700;
		font-size: 0.62rem;
		color: var(--color-pass, #16a34a);
		flex-shrink: 0;
	}
	.chip-title {
		font-weight: 600;
		color: var(--text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex-shrink: 1;
		min-width: 0;
	}
	.chip-path {
		font-family: ui-monospace, monospace;
		font-size: 0.7rem;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
		flex: 1 1 auto;
	}
	.chip-path-only {
		flex: 1 1 auto;
		color: var(--text);
		font-size: 0.78rem;
	}
	.chip-clear {
		flex-shrink: 0;
		border: none;
		background: transparent;
		color: var(--text-muted);
		font-size: 1.1rem;
		line-height: 1;
		cursor: pointer;
		padding: 0 0.25rem;
		border-radius: 3px;
	}
	.chip-clear:hover { background: var(--bg-hover); color: var(--text); }

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
		max-height: 360px;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.mode-tabs {
		display: flex;
		align-items: center;
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
	.loading-pip {
		margin-left: auto;
		font-size: 0.68rem;
		color: var(--text-muted);
		font-style: italic;
	}

	.state {
		padding: 0.85rem 0.75rem;
		color: var(--text-muted);
		font-size: 0.8rem;
		text-align: center;
	}
	.state.empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.4rem;
	}
	.state code {
		font-family: ui-monospace, monospace;
		font-size: 0.75rem;
		color: var(--text);
		background: var(--bg-hover);
		padding: 0.05rem 0.3rem;
		border-radius: 3px;
	}
	.state-link {
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 0.25rem 0.6rem;
		font-size: 0.72rem;
		color: var(--link, var(--text));
		cursor: pointer;
	}
	.state-link:hover { background: var(--bg-hover); }
	.state-fine { font-size: 0.7rem; color: var(--text-muted); opacity: 0.85; }

	.results {
		list-style: none;
		padding: 0.25rem;
		margin: 0;
		overflow-y: auto;
	}
	.results li { margin: 0; }
	.result-btn {
		width: 100%;
		text-align: left;
		display: block;
		padding: 0.5rem 0.6rem;
		border-radius: 5px;
		cursor: pointer;
		border: none;
		background: transparent;
		color: inherit;
		font: inherit;
		transition: background 0.1s;
	}
	.result-btn.highlight { background: var(--bg-hover); }
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
		max-width: 50%;
	}
	.result-line2 .suite {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 30%;
	}
	.sep { color: var(--text-muted); opacity: 0.5; }
	.status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
	.status-passed  { background: var(--color-pass, #16a34a); }
	.status-failed  { background: var(--color-fail, #dc2626); }
	.status-skipped { background: var(--color-skip, #9ca3af); }
	.status-pending { background: #9ca3af; }
	.file-icon { font-size: 0.9rem; }
</style>
