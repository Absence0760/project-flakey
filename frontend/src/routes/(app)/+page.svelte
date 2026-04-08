<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { fetchRunsWithSummary, fetchSavedViews, createSavedView, deleteSavedView, type Run, type RunsSummary, type SavedView } from "$lib/api";
  import { authFetch } from "$lib/auth";

  const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

  let allRuns = $state<Run[]>([]);
  let dbSummary = $state<RunsSummary>({ total: 0, passed: 0, failed: 0 });
  let loading = $state(true);
  let error = $state<string | null>(null);
  let liveRunIds = $state<Set<number>>(new Set());
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let selectedSuite = $state("all");
  let selectedBranch = $state("all");
  let selectedStatus = $state("all");
  let selectedDate = $state("all");
  let searchQuery = $state("");

  let savedViews = $state<SavedView[]>([]);
  let saveViewName = $state("");
  let showSaveInput = $state(false);
  let copiedSuite = $state<string | null>(null);

  // Compare mode
  let compareMode = $state(false);
  let compareA = $state<number | null>(null);
  let compareB = $state<number | null>(null);

  function toggleCompareSelect(e: MouseEvent, id: number) {
    e.preventDefault();
    e.stopPropagation();
    if (compareA === id) { compareA = null; return; }
    if (compareB === id) { compareB = null; return; }
    if (compareA === null) { compareA = id; return; }
    if (compareB === null) { compareB = id; return; }
    // Both set — replace B
    compareB = id;
  }

  function exitCompareMode() {
    compareMode = false;
    compareA = null;
    compareB = null;
  }

  // Pinned runs (persisted in localStorage)
  let pinnedIds = $state<Set<number>>(new Set());
  function loadPins() {
    try {
      const stored = localStorage.getItem("pinned-runs");
      if (stored) pinnedIds = new Set(JSON.parse(stored));
    } catch { /* ignore */ }
  }
  function savePins() {
    localStorage.setItem("pinned-runs", JSON.stringify([...pinnedIds]));
  }
  function togglePin(e: MouseEvent, id: number) {
    e.preventDefault();
    e.stopPropagation();
    const next = new Set(pinnedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    pinnedIds = next;
    savePins();
  }
  let pinnedRuns = $derived(allRuns.filter((r) => pinnedIds.has(r.id)));

  let suites = $derived([...new Set(allRuns.map((r) => r.suite_name))].sort());
  let branches = $derived([...new Set(allRuns.map((r) => r.branch).filter(Boolean))].sort());

  let hasActiveFilters = $derived(selectedSuite !== "all" || selectedBranch !== "all" || selectedStatus !== "all" || selectedDate !== "all" || searchQuery !== "");

  function dateThreshold(key: string): number {
    const now = Date.now();
    switch (key) {
      case "1h": return now - 60 * 60 * 1000;
      case "today": { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); }
      case "24h": return now - 24 * 60 * 60 * 1000;
      case "7d": return now - 7 * 24 * 60 * 60 * 1000;
      case "30d": return now - 30 * 24 * 60 * 60 * 1000;
      default: return 0;
    }
  }

  let runs = $derived(
    allRuns.filter((r) => {
      if (selectedSuite !== "all" && r.suite_name !== selectedSuite) return false;
      if (selectedBranch !== "all" && r.branch !== selectedBranch) return false;
      if (selectedStatus === "passed" && r.failed > 0) return false;
      if (selectedStatus === "failed" && r.failed === 0) return false;
      if (selectedStatus === "new_failures" && (r.new_failures ?? 0) === 0) return false;
      if (selectedDate !== "all" && new Date(r.created_at).getTime() < dateThreshold(selectedDate)) return false;
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
    total: dbSummary.total,
    passed: dbSummary.passed,
    failed: dbSummary.failed,
    newFailures: allRuns.filter((r) => (r.new_failures ?? 0) > 0).length,
  });

  function applyView(view: SavedView) {
    selectedSuite = view.filters.suite ?? "all";
    selectedBranch = view.filters.branch ?? "all";
    selectedStatus = view.filters.status ?? "all";
    selectedDate = view.filters.date ?? "all";
    searchQuery = view.filters.search ?? "";
  }

  async function saveCurrentView() {
    if (!saveViewName.trim()) return;
    const filters: Record<string, string> = {};
    if (selectedSuite !== "all") filters.suite = selectedSuite;
    if (selectedBranch !== "all") filters.branch = selectedBranch;
    if (selectedStatus !== "all") filters.status = selectedStatus;
    if (selectedDate !== "all") filters.date = selectedDate;
    if (searchQuery) filters.search = searchQuery;
    await createSavedView(saveViewName.trim(), "runs", filters);
    saveViewName = "";
    showSaveInput = false;
    savedViews = await fetchSavedViews("runs");
  }

  async function removeView(id: number) {
    await deleteSavedView(id);
    savedViews = await fetchSavedViews("runs");
  }

  function clearFilters() {
    selectedSuite = "all";
    selectedBranch = "all";
    selectedStatus = "all";
    selectedDate = "all";
    searchQuery = "";
  }

  async function pollLiveRuns() {
    try {
      const res = await authFetch(`${API_URL}/live/active`);
      if (res.ok) {
        const data = await res.json() as { runs: number[] };
        const newSet = new Set(data.runs);
        // If a run just finished (was live, no longer active), refresh the run list
        for (const id of liveRunIds) {
          if (!newSet.has(id)) {
            const data = await fetchRunsWithSummary();
            allRuns = data.runs;
            dbSummary = data.summary;
            break;
          }
        }
        liveRunIds = newSet;
      }
    } catch { /* ignore */ }
  }

  onMount(async () => {
    loadPins();
    try {
      const [runsData, views] = await Promise.all([
        fetchRunsWithSummary(),
        fetchSavedViews("runs"),
      ]);
      allRuns = runsData.runs;
      dbSummary = runsData.summary;
      savedViews = views;
      await pollLiveRuns();
      pollTimer = setInterval(pollLiveRuns, 5000);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load runs";
    } finally {
      loading = false;
    }
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
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

  function specName(path: string): string {
    return path.replace(/\\/g, "/").split("/").pop() ?? path;
  }

  function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  function formatTimestamp(iso: string): string {
    return new Date(iso).toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  }

  function passRate(r: Run): number {
    return r.total > 0 ? Math.round((r.passed / r.total) * 100) : 0;
  }

  function copySuite(e: MouseEvent, name: string) {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard.writeText(name);
    copiedSuite = name;
    setTimeout(() => copiedSuite = null, 1500);
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
      <select bind:value={selectedDate}>
        <option value="all">All time</option>
        <option value="1h">Last hour</option>
        <option value="today">Today</option>
        <option value="24h">Last 24h</option>
        <option value="7d">Last 7 days</option>
        <option value="30d">Last 30 days</option>
      </select>
      <div class="search-box">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>
        <input type="text" placeholder="Search runs..." bind:value={searchQuery} />
      </div>
    </div>
    <div class="header-actions">
      {#if hasActiveFilters}
        <button class="action-btn" onclick={() => { showSaveInput = !showSaveInput; }}>Save view</button>
        <button class="action-btn muted" onclick={clearFilters}>Clear</button>
      {/if}
      <button class="compare-link" class:active={compareMode} onclick={() => compareMode ? exitCompareMode() : compareMode = true}>
        {compareMode ? "Cancel compare" : "Compare runs"}
      </button>
    </div>
  </div>

  {#if savedViews.length > 0 || showSaveInput}
    <div class="views-bar">
      {#each savedViews as view}
        <div class="view-pill">
          <button class="view-pill-btn" onclick={() => applyView(view)}>{view.name}</button>
          <button class="view-pill-x" onclick={() => removeView(view.id)} title="Delete">&times;</button>
        </div>
      {/each}
      {#if showSaveInput}
        <form class="save-form" onsubmit={(e) => { e.preventDefault(); saveCurrentView(); }}>
          <input type="text" bind:value={saveViewName} placeholder="View name..." autofocus />
          <button type="submit" class="save-btn">Save</button>
        </form>
      {/if}
    </div>
  {/if}

  {#if !loading && allRuns.length > 0}
    <div class="summary-bar">
      <button class="summary-btn" class:active={selectedStatus === "all"} onclick={() => selectedStatus = "all"}>
        {stats.total} run{stats.total !== 1 ? "s" : ""}
      </button>
      <span class="sep">·</span>
      <button class="summary-btn summary-pass" class:active={selectedStatus === "passed"} onclick={() => selectedStatus = selectedStatus === "passed" ? "all" : "passed"}>
        {stats.passed} passed
      </button>
      <span class="sep">·</span>
      <button class="summary-btn summary-fail" class:active={selectedStatus === "failed"} onclick={() => selectedStatus = selectedStatus === "failed" ? "all" : "failed"}>
        {stats.failed} failed
      </button>
      {#if stats.newFailures > 0}
        <span class="sep">·</span>
        <button class="summary-btn summary-new" class:active={selectedStatus === "new_failures"} onclick={() => selectedStatus = selectedStatus === "new_failures" ? "all" : "new_failures"}>
          {stats.newFailures} with new failures
        </button>
      {/if}
      {#if selectedStatus !== "all"}
        <span class="sep">·</span>
        <span class="summary-filtered">showing {runs.length}</span>
      {/if}
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
    {#if pinnedRuns.length > 0}
      <div class="pinned-section">
        <h3 class="pinned-title">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" stroke-width="1">
            <path d="M9.5 2L13 5.5 10 8.5l.5 4.5-2-2-4 4 4-4-2-2L11 5.5z"/>
          </svg>
          Pinned
        </h3>
        <div class="pinned-list">
          {#each pinnedRuns as pr}
            <a href="/runs/{pr.id}" class="pinned-card">
              <span class="run-status-dot" class:pass={pr.failed === 0} class:fail={pr.failed > 0}></span>
              <span class="pinned-id">#{pr.id}</span>
              <span class="pinned-suite">{pr.suite_name}</span>
              {#if pr.failed > 0}
                <span class="fail-badge">{pr.failed} failed</span>
              {:else}
                <span class="pass-badge">passed</span>
              {/if}
              <span class="pinned-time">{timeAgo(pr.created_at)}</span>
              <button class="pin-btn pinned" title="Unpin" onclick={(e) => togglePin(e, pr.id)}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" stroke-width="1.5">
                  <path d="M9.5 2L13 5.5 10 8.5l.5 4.5-2-2-4 4 4-4-2-2L11 5.5z"/>
                </svg>
              </button>
            </a>
          {/each}
        </div>
      </div>
    {/if}

    <div class="run-list">
      {#each runs as run}
        <a href="/runs/{run.id}" class="run-card" class:compare-selected={compareMode && (compareA === run.id || compareB === run.id)}>
          {#if compareMode}
            <button class="compare-check" onclick={(e) => toggleCompareSelect(e, run.id)}>
              {#if compareA === run.id}
                <span class="compare-label">A</span>
              {:else if compareB === run.id}
                <span class="compare-label">B</span>
              {:else}
                <span class="compare-empty"></span>
              {/if}
            </button>
          {/if}
          <div class="card-left">
            <span class="run-status-dot" class:pass={run.failed === 0} class:fail={run.failed > 0}></span>
            <div class="card-info">
              <div class="card-title-row">
                <span class="run-id">#{run.id}</span>
                <span class="run-suite">{run.suite_name}</span>
                <button class="copy-btn" title="Copy suite name" onclick={(e) => copySuite(e, run.suite_name)}>
                  {#if copiedSuite === run.suite_name}
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.5 3.5 6.5-8"/></svg>
                  {:else}
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 11V3a1 1 0 011-1h8"/></svg>
                  {/if}
                </button>
                {#if liveRunIds.has(run.id)}
                  <span class="live-badge">LIVE</span>
                {:else if run.failed > 0}
                  <span class="fail-badge">{run.failed} failed</span>
                  {#if run.new_failures > 0}
                    <span class="new-fail-badge" title="{run.new_failures} test(s) that were not failing in the previous run">{run.new_failures} new</span>
                  {/if}
                {:else}
                  <span class="pass-badge">passed</span>
                {/if}
              </div>
              {#if run.spec_files && run.spec_files.length > 0}
                <div class="card-specs" title={run.spec_files.join("\n")}>
                  {#each run.spec_files.slice(0, 2) as file}
                    <span class="spec-chip">{specName(file)}</span>
                  {/each}
                  {#if run.spec_count > 2}
                    <span class="spec-chip more">+{run.spec_count - 2} more</span>
                  {/if}
                </div>
              {/if}
              <div class="card-meta">
                {#if run.branch}
                  <span class="meta-chip branch">{run.branch}</span>
                {/if}
                {#if run.commit_sha}
                  <span class="meta-chip mono">{run.commit_sha.slice(0, 7)}</span>
                {/if}
                <span>{formatDuration(run.duration_ms)}</span>
                <span class="meta-time" title={formatTimestamp(run.started_at)}>{formatTime(run.started_at)} · {timeAgo(run.started_at)}</span>
              </div>
            </div>
          </div>

          <div class="card-right">
            <button class="pin-btn" class:pinned={pinnedIds.has(run.id)} title={pinnedIds.has(run.id) ? "Unpin" : "Pin for quick access"} onclick={(e) => togglePin(e, run.id)}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill={pinnedIds.has(run.id) ? "currentColor" : "none"} stroke="currentColor" stroke-width="1.5">
                <path d="M9.5 2L13 5.5 10 8.5l.5 4.5-2-2-4 4 4-4-2-2L11 5.5z"/>
              </svg>
            </button>
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

{#if compareMode && compareA !== null && compareB !== null}
  <div class="compare-bar">
    <span class="compare-bar-text">
      Comparing <strong>#{compareA}</strong> vs <strong>#{compareB}</strong>
    </span>
    <a href="/compare?a={compareA}&b={compareB}" class="compare-go-btn">Compare</a>
    <button class="compare-swap-btn" title="Swap A and B" onclick={() => { const tmp = compareA; compareA = compareB; compareB = tmp; }}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 6h8M8 2l4 4-4 4"/></svg>
      Swap
    </button>
    <button class="compare-cancel-btn" onclick={exitCompareMode}>Cancel</button>
  </div>
{:else if compareMode}
  <div class="compare-bar">
    <span class="compare-bar-text">
      {#if compareA === null}
        Select the first run (A)
      {:else}
        Run <strong>#{compareA}</strong> selected — now select run B
      {/if}
    </span>
    <button class="compare-cancel-btn" onclick={exitCompareMode}>Cancel</button>
  </div>
{/if}

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

  .header-actions {
    display: flex; gap: 0.4rem; align-items: center;
  }

  .action-btn {
    padding: 0.35rem 0.65rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--text-secondary); font-size: 0.78rem;
    cursor: pointer; white-space: nowrap;
  }
  .action-btn:hover { background: var(--bg-hover); color: var(--text); }
  .action-btn.muted { color: var(--text-muted); }

  .compare-link {
    padding: 0.35rem 0.75rem; border: 1px solid var(--border); border-radius: 6px;
    color: var(--text-secondary); text-decoration: none; font-size: 0.8rem;
    background: none; cursor: pointer;
  }
  .compare-link:hover { background: var(--bg-hover); color: var(--text); }
  .compare-link.active { border-color: var(--link); color: var(--link); }

  .views-bar {
    display: flex; gap: 0.4rem; flex-wrap: wrap; align-items: center; margin-bottom: 0.75rem;
  }

  .view-pill {
    display: flex; align-items: center; border: 1px solid var(--border); border-radius: 16px;
    background: var(--bg); overflow: hidden;
  }

  .view-pill-btn {
    padding: 0.25rem 0.6rem; border: none; background: transparent;
    color: var(--text-secondary); font-size: 0.75rem; cursor: pointer; white-space: nowrap;
  }
  .view-pill-btn:hover { color: var(--link); }

  .view-pill-x {
    padding: 0.15rem 0.4rem 0.15rem 0; border: none; background: transparent;
    color: var(--text-muted); font-size: 0.85rem; cursor: pointer; line-height: 1;
  }
  .view-pill-x:hover { color: var(--color-fail); }

  .save-form {
    display: flex; gap: 0.3rem; align-items: center;
  }
  .save-form input {
    padding: 0.25rem 0.5rem; border: 1px solid var(--link); border-radius: 6px;
    background: var(--bg); color: var(--text); font-size: 0.78rem; outline: none; width: 130px;
  }
  .save-btn {
    padding: 0.25rem 0.5rem; border: none; border-radius: 6px;
    background: var(--link); color: #fff; font-size: 0.75rem; font-weight: 600; cursor: pointer;
  }

  .summary-bar {
    display: flex; align-items: center; gap: 0.4rem; font-size: 0.82rem; color: var(--text-secondary); margin-bottom: 0.75rem;
  }
  .sep { color: var(--border); }
  .summary-btn {
    background: none; border: none; padding: 0.15rem 0.35rem; border-radius: 4px;
    font: inherit; font-size: 0.82rem; color: var(--text-secondary); cursor: pointer;
    transition: background 0.1s;
  }
  .summary-btn:hover { background: var(--bg-secondary); }
  .summary-btn.active { background: var(--bg-secondary); font-weight: 600; }
  .summary-btn.summary-pass { color: var(--color-pass); font-weight: 600; }
  .summary-btn.summary-fail { color: var(--color-fail); font-weight: 600; }
  .summary-btn.summary-new { color: #d97706; font-weight: 600; }
  .summary-filtered { font-style: italic; color: var(--text-muted); font-size: 0.78rem; }

  .status-text { color: var(--text-secondary); }
  .status-text.err { color: var(--color-fail); }
  .empty { padding: 3rem 0; text-align: center; color: var(--text-secondary); }
  .hint { font-size: 0.875rem; color: var(--text-muted); }

  /* Pinned section */
  .pinned-section { margin-bottom: 1rem; }
  .pinned-title {
    display: flex; align-items: center; gap: 0.35rem;
    font-size: 0.78rem; font-weight: 600; color: var(--text-muted);
    margin-bottom: 0.4rem; text-transform: uppercase; letter-spacing: 0.03em;
  }
  .pinned-list { display: flex; flex-wrap: wrap; gap: 0.35rem; }
  .pinned-card {
    display: flex; align-items: center; gap: 0.4rem;
    padding: 0.35rem 0.6rem; border-radius: 6px;
    border: 1px solid var(--border); background: var(--bg-secondary);
    text-decoration: none; color: var(--text); font-size: 0.78rem;
    transition: border-color 0.15s;
  }
  .pinned-card:hover { border-color: var(--link); }
  .pinned-id { font-family: monospace; font-weight: 700; font-size: 0.75rem; }
  .pinned-suite { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pinned-time { color: var(--text-muted); font-size: 0.7rem; }

  .pin-btn {
    background: none; border: 1px solid var(--border); padding: 0.3rem; cursor: pointer;
    color: var(--text-muted); border-radius: 6px; display: inline-flex; align-items: center;
    transition: color 0.15s, border-color 0.15s, background 0.15s; flex-shrink: 0;
  }
  .pin-btn:hover { color: var(--link); border-color: var(--link); background: color-mix(in srgb, var(--link) 8%, transparent); }
  .pin-btn.pinned { color: var(--link); border-color: var(--link); background: color-mix(in srgb, var(--link) 10%, transparent); }

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
  .copy-btn {
    background: none; border: none; padding: 0.1rem; cursor: pointer;
    color: var(--text-muted); border-radius: 4px; display: inline-flex; align-items: center;
    opacity: 0; transition: opacity 0.15s;
  }
  .copy-btn:hover { color: var(--text-primary); background: var(--bg-hover, rgba(128,128,128,0.1)); }
  .run-card:hover .copy-btn { opacity: 1; }
  .new-fail-badge {
    padding: 0.1rem 0.4rem; border-radius: 8px; font-size: 0.65rem; font-weight: 600;
    background: color-mix(in srgb, #f59e0b 18%, transparent); color: #d97706;
  }
  .fail-badge {
    padding: 0.1rem 0.4rem; border-radius: 8px; font-size: 0.65rem; font-weight: 600;
    background: color-mix(in srgb, var(--color-fail) 15%, transparent); color: var(--color-fail);
  }
  .pass-badge {
    padding: 0.1rem 0.4rem; border-radius: 8px; font-size: 0.65rem; font-weight: 600;
    background: color-mix(in srgb, var(--color-pass) 15%, transparent); color: var(--color-pass);
  }
  .live-badge {
    padding: 0.1rem 0.45rem; border-radius: 8px; font-size: 0.6rem; font-weight: 700;
    background: var(--color-fail); color: #fff; letter-spacing: 0.05em;
    animation: live-pulse 2s ease-in-out infinite;
  }
  @keyframes live-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }

  .card-specs {
    display: flex; flex-wrap: wrap; gap: 0.3rem;
  }
  .spec-chip {
    padding: 0.08rem 0.35rem; border-radius: 4px; font-size: 0.68rem;
    font-family: monospace; background: var(--bg-secondary); color: var(--text-secondary);
    max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .spec-chip.more { font-family: inherit; font-style: italic; }

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

  /* Compare mode */
  .compare-check {
    display: flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; flex-shrink: 0;
    border: 2px solid var(--border); border-radius: 6px;
    background: none; cursor: pointer; transition: border-color 0.15s;
  }
  .compare-check:hover { border-color: var(--link); }
  .compare-label {
    font-size: 0.72rem; font-weight: 700; color: var(--link);
  }
  .compare-empty { width: 12px; height: 12px; }
  .run-card.compare-selected { border-color: var(--link); background: color-mix(in srgb, var(--link) 4%, var(--bg)); }

  .compare-bar {
    position: fixed; bottom: 0; left: 0; right: 0; z-index: 100;
    display: flex; align-items: center; gap: 0.75rem;
    padding: 0.75rem 2rem;
    background: var(--bg-secondary); border-top: 1px solid var(--border);
    box-shadow: 0 -2px 8px rgba(0,0,0,0.08);
  }
  .compare-bar-text { font-size: 0.85rem; color: var(--text-secondary); }
  .compare-go-btn {
    padding: 0.4rem 1rem; border: none; border-radius: 6px;
    background: var(--link); color: #fff; font-size: 0.82rem; font-weight: 600;
    text-decoration: none; cursor: pointer;
  }
  .compare-go-btn:hover { opacity: 0.9; }
  .compare-swap-btn {
    display: flex; align-items: center; gap: 0.25rem;
    padding: 0.35rem 0.6rem; border: 1px solid var(--border); border-radius: 6px;
    background: none; color: var(--text-secondary); font-size: 0.78rem; cursor: pointer;
  }
  .compare-swap-btn:hover { color: var(--text); border-color: var(--text-muted); }
  .compare-cancel-btn {
    padding: 0.35rem 0.6rem; border: 1px solid var(--border); border-radius: 6px;
    background: none; color: var(--text-muted); font-size: 0.78rem; cursor: pointer;
    margin-left: auto;
  }
  .compare-cancel-btn:hover { color: var(--text); border-color: var(--text-muted); }
</style>
