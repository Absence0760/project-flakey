<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { timeAgo, absoluteDate, formatDuration } from "$lib/utils/format";
  import { page } from "$app/stores";
  import { goto, replaceState } from "$app/navigation";
  import { fetchRunsWithSummary, fetchSavedViews, createSavedView, deleteSavedView, type Run, type RunsSummary, type SavedView } from "$lib/api";
  import { getAuth } from "$lib/stores/auth";
  import { API_URL } from "$lib/utils/config";
  import StatusDot from "$lib/components/status/StatusDot.svelte";
  import { passRate } from "$lib/utils/stats";

  function focusOnMount(node: HTMLElement) {
    node.focus();
  }

  let allRuns = $state<Run[]>([]);
  let dbSummary = $state<RunsSummary>({ total: 0, passed: 0, failed: 0, incomplete: 0 });
  let hasMore = $state(false);
  // Set by the SvelteKit snapshot's restore() on back-nav. onMount's initial
  // fetch checks this AFTER its await so it doesn't clobber the restored rows
  // (and scroll position) with a fresh first-page-of-50.
  let restoredFromSnapshot = false;
  let loadingMore = $state(false);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let liveRunIds = $state<Set<number>>(new Set());
  // Flips true once the /live/stream EventSource delivers its first message
  // (the backend sends a `snapshot` on connect). Surfaced as
  // data-sse-connected on the page root so e2e can wait on a real handshake
  // signal instead of sleeping before firing /live/start.
  let sseConnected = $state(false);
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
  let showFilterPopover = $state(false);

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
      // Aborted runs aren't "passed" — they finished without running to
      // completion. Bucket them out of the Passed tab; they still show
      // up under All.
      if (selectedStatus === "passed" && (r.failed > 0 || r.aborted)) return false;
      if (selectedStatus === "failed" && r.failed === 0 && !r.aborted) return false;
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
    passed: runs.filter((r) => r.failed === 0 && !r.aborted).length,
    failed: runs.filter((r) => r.failed > 0 || r.aborted).length,
    newFailures: runs.filter((r) => (r.new_failures ?? 0) > 0).length,
  });

  // Show Load more only when fetching more rows could realistically
  // surface more matches for the current filter. Without this guard
  // the button appears "as if All time were selected" — the user has
  // 7d picked but only 32 of the loaded 50 match, and clicking Load
  // more would fetch older rows that almost certainly don't match
  // either. Two cases to suppress:
  //
  //   1. A date filter is active AND the oldest loaded run already
  //      sits past the threshold — runs are sorted desc by created_at,
  //      so anything older won't match either.
  //   2. Any non-date filter narrowed the loaded set to nothing — the
  //      user filtered to an empty state, fetching more rows of the
  //      same DB shape won't help.
  let oldestLoadedAge = $derived(
    allRuns.length > 0 ? Date.now() - new Date(allRuns[allRuns.length - 1].created_at).getTime() : 0
  );
  let dateFilterExhausted = $derived(
    selectedDate !== "all" && oldestLoadedAge > Date.now() - dateThreshold(selectedDate)
  );
  let showLoadMore = $derived(hasMore && !dateFilterExhausted);

  // Page-level summary for the tile strip. `dbSummary` is the org's
  // database totals (always-on). `newFailuresAcrossLoaded` is computed
  // from rows we've actually fetched — the backend doesn't surface a
  // new-failure total in /runs/summary, and counting only loaded rows
  // is good enough for an at-a-glance signal.
  let newFailuresAcrossLoaded = $derived(allRuns.filter((r) => (r.new_failures ?? 0) > 0).length);

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
      // Any delivered message means the EventSource handshake is complete;
      // the backend's first message is always the `snapshot`.
      sseConnected = true;
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
      sseConnected = false;
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
      savedViews = views;
      // A restored snapshot (back-nav) already holds the full set of loaded
      // rows and the scroll position — don't overwrite it with the fresh
      // first page. The restore runs synchronously at mount, well before this
      // network call resolves, so the flag is reliably set by now.
      if (!restoredFromSnapshot) {
        allRuns = runsData.runs;
        dbSummary = runsData.summary;
        hasMore = runsData.hasMore;
      }
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

  // SvelteKit snapshot — capture loaded rows + scroll position when
  // the user navigates away (e.g. to /runs/<id>) so back-nav lands
  // on the same row at the same scroll position. Without this, back
  // re-mounts the page with the default 50 rows and scroll at top,
  // forcing the user to Load more again to find where they were.
  export const snapshot = {
    capture: () => ({
      allRuns,
      dbSummary,
      hasMore,
      scrollY: typeof window !== "undefined" ? window.scrollY : 0,
    }),
    restore: (s: { allRuns: Run[]; dbSummary: RunsSummary; hasMore: boolean; scrollY: number }) => {
      allRuns = s.allRuns;
      dbSummary = s.dbSummary;
      hasMore = s.hasMore;
      loading = false;
      restoredFromSnapshot = true;
      // Restore scroll only after the restored rows are actually in the DOM —
      // otherwise the page is still short and scrollTo gets clamped to the
      // top. tick() awaits Svelte's flush; the rAF waits for the browser to
      // lay the rows out before we set scrollY.
      tick().then(() => requestAnimationFrame(() =>
        window.scrollTo({ top: s.scrollY, behavior: "instant" as ScrollBehavior })
      ));
    },
  };


  function copySuite(e: MouseEvent, name: string) {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard.writeText(name);
    copiedSuite = name;
    setTimeout(() => copiedSuite = null, 1500);
  }

  // Programmatic navigation on row activation — the whole <tr> is the
  // click target, mirroring the /manual-tests table pattern. Use SvelteKit's
  // client-side goto() (not window.location, which forces a full document
  // reload that re-boots the SPA) so it matches the pinned-run <a href> links.
  function openRun(id: number) {
    goto(`/runs/${id}`);
  }
  function onRowActivate(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      (e.currentTarget as HTMLElement).click();
    }
  }
