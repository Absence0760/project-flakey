<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { fetchCompare, fetchRuns, type CompareResult, type CompareEntry, type Run } from "$lib/api";

  let result = $state<CompareResult | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Selection state (when no query params)
  let runs = $state<Run[]>([]);
  let selectedA = $state<string>("");
  let selectedB = $state<string>("");
  let selecting = $state(false);

  let categoryFilter = $state<string>("all");

  onMount(async () => {
    const a = $page.url.searchParams.get("a");
    const b = $page.url.searchParams.get("b");

    if (a && b) {
      await loadComparison(Number(a), Number(b));
    } else {
      // Load runs for selection
      selecting = true;
      loading = true;
      try {
        runs = await fetchRuns();
      } catch (e) {
        error = e instanceof Error ? e.message : "Failed to load runs";
      } finally {
        loading = false;
      }
    }
  });

  async function loadComparison(a: number, b: number) {
    loading = true;
    error = null;
    try {
      result = await fetchCompare(a, b);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to compare runs";
    } finally {
      loading = false;
    }
  }

  function startCompare() {
    if (!selectedA || !selectedB) return;
    selecting = false;
    loadComparison(Number(selectedA), Number(selectedB));
  }

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  }

  function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const hrs = Math.floor(diff / 3600000);
    if (hrs < 1) return `${Math.floor(diff / 60000)}m ago`;
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  const CATEGORY_LABELS: Record<string, string> = {
    regression: "Regressions",
    fixed: "Fixed",
    still_failing: "Still Failing",
    added: "Added",
    removed: "Removed",
    changed: "Changed",
    unchanged: "Unchanged",
  };

  const CATEGORY_ORDER = ["regression", "fixed", "still_failing", "added", "removed", "changed", "unchanged"];

  let filteredComparisons = $derived.by(() => {
    if (!result) return [];
    if (categoryFilter === "all") return result.comparisons;
    return result.comparisons.filter((c) => c.category === categoryFilter);
  });

  let groupedByFile = $derived.by(() => {
    const groups = new Map<string, CompareEntry[]>();
    for (const c of filteredComparisons) {
      const existing = groups.get(c.file_path) ?? [];
      existing.push(c);
      groups.set(c.file_path, existing);
    }
    return groups;
  });
</script>

