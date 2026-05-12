<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { page } from "$app/stores";
  import { replaceState } from "$app/navigation";
  import { fetchRunsWithSummary, fetchSavedViews, createSavedView, deleteSavedView, type Run, type RunsSummary, type SavedView } from "$lib/api";
  import { getAuth } from "$lib/auth";
  import { API_URL } from "$lib/config";

  function focusOnMount(node: HTMLElement) {
    node.focus();
  }

  let allRuns = $state<Run[]>([]);
  let dbSummary = $state<RunsSummary>({ total: 0, passed: 0, failed: 0 });
  let hasMore = $state(false);
  let loadingMore = $state(false);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let liveRunIds = $state<Set<number>>(new Set());
  let liveStream: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let selectedSuite = $state("all");
  let selectedBranch = $state("all");
  let selectedEnv = $state("all");
  let selectedStatus = $state("all");
  let selectedDate = $state("7d");
  let searchQuery = $state("");

  function syncFiltersToUrl() {
    const url = new URL(window.location.href);
    const set = (k: string, v: string, def: string) => {
      if (v && v !== def) url.searchParams.set(k, v);
      else url.searchParams.delete(k);
    };
    set("suite", selectedSuite, "all");
    set("branch", selectedBranch, "all");
    set("env", selectedEnv, "all");
    set("status", selectedStatus, "all");
    set("date", selectedDate, "7d");
    set("q", searchQuery, "");
    replaceState(url, {});
  }

  function readFiltersFromUrl() {
    const p = $page.url.searchParams;
    selectedSuite = p.get("suite") ?? "all";
    selectedBranch = p.get("branch") ?? "all";
    selectedEnv = p.get("env") ?? "all";
    selectedStatus = p.get("status") ?? "all";
    selectedDate = p.get("date") ?? "7d";
    searchQuery = p.get("q") ?? "";
  }

  let mounted = $state(false);
  $effect(() => {
    // Access all filter values to create dependency
    selectedSuite; selectedBranch; selectedEnv; selectedStatus; selectedDate; searchQuery;
    if (mounted) syncFiltersToUrl();
  });

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
  let environments = $derived(
    [...new Set(allRuns.map((r) => r.environment).filter((e): e is string => Boolean(e)))].sort()
  );

  let hasActiveFilters = $derived(selectedSuite !== "all" || selectedBranch !== "all" || selectedEnv !== "all" || selectedStatus !== "all" || selectedDate !== "7d" || searchQuery !== "");

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
      if (selectedEnv !== "all" && (r.environment ?? "") !== selectedEnv) return false;
      if (selectedStatus === "passed" && r.failed > 0) return false;
      if (selectedStatus === "failed" && r.failed === 0) return false;
      if (selectedStatus === "new_failures" && (r.new_failures ?? 0) === 0) return false;
      if (selectedDate !== "all" && new Date(r.created_at).getTime() < dateThreshold(selectedDate)) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return r.suite_name.toLowerCase().includes(q)
          || r.branch?.toLowerCase().includes(q)
          || r.commit_sha?.toLowerCase().includes(q)
          || r.environment?.toLowerCase().includes(q)
          || String(r.id).includes(q);
      }
      return true;
    })
  );

  let stats = $derived({
    total: runs.length,
    passed: runs.filter((r) => r.failed === 0).length,
    failed: runs.filter((r) => r.failed > 0).length,
    newFailures: runs.filter((r) => (r.new_failures ?? 0) > 0).length,
  });

  function applyView(view: SavedView) {
    selectedSuite = view.filters.suite ?? "all";
    selectedBranch = view.filters.branch ?? "all";
    selectedEnv = view.filters.env ?? "all";
    selectedStatus = view.filters.status ?? "all";
    selectedDate = view.filters.date ?? "7d";
    searchQuery = view.filters.search ?? "";
  }

  async function saveCurrentView() {
    if (!saveViewName.trim()) return;
    const filters: Record<string, string> = {};
    if (selectedSuite !== "all") filters.suite = selectedSuite;
    if (selectedBranch !== "all") filters.branch = selectedBranch;
    if (selectedEnv !== "all") filters.env = selectedEnv;
    if (selectedStatus !== "all") filters.status = selectedStatus;
    if (selectedDate !== "7d") filters.date = selectedDate;
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

  async function loadMore() {
    if (loadingMore || !hasMore) return;
    loadingMore = true;
    try {
      const data = await fetchRunsWithSummary(allRuns.length);
      allRuns = [...allRuns, ...data.runs];
      hasMore = data.hasMore;
    } catch { /* ignore */ }
    loadingMore = false;
  }

  function clearFilters() {
    selectedSuite = "all";
    selectedBranch = "all";
    selectedEnv = "all";
    selectedStatus = "all";
    selectedDate = "7d";
    searchQuery = "";
  }

  async function refreshRuns() {
    try {
      const refreshed = await fetchRunsWithSummary(0, allRuns.length || 50);
      allRuns = refreshed.runs;
      dbSummary = refreshed.summary;
      hasMore = refreshed.hasMore;
    } catch { /* ignore */ }
  }

  // Org-scoped SSE replaces the prior 5 s /live/active poll. The
  // backend sends a `snapshot` on connect, then `active.add` /
  // `active.remove` deltas as runs enter or leave the active set.
  // EventSource auto-reconnects on transient network drops, but on
  // hard errors (auth, server-side close) we back off and retry
  // explicitly to avoid a tight reconnect loop.
  function connectLiveStream() {
    if (liveStream) return;
    const token = getAuth().token;
    if (!token) return;

    const es = new EventSource(`${API_URL}/live/stream?token=${token}`);
    liveStream = es;

    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as
          | { type: "snapshot"; runs: number[] }
          | { type: "active.add"; runId: number }
          | { type: "active.remove"; runId: number };

        if (msg.type === "snapshot") {
          const newSet = new Set(msg.runs);
          // On reconnect the snapshot may differ from current state —
          // refetch so terminal stats / new rows show up. On first
          // connect (post-onMount fetch) newSet usually equals the
          // empty initial state, so this is a no-op.
          const changed = newSet.size !== liveRunIds.size
            || [...newSet].some((id) => !liveRunIds.has(id));
          liveRunIds = newSet;
          if (changed) void refreshRuns();
        } else if (msg.type === "active.add") {
          if (liveRunIds.has(msg.runId)) return;
          liveRunIds = new Set([...liveRunIds, msg.runId]);
          void refreshRuns();
        } else if (msg.type === "active.remove") {
          if (!liveRunIds.has(msg.runId)) return;
          const next = new Set(liveRunIds);
          next.delete(msg.runId);
          liveRunIds = next;
          void refreshRuns();
        }
      } catch { /* ignore parse errors */ }
    };

    es.onerror = () => {
      es.close();
      liveStream = null;
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connectLiveStream();
        }, 5000);
      }
    };
  }

  onMount(async () => {
    readFiltersFromUrl();
    loadPins();
    try {
      const [runsData, views] = await Promise.all([
        fetchRunsWithSummary(),
        fetchSavedViews("runs"),
      ]);
      allRuns = runsData.runs;
      dbSummary = runsData.summary;
      hasMore = runsData.hasMore;
      savedViews = views;
      connectLiveStream();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load runs";
    } finally {
      loading = false;
      mounted = true;
    }
  });

  onDestroy(() => {
    if (liveStream) { liveStream.close(); liveStream = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
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

  // Programmatic navigation on row activation — the whole <tr> is the
  // click target, mirroring the /manual-tests table pattern.
  function openRun(id: number) {
    window.location.href = `/runs/${id}`;
  }
  function onRowActivate(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      (e.currentTarget as HTMLElement).click();
    }
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
      {#if environments.length > 0}
        <select bind:value={selectedEnv}>
          <option value="all">All environments</option>
          {#each environments as env}
            <option value={env}>{env}</option>
          {/each}
        </select>
      {/if}
      <div class="filter-tabs">
        {#each [["all", "All time"], ["1h", "Last hour"], ["today", "Today"], ["24h", "24h"], ["7d", "7 days"], ["30d", "30 days"]] as [value, label]}
          <button class="filter-tab" class:active={selectedDate === value} onclick={() => selectedDate = value}>{label}</button>
        {/each}
      </div>
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
          <input type="text" bind:value={saveViewName} placeholder="View name..." use:focusOnMount />
          <button type="submit" class="save-btn">Save</button>
        </form>
      {/if}
    </div>
  {/if}

  {#if !loading && allRuns.length > 0}
    <div class="status-tab-row">
      <div class="filter-tabs">
        <button class="filter-tab" class:active={selectedStatus === "all"} onclick={() => selectedStatus = "all"}>
          All <span class="tab-count">{stats.total}</span>
        </button>
        <button class="filter-tab pass" class:active={selectedStatus === "passed"} onclick={() => selectedStatus = selectedStatus === "passed" ? "all" : "passed"}>
          Passed <span class="tab-count">{stats.passed}</span>
        </button>
        <button class="filter-tab fail" class:active={selectedStatus === "failed"} onclick={() => selectedStatus = selectedStatus === "failed" ? "all" : "failed"}>
          Failed <span class="tab-count">{stats.failed}</span>
        </button>
        {#if stats.newFailures > 0}
          <button class="filter-tab new" class:active={selectedStatus === "new_failures"} onclick={() => selectedStatus = selectedStatus === "new_failures" ? "all" : "new_failures"}>
            New failures <span class="tab-count">{stats.newFailures}</span>
          </button>
        {/if}
      </div>
      {#if selectedStatus !== "all"}
        <span class="status-filtered">showing {runs.length}</span>
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
              <span class="run-status-dot" class:live={liveRunIds.has(pr.id)} class:pass={pr.failed === 0} class:fail={pr.failed > 0}></span>
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

    <table class="runs-table">
      <thead>
        <tr>
          {#if compareMode}
            <th class="col-compare" aria-label="Compare select"></th>
          {/if}
          <th class="col-status" aria-label="Status"></th>
          <th class="col-id">#</th>
          <th class="col-state">State</th>
          <th class="col-suite">Suite</th>
          <th class="col-branch">Branch</th>
          <th class="col-env">Env</th>
          <th class="col-reporter">Reporter</th>
          <th class="col-num">Pass</th>
          <th class="col-num">Fail</th>
          <th class="col-num">Skip</th>
          <th class="col-num">Pass %</th>
          <th class="col-duration">Duration</th>
          <th class="col-started">Started</th>
          <th class="col-actions" aria-label="Row actions"></th>
        </tr>
      </thead>
      <tbody>
        {#each runs as run}
          <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role:
               whole row is the click target, mirroring /manual-tests. -->
          <tr
            role="button"
            tabindex="0"
            class="run-row"
            class:compare-selected={compareMode && (compareA === run.id || compareB === run.id)}
            data-run-id={run.id}
            data-href="/runs/{run.id}"
            onclick={() => openRun(run.id)}
            onkeydown={onRowActivate}
          >
            {#if compareMode}
              <td class="col-compare">
                <button class="compare-check" onclick={(e) => toggleCompareSelect(e, run.id)}>
                  {#if compareA === run.id}
                    <span class="compare-label">A</span>
                  {:else if compareB === run.id}
                    <span class="compare-label">B</span>
                  {:else}
                    <span class="compare-empty"></span>
                  {/if}
                </button>
              </td>
            {/if}
            <td class="col-status">
              <span class="run-status-dot" class:live={liveRunIds.has(run.id)} class:pass={run.failed === 0 && !run.aborted} class:fail={run.failed > 0} class:aborted={run.aborted}></span>
            </td>
            <td class="col-id"><span class="run-id">#{run.id}</span></td>
            <td class="col-state">
              <!-- Dedicated badge column so the primary state (LIVE /
                   aborted / passed / failed) aligns visually across
                   rows, regardless of how long the suite name is. -->
              {#if liveRunIds.has(run.id)}
                <span class="live-badge">LIVE</span>
              {:else if run.aborted}
                <span class="aborted-badge" title="Run was aborted before it completed (Ctrl-C, stale timeout, or explicit /abort)">aborted</span>
              {:else if run.failed > 0}
                <span class="fail-badge">failed</span>
                {#if run.new_failures > 0}
                  <span class="new-fail-badge" title="{run.new_failures} test(s) that were not failing in the previous run">{run.new_failures} new</span>
                {/if}
              {:else}
                <span class="pass-badge">passed</span>
              {/if}
            </td>
            <td class="col-suite">
              <div class="suite-cell">
                <span class="run-suite" title={run.suite_name}>{run.suite_name}</span>
                <button class="copy-btn" title="Copy suite name" onclick={(e) => copySuite(e, run.suite_name)}>
                  {#if copiedSuite === run.suite_name}
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.5 3.5 6.5-8"/></svg>
                  {:else}
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 11V3a1 1 0 011-1h8"/></svg>
                  {/if}
                </button>
                {#if run.commit_sha}
                  <span class="meta-chip mono commit-chip" title={run.commit_sha}>{run.commit_sha.slice(0, 7)}</span>
                {/if}
                {#if run.ci_run_id}
                  <span class="meta-chip mono ci" title={run.ci_run_id}>{run.ci_run_id}</span>
                {/if}
              </div>
            </td>
            <td class="col-branch">
              {#if run.branch}<span class="meta-chip branch" title={run.branch}>{run.branch}</span>{:else}<span class="dim">—</span>{/if}
            </td>
            <td class="col-env">
              {#if run.environment}<span class="meta-chip env" title={run.environment}>{run.environment}</span>{:else}<span class="dim">—</span>{/if}
            </td>
            <td class="col-reporter">
              {#if run.reporter}<span class="meta-chip reporter" title={run.reporter}>{run.reporter}</span>{:else}<span class="dim">—</span>{/if}
            </td>
            <td class="col-num stat-pass">{run.passed}</td>
            <td class="col-num" class:stat-fail={run.failed > 0}>{run.failed}</td>
            <td class="col-num dim">{run.skipped + run.pending}</td>
            <td class="col-num pass-pct">{passRate(run)}%</td>
            <td class="col-duration">{formatDuration(run.duration_ms)}</td>
            <td class="col-started" title={formatTimestamp(run.started_at)}>
              <div class="started-cell">
                <span>{formatTime(run.started_at)}</span>
                <span class="dim">{timeAgo(run.started_at)}</span>
              </div>
            </td>
            <td class="col-actions">
              <button class="pin-btn" class:pinned={pinnedIds.has(run.id)} title={pinnedIds.has(run.id) ? "Unpin" : "Pin for quick access"} onclick={(e) => togglePin(e, run.id)}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill={pinnedIds.has(run.id) ? "currentColor" : "none"} stroke="currentColor" stroke-width="1.5">
                  <path d="M9.5 2L13 5.5 10 8.5l.5 4.5-2-2-4 4 4-4-2-2L11 5.5z"/>
                </svg>
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if hasMore}
      <div class="load-more">
        <button class="load-more-btn" onclick={loadMore} disabled={loadingMore}>
          {loadingMore ? "Loading..." : `Load more (showing ${allRuns.length} of ${dbSummary.total})`}
        </button>
      </div>
    {/if}
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
  .page { max-width: 1920px; margin: 0 auto; padding: 1.5rem 2rem; }

  .header {
    display: flex; align-items: center; justify-content: space-between;
    gap: 0.75rem; margin-bottom: 1rem; flex-wrap: wrap;
  }
  .filters { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
  select {
    padding: 0.35rem 0.6rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--text); font-size: 0.85rem;
  }

  /* .filter-tabs / .filter-tab base styles live in src/app.css. */

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

  /* Status filter tabs — same segmented-control style as /flaky,
     /errors, /slowest, /manual-tests. Three status-modifier classes
     (.pass, .fail, .new) tint the COUNT pill only, so the row reads
     like a consistent control row while still surfacing pass/fail
     proportions at a glance. */
  .status-tab-row {
    display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;
  }
  .tab-count {
    display: inline-block;
    margin-left: 0.35rem;
    padding: 0.05rem 0.4rem;
    border-radius: 8px;
    background: var(--bg-hover, var(--bg-secondary));
    color: var(--text-secondary);
    font-size: 0.7rem;
    font-weight: 600;
    line-height: 1.4;
  }
  .filter-tab.pass .tab-count { background: color-mix(in srgb, var(--color-pass) 18%, transparent); color: var(--color-pass); }
  .filter-tab.fail .tab-count { background: color-mix(in srgb, var(--color-fail) 18%, transparent); color: var(--color-fail); }
  .filter-tab.new  .tab-count { background: color-mix(in srgb, #d97706 18%, transparent); color: #d97706; }
  .status-filtered { font-style: italic; color: var(--text-muted); font-size: 0.78rem; }

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

  /* ── Runs table ─────────────────────────────────────────────────────
     Dense table layout (mirrors /manual-tests). The whole <tr> is the
     click target; pin + compare-check live inside cells with
     stopPropagation so clicking them doesn't navigate.

     `table-layout: fixed` keeps columns in lock-step across rows —
     without it, a long suite name on one row would push the right
     side over relative to other rows. With it, column widths come
     from the <th> widths below and rows align regardless of content. */
  .runs-table {
    width: 100%;
    table-layout: fixed;
    border-collapse: collapse;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    font-size: 0.85rem;
  }
  .runs-table th, .runs-table td {
    padding: 0.55rem 0.75rem;
    text-align: left;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
    overflow: hidden;
  }
  .runs-table th {
    background: var(--bg-secondary);
    color: var(--text-muted);
    font-weight: 600;
    text-transform: uppercase;
    font-size: 0.68rem;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .runs-table tbody tr:last-child td { border-bottom: none; }
  .runs-table tbody tr.run-row { cursor: pointer; transition: background 0.1s; }
  .runs-table tbody tr.run-row:hover { background: var(--bg-hover); }
  .runs-table tbody tr.run-row:focus-visible { outline: 2px solid var(--link); outline-offset: -2px; }
  .runs-table tbody tr.run-row.compare-selected {
    background: color-mix(in srgb, var(--link) 8%, var(--bg));
  }

  /* Fixed column widths — the Suite column is the only flexible one;
     it absorbs the remaining width and ellipsis-clips past that. The
     numeric columns use tabular-nums so digits stay aligned. */
  .col-compare { width: 36px; }
  .col-status { width: 28px; padding-right: 0; }
  .col-id { width: 64px; }
  .col-state { width: 110px; white-space: nowrap; }
  .col-suite { width: auto; }
  .col-branch { width: 140px; }
  .col-env { width: 100px; }
  .col-reporter { width: 110px; }
  .col-num { width: 60px; text-align: right; font-variant-numeric: tabular-nums; }
  .col-duration { width: 80px; white-space: nowrap; }
  .col-started { width: 150px; white-space: nowrap; }
  .col-actions { width: 40px; text-align: right; padding-left: 0; }

  .run-status-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
  .run-status-dot.pass { background: var(--color-pass); }
  .run-status-dot.fail { background: var(--color-fail); }
  .run-status-dot.aborted { background: var(--text-muted); }
  .run-status-dot.live { background: #3b82f6; animation: live-pulse 2s ease-in-out infinite; }

  .run-id { font-weight: 700; font-family: monospace; color: var(--text); }
  .run-suite {
    font-weight: 500; color: var(--text);
    /* Long suite names clip with an ellipsis so the row height stays
       fixed and the right-hand columns don't shift. Hover tooltip
       (set via `title` on the <span>) gives the full name on demand. */
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    min-width: 0; flex: 1 1 auto; max-width: 100%;
  }
  .dim { color: var(--text-muted); }

  .suite-cell {
    /* No-wrap: every chip stays on one line. Excess content is hidden
       by the parent <td>'s overflow:hidden — chips with their own
       max-width get their own ellipsis. */
    display: flex; align-items: center; gap: 0.45rem;
    flex-wrap: nowrap; min-width: 0;
  }
  .started-cell { display: flex; gap: 0.4rem; align-items: baseline; font-size: 0.78rem; }

  .copy-btn {
    background: none; border: none; padding: 0.1rem; cursor: pointer;
    color: var(--text-muted); border-radius: 4px;
    display: inline-flex; align-items: center;
    opacity: 0; transition: opacity 0.15s;
  }
  .copy-btn:hover { color: var(--text); background: var(--bg-hover, rgba(128,128,128,0.1)); }
  .run-row:hover .copy-btn { opacity: 1; }

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
  .aborted-badge {
    padding: 0.1rem 0.4rem; border-radius: 8px; font-size: 0.65rem; font-weight: 600;
    background: var(--bg-secondary); color: var(--text-muted); border: 1px dashed var(--border);
    text-transform: lowercase; letter-spacing: 0.02em;
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

  .meta-chip {
    padding: 0.1rem 0.35rem; border-radius: 4px; font-size: 0.68rem;
    background: var(--bg-secondary); color: var(--text-secondary);
    /* Every chip truncates: nowrap + overflow-hidden + ellipsis. The
       per-chip max-widths below cap each one to a reasonable size; the
       default keeps small chips small. */
    display: inline-block;
    max-width: 100%;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    vertical-align: middle;
  }
  /* Per-chip caps — Branch/Env/Reporter live in their own columns so
     they fill the column width; CI / commit chips sit inline in the
     suite cell so they get their own narrower caps. */
  .col-branch .meta-chip.branch,
  .col-env .meta-chip.env,
  .col-reporter .meta-chip.reporter { max-width: 100%; }
  .meta-chip.branch { font-weight: 500; }
  .meta-chip.env {
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: color-mix(in srgb, var(--link, #4c8bf5) 14%, var(--bg-secondary));
    color: var(--text-primary);
  }
  .meta-chip.mono { font-family: monospace; }
  .meta-chip.ci {
    max-width: 160px;
  }
  .meta-chip.commit-chip {
    max-width: 80px;
    color: var(--text-muted);
  }
  .meta-chip.reporter {
    text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600;
    font-size: 0.65rem;
    background: color-mix(in srgb, var(--text-secondary) 12%, var(--bg-secondary));
    color: var(--text);
  }

  .stat-pass { color: var(--color-pass); font-weight: 700; }
  .stat-fail { color: var(--color-fail); font-weight: 700; }
  .pass-pct { font-weight: 700; color: var(--text-secondary); }

  /* Compare mode — the check moves into a leading cell. */
  .compare-check {
    display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 24px;
    border: 2px solid var(--border); border-radius: 6px;
    background: none; cursor: pointer; transition: border-color 0.15s;
  }
  .compare-check:hover { border-color: var(--link); }
  .compare-label {
    font-size: 0.72rem; font-weight: 700; color: var(--link);
  }
  .compare-empty { width: 10px; height: 10px; }

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
