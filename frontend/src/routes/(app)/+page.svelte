<script lang="ts">
  import { onMount } from "svelte";
  import { fetchRuns, type Run } from "$lib/api";

  let allRuns = $state<Run[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let selectedSuite = $state("all");
  let selectedBranch = $state("all");
  let searchQuery = $state("");

  let suites = $derived([...new Set(allRuns.map((r) => r.suite_name))].sort());
  let branches = $derived([...new Set(allRuns.map((r) => r.branch).filter(Boolean))].sort());

  let runs = $derived(
    allRuns.filter((r) => {
      if (selectedSuite !== "all" && r.suite_name !== selectedSuite) return false;
      if (selectedBranch !== "all" && r.branch !== selectedBranch) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return r.suite_name.toLowerCase().includes(q)
          || r.branch?.toLowerCase().includes(q)
          || r.commit_sha?.toLowerCase().includes(q)
          || String(r.id).includes(q);
      }
      return true;
    })
  );

  let stats = $derived({
    total: runs.length,
    passed: runs.filter((r) => r.failed === 0).length,
    failed: runs.filter((r) => r.failed > 0).length,
  });

  onMount(async () => {
    try {
      allRuns = await fetchRuns();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load runs";
    } finally {
      loading = false;
    }
  });

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60000);
    const secs = Math.round((ms % 60000) / 1000);
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  }

  function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days === 1) return "yesterday";
    if (days < 30) return `${days}d ago`;
    return `${Math.floor(days / 30)}mo ago`;
  }

  function passRate(r: Run): number {
    return r.total > 0 ? Math.round((r.passed / r.total) * 100) : 0;
  }
</script>