</script>

<!-- data-ready flips once the onMount fetch settles (loaded OR error);
     data-sse-connected flips once the live-stream EventSource handshake
     completes. Both are content-agnostic readiness gates for e2e — see
     frontend/tests-e2e/README.md § "Readiness signals". -->
<div class="page" data-ready={!loading ? "true" : undefined} data-sse-connected={sseConnected ? "true" : undefined}>
  <!-- Summary tile strip — mirrors /releases and /manual-tests. Uses
       the database-wide totals so the numbers don't jump around when
       the user filters the list below. -->
  {#if !loading && dbSummary.total > 0}
    <section class="summary">
      <div class="stat"><span class="stat-label">Total runs</span><span class="stat-value">{dbSummary.total}</span></div>
      <div class="stat pass"><span class="stat-label">Passed</span><span class="stat-value">{dbSummary.passed}</span></div>
      <div class="stat" class:fail={dbSummary.failed > 0}><span class="stat-label">Failed</span><span class="stat-value">{dbSummary.failed}</span></div>
      {#if dbSummary.incomplete > 0}
        <!-- In-progress runs (finished_at IS NULL) are excluded from
             Passed/Failed so a not-yet-finished run can't be read as a pass. -->
        <div class="stat"><span class="stat-label">In progress</span><span class="stat-value">{dbSummary.incomplete}</span></div>
      {/if}
      <div class="stat" class:risk={newFailuresAcrossLoaded > 0}><span class="stat-label">New failures</span><span class="stat-value">{newFailuresAcrossLoaded}</span></div>
    </section>
  {/if}

  <!-- Primary toolbar: status filter tabs on the left, action cluster
       (compare, save view, clear) on the right. Same layout as
       /releases and /manual-tests so the page feels like part of one
       app rather than a one-off layout. -->
  {#if !loading && allRuns.length > 0}
    <div class="toolbar">
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

      <div class="toolbar-right">
        {#if hasActiveFilters}
          <span class="filter-summary">showing {runs.length}</span>
          <button class="btn-ghost" onclick={() => { showSaveInput = !showSaveInput; }}>Save view</button>
          <button class="btn-ghost muted" onclick={clearFilters}>Clear</button>
        {/if}
        <button class="btn-ghost" class:active={compareMode} onclick={() => compareMode ? exitCompareMode() : compareMode = true}>
          {compareMode ? "Cancel compare" : "Compare runs"}
        </button>
      </div>
    </div>

    <!-- Secondary filter row: date tabs (most-used) + search + a
         "Filters" pill that opens a popover for the long-tail
         dropdowns (suite/branch/env). Keeping the suite <select> in
         a `.filters` wrapper preserves the e2e-test selector
         `.filters select` even though the wrapper is now in the
         popover. -->
    <div class="filter-row">
      <div class="filter-tabs date-tabs">
        {#each [["all", "All time"], ["1h", "Last hour"], ["today", "Today"], ["24h", "24h"], ["7d", "7 days"], ["30d", "30 days"]] as [value, label]}
          <button class="filter-tab" class:active={selectedDate === value} onclick={() => selectedDate = value}>{label}</button>
        {/each}
      </div>

      <div class="filter-row-right">
        <div class="search-box">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>
          <input type="text" placeholder="Search runs..." bind:value={searchQuery} />
        </div>

        <!-- Filter popover trigger. Active when any dropdown filter is
             non-default — gives the user a visible signal that there
             are filters in play beyond the visible date/search. -->
        <div class="filter-popover-wrap">
          <button
            class="btn-ghost filter-trigger"
            class:active={selectedSuite !== "all" || selectedBranch !== "all" || selectedEnv !== "all"}
            onclick={() => showFilterPopover = !showFilterPopover}
            aria-expanded={showFilterPopover}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 3h12M4 8h8M6 13h4"/></svg>
            Filters
            {#if selectedSuite !== "all" || selectedBranch !== "all" || selectedEnv !== "all"}
              <span class="filter-dot" aria-hidden="true"></span>
            {/if}
          </button>
          {#if showFilterPopover}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="filter-backdrop" onclick={() => showFilterPopover = false}></div>
            <div class="filter-popover filters">
              <label class="filter-field">
                <span class="filter-field-label">Suite</span>
                <select bind:value={selectedSuite}>
                  <option value="all">All suites</option>
                  {#each suites as suite}
                    <option value={suite}>{suite}</option>
                  {/each}
                </select>
              </label>
              {#if branches.length > 1}
                <label class="filter-field">
                  <span class="filter-field-label">Branch</span>
                  <select bind:value={selectedBranch}>
                    <option value="all">All branches</option>
                    {#each branches as branch}
                      <option value={branch}>{branch}</option>
                    {/each}
                  </select>
                </label>
              {/if}
              {#if environments.length > 0}
                <label class="filter-field">
                  <span class="filter-field-label">Environment</span>
                  <select bind:value={selectedEnv}>
                    <option value="all">All environments</option>
                    {#each environments as env}
                      <option value={env}>{env}</option>
                    {/each}
                  </select>
                </label>
              {/if}
            </div>
          {/if}
        </div>
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
      <!-- Pinned band — same structural pattern as the at-risk band
           on /releases (tinted background + left-edge stripe), but
           keyed to var(--link) since pinned isn't a risk signal. -->
      <section class="pinned-band" aria-label="Pinned runs">
        <header class="pinned-header">
          <svg class="pinned-icon" width="13" height="13" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" stroke-width="1" aria-hidden="true">
            <path d="M9.5 2L13 5.5 10 8.5l.5 4.5-2-2-4 4 4-4-2-2L11 5.5z"/>
          </svg>
          <span class="pinned-band-title">{pinnedRuns.length} pinned run{pinnedRuns.length === 1 ? "" : "s"}</span>
        </header>
        <div class="pinned-list">
          {#each pinnedRuns as pr}
            <a href="/runs/{pr.id}" class="pinned-item" class:fail={!liveRunIds.has(pr.id) && pr.failed > 0}>
              <StatusDot status={liveRunIds.has(pr.id) ? 'live' : pr.aborted ? 'aborted' : pr.failed > 0 ? 'fail' : 'pass'} />
              <span class="pinned-id">#{pr.id}</span>
              <span class="pinned-suite">{pr.suite_name}</span>
              {#if liveRunIds.has(pr.id)}
                <span class="live-badge">LIVE</span>
              {:else if pr.aborted}
                <span class="aborted-badge" title="Run was aborted before it completed (Ctrl-C, stale timeout, or explicit /abort)">aborted</span>
              {:else if pr.failed > 0}
                <span class="fail-badge">{pr.failed} failed</span>
              {:else}
                <span class="pass-badge">passed</span>
              {/if}
              <span class="pinned-spacer"></span>
              <span class="pinned-time" title={absoluteDate(pr.created_at)}>{timeAgo(pr.created_at)}</span>
              <button class="pin-btn pinned" title="Unpin" onclick={(e) => togglePin(e, pr.id)}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" stroke-width="1.5">
                  <path d="M9.5 2L13 5.5 10 8.5l.5 4.5-2-2-4 4 4-4-2-2L11 5.5z"/>
                </svg>
              </button>
            </a>
          {/each}
        </div>
      </section>
    {/if}

    <div class="table-scroll">
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
          <th class="col-commit">Commit</th>
          <th class="col-ci">CI</th>
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
              <StatusDot status={liveRunIds.has(run.id) ? 'live' : run.aborted ? 'aborted' : run.failed > 0 ? 'fail' : 'pass'} />
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
              </div>
            </td>
            <td class="col-commit">
              {#if run.commit_sha}<span class="meta-chip mono commit-chip" title={run.commit_sha}>{run.commit_sha.slice(0, 7)}</span>{:else}<span class="dim">—</span>{/if}
            </td>
            <td class="col-ci">
              {#if run.ci_run_id}<span class="meta-chip mono ci" title={run.ci_run_id}>{run.ci_run_id}</span>{:else}<span class="dim">—</span>{/if}
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
            <td class="col-started" title={absoluteDate(run.started_at)}>
              {timeAgo(run.started_at)}
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
    </div>
    {#if showLoadMore}
      <div class="load-more">
        <button class="load-more-btn" onclick={loadMore} disabled={loadingMore}>
          {loadingMore
            ? "Loading..."
            : hasActiveFilters
              ? `Load more (${runs.length} match · loaded ${allRuns.length} of ${dbSummary.total})`
              : `Load more (showing ${allRuns.length} of ${dbSummary.total})`}
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

  /* ── Summary tile strip ─────────────────────────────────────────────
     Same shape as /releases and /manual-tests. Tiles inherit the
     page's database-wide totals so the strip stays stable when the
     user filters the table below. */
  .summary { display: flex; gap: 0.75rem; margin-bottom: 1rem; }
  .stat {
    flex: 1; background: var(--bg); border: 1px solid var(--border);
    border-radius: 8px; padding: 0.6rem 0.9rem;
    display: flex; flex-direction: column; gap: 0.15rem;
  }
  .stat-label { font-size: 0.68rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .stat-value { font-size: 1.35rem; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; }
  .stat.pass .stat-value { color: var(--color-pass); }
  .stat.fail {
    border-color: color-mix(in srgb, var(--color-fail) 30%, var(--border));
  }
  .stat.fail .stat-value { color: var(--color-fail); }
  .stat.risk {
    border-color: color-mix(in srgb, #d97706 35%, var(--border));
    background: color-mix(in srgb, #d97706 5%, var(--bg));
  }
  .stat.risk .stat-value { color: #d97706; }

  /* ── Toolbar (status tabs + action cluster) ─────────────────────── */
  .toolbar {
    display: flex; justify-content: space-between; align-items: center;
    gap: 0.75rem; margin-bottom: 0.6rem; flex-wrap: wrap;
  }
  .toolbar-right { display: flex; gap: 0.4rem; align-items: center; }
  .filter-summary {
    font-style: italic; color: var(--text-muted); font-size: 0.78rem;
    margin-right: 0.2rem;
  }

  /* Shared ghost-button used for Save view / Clear / Compare runs.
     Matches the affordance on /releases (.btn-ghost) so action
     buttons feel consistent across the app. */
  .btn-ghost {
    padding: 0.35rem 0.7rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--text-secondary); font-size: 0.8rem;
    cursor: pointer; white-space: nowrap; line-height: 1.2;
    display: inline-flex; align-items: center; gap: 0.35rem;
  }
  .btn-ghost:hover { background: var(--bg-hover); color: var(--text); }
  .btn-ghost.muted { color: var(--text-muted); }
  .btn-ghost.active {
    border-color: var(--link); color: var(--link);
    background: color-mix(in srgb, var(--link) 6%, var(--bg));
  }

  /* ── Secondary filter row (date tabs + search + filter popover) ── */
  .filter-row {
    display: flex; justify-content: space-between; align-items: center;
    gap: 0.75rem; margin-bottom: 0.8rem; flex-wrap: wrap;
  }
  .filter-row-right { display: flex; gap: 0.4rem; align-items: center; }

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
    font-size: 0.8rem; color: var(--text); width: 180px;
  }
  .search-box input::placeholder { color: var(--text-muted); }

  /* Filter popover — collapses three rarely-changed dropdowns
     (suite / branch / env) into one trigger so the visible toolbar
     stays uncluttered. A small dot on the trigger indicates that
     hidden filters are non-default. */
  .filter-popover-wrap { position: relative; }
  .filter-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--link); display: inline-block;
  }
  .filter-backdrop {
    position: fixed; inset: 0; z-index: 50;
  }
  .filter-popover {
    position: absolute; right: 0; top: calc(100% + 6px); z-index: 51;
    min-width: 240px;
    display: flex; flex-direction: column; gap: 0.6rem;
    padding: 0.85rem;
    background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
    box-shadow: 0 6px 20px rgba(0,0,0,0.12);
  }
  .filter-field { display: flex; flex-direction: column; gap: 0.25rem; }
  .filter-field-label {
    font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--text-muted); font-weight: 600;
  }
  .filter-field select { width: 100%; }

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
  .tab-count {
    display: inline-block;
    margin-left: 0.35rem;
    padding: 0 0.35rem;
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

  .status-text { color: var(--text-secondary); }
  .status-text.err { color: var(--color-fail); }
  .empty { padding: 3rem 0; text-align: center; color: var(--text-secondary); }
  .hint { font-size: 0.875rem; color: var(--text-muted); }

  /* ── Pinned band ──────────────────────────────────────────────────
     Same structural pattern as the at-risk band on /releases: tinted
     background, left-edge stripe, header + list of clickable rows.
     Keyed to var(--link) (blue) rather than var(--color-fail) (red)
     because pinned isn't a risk signal — it's the user's own pick. */
  .pinned-band {
    background: color-mix(in srgb, var(--link) 5%, var(--bg));
    border: 1px solid color-mix(in srgb, var(--link) 25%, var(--border));
    border-left: 4px solid var(--link);
    border-radius: 8px;
    padding: 0.65rem 0.85rem;
    margin-bottom: 1rem;
    display: flex; flex-direction: column; gap: 0.45rem;
  }
  .pinned-header { display: flex; align-items: center; gap: 0.4rem; }
  .pinned-icon { color: var(--link); }
  .pinned-band-title {
    font-weight: 600; font-size: 0.82rem; color: var(--text);
  }
  .pinned-list { display: flex; flex-direction: column; gap: 0.3rem; }
  .pinned-item {
    display: flex; align-items: center; gap: 0.6rem;
    padding: 0.4rem 0.6rem;
    background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    text-decoration: none; color: var(--text); font-size: 0.82rem;
    transition: border-color 0.1s;
  }
  .pinned-item:hover { border-color: var(--link); }
  .pinned-item.fail { border-left: 3px solid var(--color-fail); }
  .pinned-id { font-family: monospace; font-weight: 700; font-size: 0.78rem; }
  .pinned-suite {
    max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .pinned-spacer { flex: 1; }
  .pinned-time { color: var(--text-muted); font-size: 0.75rem; }

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

     Uses `table-layout: auto` (the browser sizes columns to fit
     their content). That gives a denser, more natural-looking row
     than `table-layout: fixed`, and avoids the huge gap that
     appeared between Suite and Branch when a single flexible Suite
     column had to absorb all the leftover width on a wide monitor.
     Long content is still clipped via per-cell max-widths below. */
  /* Horizontal-scroll wrapper. The runs table is wide (~15 columns,
     most nowrap); on a narrow viewport its natural width exceeds the
     container, which previously clipped the right-most column (the
     pin button) off-screen. Scroll instead of clip, and carry the
     border + rounded corners here so they wrap the scrollable area.
     Mirrors .compare-table-wrap on /welcome. */
  .table-scroll {
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .runs-table {
    width: 100%;
    border-collapse: collapse;
    background: var(--bg);
    font-size: 0.85rem;
  }
  .runs-table th, .runs-table td {
    padding: 0.55rem 0.75rem;
    text-align: left;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
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

  /* Per-column hints. The numeric columns use tabular-nums so digits
     line up; nowrap on chip-ish columns prevents wrapping. The Suite
     column has a max-width via .suite-cell + .run-suite below — the
     <td> itself uses auto sizing so the row packs tightly. */
  .col-compare { width: 36px; }
  .col-status { width: 28px; padding-right: 0; }
  .col-id { white-space: nowrap; }
  .col-state { white-space: nowrap; }
  .col-commit, .col-ci, .col-branch, .col-env, .col-reporter { white-space: nowrap; }
  .col-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .col-duration { white-space: nowrap; }
  .col-started { white-space: nowrap; font-size: 0.82rem; color: var(--text-secondary); }
  /* Pin the actions column to the right edge of the scroll container
     so the pin button stays visible and reachable no matter how wide
     the table gets or how far it's scrolled. Each sticky cell needs an
     opaque background (otherwise scrolled cells show through), and the
     hover / compare-selected row tints must be re-applied here since
     the cell's own background sits on top of the <tr> background. */
  .col-actions {
    text-align: right; padding-left: 0;
    position: sticky; right: 0; z-index: 1;
    background: var(--bg);
    box-shadow: -6px 0 6px -6px rgba(0, 0, 0, 0.35);
  }
  .runs-table th.col-actions { background: var(--bg-secondary); z-index: 2; }
  .runs-table tbody tr.run-row:hover .col-actions { background: var(--bg-hover); }
  .runs-table tbody tr.run-row.compare-selected .col-actions {
    background: color-mix(in srgb, var(--link) 8%, var(--bg));
  }


  .run-id { font-weight: 700; font-family: monospace; color: var(--text); }
  .run-suite {
    font-weight: 500; color: var(--text);
    /* Cap the suite name itself; really long names clip with an
       ellipsis, but ordinary names just sit at their natural width.
       Commit + CI now have their own columns, so the suite cell holds
       only the name + copy button. */
    display: inline-block;
    max-width: 360px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    vertical-align: middle;
  }
  .dim { color: var(--text-muted); }

  .suite-cell {
    display: flex; align-items: center; gap: 0.45rem;
    flex-wrap: nowrap; min-width: 0;
  }

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
    /* Nowrap so a chip doesn't break across two lines; the chips
       that need width caps (CI run id, commit SHA) get them
       explicitly below. The natural-width column layout means
       Branch/Env/Reporter chips just sit at their content width. */
    display: inline-block;
    white-space: nowrap;
    vertical-align: middle;
  }
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