<div class="page">
  {#if selecting}
    <div class="select-card">
      <h2>Compare Runs</h2>
      <p class="desc">Select two runs to compare side-by-side.</p>

      {#if loading}
        <p class="muted">Loading runs...</p>
      {:else if error}
        <p class="error-msg">{error}</p>
      {:else}
        <div class="select-form">
          <div class="select-col">
            <label>Base run (A)</label>
            <select bind:value={selectedA}>
              <option value="">Select a run...</option>
              {#each runs as run}
                <option value={String(run.id)}>#{run.id} — {run.suite_name} ({run.branch || "—"}) · {timeAgo(run.created_at)}</option>
              {/each}
            </select>
          </div>
          <div class="select-arrow">vs</div>
          <div class="select-col">
            <label>Compare run (B)</label>
            <select bind:value={selectedB}>
              <option value="">Select a run...</option>
              {#each runs as run}
                <option value={String(run.id)}>#{run.id} — {run.suite_name} ({run.branch || "—"}) · {timeAgo(run.created_at)}</option>
              {/each}
            </select>
          </div>
          <button class="compare-btn" onclick={startCompare} disabled={!selectedA || !selectedB || selectedA === selectedB}>
            Compare
          </button>
        </div>
      {/if}
    </div>

  {:else if loading}
    <p class="muted">Comparing runs...</p>

  {:else if error}
    <p class="error-msg">{error}</p>

  {:else if result}
    <!-- Header -->
    <div class="compare-header">
      <div class="run-card">
        <a href="/runs/{result.run_a.id}" class="run-link">Run #{result.run_a.id}</a>
        <span class="run-meta">{result.run_a.suite_name} · {result.run_a.branch || "—"}</span>
        <span class="run-stats">{result.run_a.passed}/{result.run_a.total} passed · {timeAgo(result.run_a.created_at)}</span>
      </div>
      <div class="vs-badge">vs</div>
      <div class="run-card">
        <a href="/runs/{result.run_b.id}" class="run-link">Run #{result.run_b.id}</a>
        <span class="run-meta">{result.run_b.suite_name} · {result.run_b.branch || "—"}</span>
        <span class="run-stats">{result.run_b.passed}/{result.run_b.total} passed · {timeAgo(result.run_b.created_at)}</span>
      </div>
      <button class="change-btn" onclick={() => { selecting = true; result = null; }}>Change</button>
    </div>

    <!-- Summary pills -->
    <div class="summary-bar">
      <button class="summary-pill" class:active={categoryFilter === "all"} onclick={() => categoryFilter = "all"}>
        All <span class="pill-count">{result.comparisons.length}</span>
      </button>
      {#each CATEGORY_ORDER as cat}
        {#if result.summary[cat]}
          <button class="summary-pill {cat}" class:active={categoryFilter === cat} onclick={() => categoryFilter = cat}>
            {CATEGORY_LABELS[cat]} <span class="pill-count">{result.summary[cat]}</span>
          </button>
        {/if}
      {/each}
    </div>

    <!-- Results -->
    {#if filteredComparisons.length === 0}
      <p class="muted" style="text-align:center; padding:2rem 0">No tests match this filter.</p>
    {:else}
      {#each [...groupedByFile] as [filePath, entries]}
        <section class="file-section">
          <div class="file-header">
            <span class="file-path">{filePath}</span>
            <span class="file-count">{entries.length} test{entries.length !== 1 ? "s" : ""}</span>
          </div>
          <div class="compare-list">
            {#each entries as entry}
              <div class="compare-row {entry.category}">
                <div class="compare-status-a">
                  {#if entry.a}
                    <span class="status-dot {entry.a.status}"></span>
                    <span class="status-label {entry.a.status}">{entry.a.status}</span>
                    <span class="dur">{formatDuration(entry.a.duration_ms)}</span>
                  {:else}
                    <span class="status-label empty">—</span>
                  {/if}
                </div>
                <div class="compare-center">
                  <span class="category-badge {entry.category}">{CATEGORY_LABELS[entry.category]}</span>
                  <span class="test-title">{entry.title}</span>
                  {#if entry.duration_delta !== null && Math.abs(entry.duration_delta) > 20}
                    <span class="duration-delta" class:slower={entry.duration_delta > 0} class:faster={entry.duration_delta < 0}>
                      {entry.duration_delta > 0 ? "+" : ""}{entry.duration_delta}%
                    </span>
                  {/if}
                  {#if entry.b?.error_message && entry.category === "regression"}
                    <span class="compare-error">{entry.b.error_message}</span>
                  {/if}
                </div>
                <div class="compare-status-b">
                  {#if entry.b}
                    <span class="dur">{formatDuration(entry.b.duration_ms)}</span>
                    <span class="status-label {entry.b.status}">{entry.b.status}</span>
                    <span class="status-dot {entry.b.status}"></span>
                  {:else}
                    <span class="status-label empty">—</span>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </section>
      {/each}
    {/if}
  {/if}
</div>

<style>
  .page { padding: 2rem; }

  .muted { color: var(--text-muted); font-size: 0.85rem; margin: 0; }
  .error-msg { color: var(--color-fail); font-size: 0.85rem; }

  /* Selection */
  .select-card {
    max-width: 700px;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 2rem;
  }

  .select-card h2 { margin: 0 0 0.25rem; font-size: 1.15rem; }
  .desc { margin: 0 0 1.5rem; color: var(--text-muted); font-size: 0.85rem; }

  .select-form {
    display: flex;
    align-items: flex-end;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .select-col { display: flex; flex-direction: column; gap: 0.35rem; flex: 1; min-width: 200px; }
  .select-col label { font-size: 0.78rem; font-weight: 500; color: var(--text-secondary); }
  .select-col select {
    padding: 0.5rem 0.65rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--text); font-size: 0.82rem;
  }

  .select-arrow { font-size: 0.85rem; font-weight: 600; color: var(--text-muted); padding-bottom: 0.5rem; }

  .compare-btn {
    padding: 0.5rem 1.25rem; border: none; border-radius: 6px; background: var(--link);
    color: #fff; font-size: 0.85rem; font-weight: 600; cursor: pointer;
  }
  .compare-btn:hover:not(:disabled) { opacity: 0.9; }
  .compare-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  /* Header */
  .compare-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }

  .run-card {
    flex: 1;
    min-width: 200px;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.85rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .run-link { font-weight: 600; font-size: 0.9rem; color: var(--link); text-decoration: none; }
  .run-link:hover { text-decoration: underline; }
  .run-meta { font-size: 0.78rem; color: var(--text-secondary); }
  .run-stats { font-size: 0.75rem; color: var(--text-muted); }

  .vs-badge {
    font-size: 0.8rem; font-weight: 700; color: var(--text-muted);
    padding: 0.3rem 0.6rem; background: var(--bg-secondary); border-radius: 6px;
    flex-shrink: 0;
  }

  .change-btn {
    padding: 0.35rem 0.75rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--text-secondary); font-size: 0.78rem; cursor: pointer;
    flex-shrink: 0;
  }
  .change-btn:hover { background: var(--bg-hover); color: var(--text); }

  /* Summary pills */
  .summary-bar {
    display: flex;
    gap: 0.3rem;
    margin-bottom: 1rem;
    flex-wrap: wrap;
    background: var(--bg-secondary);
    border-radius: 6px;
    padding: 0.25rem;
  }

  .summary-pill {
    padding: 0.35rem 0.7rem; border: none; border-radius: 4px;
    background: transparent; color: var(--text-secondary); font-size: 0.78rem;
    cursor: pointer; display: flex; align-items: center; gap: 0.35rem;
    transition: all 0.15s; white-space: nowrap;
  }
  .summary-pill:hover { color: var(--text); }
  .summary-pill.active {
    background: var(--bg); color: var(--text); font-weight: 600;
    box-shadow: 0 1px 2px rgba(0,0,0,0.06);
  }

  .pill-count { font-size: 0.7rem; color: var(--text-muted); font-weight: 400; }

  .summary-pill.regression { color: var(--color-fail); }
  .summary-pill.fixed { color: var(--color-pass); }
  .summary-pill.still_failing { color: var(--color-fail); }
  .summary-pill.added { color: var(--link); }

  /* File sections */
  .file-section {
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 0.5rem;
    overflow: hidden;
  }

  .file-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.55rem 0.85rem;
    background: var(--bg-secondary);
    font-size: 0.8rem;
  }

  .file-path { font-family: monospace; font-size: 0.78rem; color: var(--text); }
  .file-count { font-size: 0.72rem; color: var(--text-muted); }

  /* Compare rows */
  .compare-list { display: flex; flex-direction: column; }

  .compare-row {
    display: flex;
    align-items: center;
    gap: 0;
    padding: 0.5rem 0.85rem;
    border-top: 1px solid var(--border-light);
    font-size: 0.82rem;
  }

  .compare-row.regression { background: color-mix(in srgb, var(--color-fail) 4%, transparent); }
  .compare-row.fixed { background: color-mix(in srgb, var(--color-pass) 4%, transparent); }

  .compare-status-a, .compare-status-b {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 140px;
    flex-shrink: 0;
  }

  .compare-status-a { justify-content: flex-end; }

  .compare-center {
    flex: 1;
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0 1rem;
    min-width: 0;
    flex-wrap: wrap;
  }

  .status-dot {
    width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  }
  .status-dot.passed { background: var(--color-pass); }
  .status-dot.failed { background: var(--color-fail); }
  .status-dot.skipped, .status-dot.pending { background: var(--color-skip); }

  .status-label {
    font-size: 0.72rem; font-family: monospace; font-weight: 600; text-transform: uppercase;
  }
  .status-label.passed { color: var(--color-pass); }
  .status-label.failed { color: var(--color-fail); }
  .status-label.skipped { color: var(--color-skip); }
  .status-label.empty { color: var(--text-muted); }

  .dur { font-family: monospace; font-size: 0.72rem; color: var(--text-muted); }

  .category-badge {
    font-size: 0.65rem; font-weight: 600; padding: 0.15rem 0.45rem;
    border-radius: 3px; text-transform: uppercase; letter-spacing: 0.02em;
    flex-shrink: 0;
  }
  .category-badge.regression { background: color-mix(in srgb, var(--color-fail) 15%, transparent); color: var(--color-fail); }
  .category-badge.fixed { background: color-mix(in srgb, var(--color-pass) 15%, transparent); color: var(--color-pass); }
  .category-badge.still_failing { background: color-mix(in srgb, var(--color-fail) 10%, transparent); color: var(--color-fail); }
  .category-badge.added { background: color-mix(in srgb, var(--link) 12%, transparent); color: var(--link); }
  .category-badge.removed { background: var(--bg-hover); color: var(--text-muted); }
  .category-badge.changed { background: color-mix(in srgb, var(--color-skip) 12%, transparent); color: var(--color-skip); }
  .category-badge.unchanged { background: var(--bg-secondary); color: var(--text-muted); }

  .test-title {
    font-size: 0.82rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .duration-delta {
    font-size: 0.7rem;
    font-family: monospace;
    font-weight: 600;
    flex-shrink: 0;
  }
  .duration-delta.slower { color: var(--color-fail); }
  .duration-delta.faster { color: var(--color-pass); }

  .compare-error {
    width: 100%;
    font-size: 0.72rem;
    color: var(--error-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