<div class="page">
  <div class="header">
    <div class="filters">
      <select bind:value={selectedSuite}>
        <option value="all">All suites</option>
        {#each suites as suite}
          <option value={suite}>{suite}</option>
        {/each}
      </select>
      {#if branches.length > 1}
        <select bind:value={selectedBranch}>
          <option value="all">All branches</option>
          {#each branches as branch}
            <option value={branch}>{branch}</option>
          {/each}
        </select>
      {/if}
      <div class="search-box">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>
        <input type="text" placeholder="Search runs..." bind:value={searchQuery} />
      </div>
    </div>
    <a href="/compare" class="compare-link">Compare runs</a>
  </div>

  {#if !loading && runs.length > 0}
    <div class="summary-bar">
      <span>{stats.total} run{stats.total !== 1 ? "s" : ""}</span>
      <span class="sep">·</span>
      <span class="summary-pass">{stats.passed} passed</span>
      <span class="sep">·</span>
      <span class="summary-fail">{stats.failed} failed</span>
    </div>
  {/if}

  {#if loading}
    <p class="status-text">Loading runs...</p>
  {:else if error}
    <p class="status-text err">{error}</p>
  {:else if runs.length === 0}
    <div class="empty">
      <p>No test runs found.</p>
      <p class="hint">
        {#if selectedSuite !== "all" || selectedBranch !== "all" || searchQuery}
          Try changing the filters.
        {:else}
          Run your tests and upload results to see them here.
        {/if}
      </p>
    </div>
  {:else}
    <div class="run-list">
      {#each runs as run}
        <a href="/runs/{run.id}" class="run-card">
          <div class="card-left">
            <span class="run-status-dot" class:pass={run.failed === 0} class:fail={run.failed > 0}></span>
            <div class="card-info">
              <div class="card-title-row">
                <span class="run-id">#{run.id}</span>
                <span class="run-suite">{run.suite_name}</span>
                {#if run.failed > 0}
                  <span class="fail-badge">{run.failed} failed</span>
                {:else}
                  <span class="pass-badge">passed</span>
                {/if}
              </div>
              <div class="card-meta">
                {#if run.branch}
                  <span class="meta-chip branch">{run.branch}</span>
                {/if}
                {#if run.commit_sha}
                  <span class="meta-chip mono">{run.commit_sha.slice(0, 7)}</span>
                {/if}
                <span>{formatDuration(run.duration_ms)}</span>
                <span class="meta-time">{timeAgo(run.created_at)}</span>
              </div>
            </div>
          </div>

          <div class="card-right">
            <div class="card-stats">
              <span class="stat-pass">{run.passed}</span>
              <span class="stat-sep">/</span>
              <span class="stat-total">{run.total}</span>
            </div>
            <div class="result-bar">
              {#if run.total > 0}
                <div class="bar-pass" style="width: {(run.passed / run.total) * 100}%"></div>
                <div class="bar-fail" style="width: {(run.failed / run.total) * 100}%"></div>
                <div class="bar-skip" style="width: {((run.skipped + run.pending) / run.total) * 100}%"></div>
              {/if}
            </div>
            <span class="pass-pct">{passRate(run)}%</span>
          </div>
        </a>
      {/each}
    </div>
  {/if}
</div>

<style>
  .page { max-width: 1100px; padding: 2rem; }

  .header {
    display: flex; align-items: center; justify-content: space-between;
    gap: 0.75rem; margin-bottom: 1rem; flex-wrap: wrap;
  }
  .filters { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
  select {
    padding: 0.35rem 0.6rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--text); font-size: 0.85rem;
  }

  .search-box {
    display: flex; align-items: center; gap: 0.4rem;
    padding: 0.35rem 0.6rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--text-muted);
  }
  .search-box:focus-within { border-color: var(--link); }
  .search-box input {
    border: none; background: transparent; outline: none;
    font-size: 0.8rem; color: var(--text); width: 140px;
  }
  .search-box input::placeholder { color: var(--text-muted); }

  .compare-link {
    padding: 0.35rem 0.75rem; border: 1px solid var(--border); border-radius: 6px;
    color: var(--text-secondary); text-decoration: none; font-size: 0.8rem;
  }
  .compare-link:hover { background: var(--bg-hover); color: var(--text); }

  .summary-bar {
    display: flex; gap: 0.4rem; font-size: 0.82rem; color: var(--text-secondary); margin-bottom: 0.75rem;
  }
  .sep { color: var(--border); }
  .summary-pass { color: var(--color-pass); font-weight: 600; }
  .summary-fail { color: var(--color-fail); font-weight: 600; }

  .status-text { color: var(--text-secondary); }
  .status-text.err { color: var(--color-fail); }
  .empty { padding: 3rem 0; text-align: center; color: var(--text-secondary); }
  .hint { font-size: 0.875rem; color: var(--text-muted); }

  .run-list { display: flex; flex-direction: column; gap: 0.35rem; }

  .run-card {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    padding: 0.65rem 1rem; border: 1px solid var(--border); border-radius: 8px;
    background: var(--bg); text-decoration: none; color: var(--text);
    transition: border-color 0.1s, background 0.1s;
  }
  .run-card:hover { border-color: var(--link); background: var(--bg-hover); }

  .card-left { display: flex; align-items: center; gap: 0.65rem; flex: 1; min-width: 0; }

  .run-status-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .run-status-dot.pass { background: var(--color-pass); }
  .run-status-dot.fail { background: var(--color-fail); }

  .card-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.2rem; }

  .card-title-row { display: flex; align-items: center; gap: 0.5rem; }
  .run-id { font-weight: 700; font-size: 0.85rem; font-family: monospace; }
  .run-suite { font-size: 0.82rem; font-weight: 500; }
  .fail-badge {
    padding: 0.1rem 0.4rem; border-radius: 8px; font-size: 0.65rem; font-weight: 600;
    background: color-mix(in srgb, var(--color-fail) 15%, transparent); color: var(--color-fail);
  }
  .pass-badge {
    padding: 0.1rem 0.4rem; border-radius: 8px; font-size: 0.65rem; font-weight: 600;
    background: color-mix(in srgb, var(--color-pass) 15%, transparent); color: var(--color-pass);
  }

  .card-meta {
    display: flex; align-items: center; gap: 0.5rem; font-size: 0.72rem; color: var(--text-muted);
  }
  .meta-chip {
    padding: 0.1rem 0.35rem; border-radius: 4px; font-size: 0.68rem;
    background: var(--bg-secondary); color: var(--text-secondary);
  }
  .meta-chip.branch { font-weight: 500; }
  .meta-chip.mono { font-family: monospace; }
  .meta-time { margin-left: auto; }

  .card-right { display: flex; align-items: center; gap: 0.75rem; flex-shrink: 0; }

  .card-stats { font-family: monospace; font-size: 0.8rem; text-align: right; min-width: 3.5rem; }
  .stat-pass { color: var(--color-pass); font-weight: 700; }
  .stat-sep { color: var(--text-muted); }
  .stat-total { color: var(--text-secondary); }

  .result-bar {
    display: flex; width: 100px; height: 6px; border-radius: 3px; overflow: hidden;
    background: var(--border-light);
  }
  .bar-pass { background: var(--color-pass); }
  .bar-fail { background: var(--color-fail); }
  .bar-skip { background: var(--color-skip); }

  .pass-pct { font-size: 0.75rem; font-weight: 700; color: var(--text-secondary); min-width: 2.5rem; text-align: right; }
</style>
