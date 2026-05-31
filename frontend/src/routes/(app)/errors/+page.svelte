<script lang="ts">
  import { onMount } from "svelte";
  import { timeAgo } from "$lib/utils/format";
  import { page } from "$app/stores";
  import { replaceState } from "$app/navigation";
  import { fetchErrors, fetchRuns, updateErrorStatus, fetchAffectedTests, checkAIEnabled, analyzeError, findSimilarErrors, type ErrorGroup, type AffectedTest, type Run, type AIAnalysis, type SimilarError } from "$lib/api";
  import ErrorModal from "$lib/components/overlays/ErrorModal.svelte";
  import NotesPanel from "$lib/components/panels/NotesPanel.svelte";

  let errors = $state<ErrorGroup[]>([]);
  let allRuns = $state<Run[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let modalTestId = $state<number | null>(null);
  let aiEnabled = $state(false);
  let aiResults = $state<Record<string, AIAnalysis>>({});
  let aiLoading = $state<Record<string, boolean>>({});
  let similarResults = $state<Record<string, SimilarError[]>>({});
  let similarLoading = $state<Record<string, boolean>>({});

  let selectedSuite = $state("all");
  let selectedStatus = $state("all");
  let searchQuery = $state("");

  let suites = $derived([...new Set(allRuns.map((r) => r.suite_name))].sort());

  function syncUrl() {
    const url = new URL(window.location.href);
    const set = (k: string, v: string, def: string) => { if (v !== def) url.searchParams.set(k, v); else url.searchParams.delete(k); };
    set("suite", selectedSuite, "all");
    set("status", selectedStatus, "all");
    set("q", searchQuery, "");
    replaceState(url, {});
  }
  function readUrl() {
    const p = $page.url.searchParams;
    selectedSuite = p.get("suite") ?? "all";
    selectedStatus = p.get("status") ?? "all";
    searchQuery = p.get("q") ?? "";
  }
  let mounted = $state(false);
  $effect(() => { selectedSuite; selectedStatus; searchQuery; if (mounted) syncUrl(); });

  // Selected error — drives the right-hand detail pane (master /
  // detail split). Auto-selects the first error on load so the right
  // pane is never empty when the list isn't.
  let selectedFingerprint = $state<string | null>(null);
  let affectedTests = $state<AffectedTest[]>([]);
  let testsLoading = $state(false);
  const selectedError = $derived(
    errors.find((e) => e.fingerprint === selectedFingerprint) ?? null
  );

  // Client-side search filter. Suite + status are sent server-side
  // (see applyFilters) so the local filter only narrows the rendered
  // set by free-text match on the error message.
  const filteredErrors = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return errors;
    return errors.filter((e) => e.error_message.toLowerCase().includes(q));
  });

  // Page-level summary tiles. "New this week" counts fingerprints
  // first seen in the last 7 days; "Recurring" counts those with
  // more than 5 occurrences (a reasonable signal-vs-noise threshold).
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const stats = $derived.by(() => {
    const now = Date.now();
    let open = 0, newThisWeek = 0, recurring = 0;
    for (const e of errors) {
      if (e.status === "open") open++;
      if (now - new Date(e.first_seen).getTime() < WEEK_MS) newThisWeek++;
      if (e.occurrence_count > 5) recurring++;
    }
    return { total: errors.length, open, newThisWeek, recurring };
  });

  // Client-side pagination (page size 50). Reset when filters
  // change so a stale slice doesn't outlive the underlying set.
  const PAGE_SIZE = 50;
  let visibleCount = $state(PAGE_SIZE);
  const visibleErrors = $derived(filteredErrors.slice(0, visibleCount));
  const hasMoreErrors = $derived(visibleErrors.length < filteredErrors.length);

  $effect(() => {
    selectedSuite; selectedStatus; searchQuery; // tracked deps
    visibleCount = PAGE_SIZE;
  });

  function loadMoreErrors() {
    visibleCount = Math.min(visibleCount + PAGE_SIZE, filteredErrors.length);
  }

  const statuses = [
    { value: "open", label: "Open", color: "var(--color-fail)" },
    { value: "investigating", label: "Investigating", color: "var(--link)" },
    { value: "known", label: "Known Issue", color: "#dfb317" },
    { value: "fixed", label: "Fixed", color: "var(--color-pass)" },
    { value: "ignored", label: "Ignored", color: "var(--text-muted)" },
  ];

  function statusInfo(s: string) {
    return statuses.find((st) => st.value === s) ?? statuses[0];
  }

  onMount(async () => {
    readUrl();
    try {
      const [errs, runs, ai] = await Promise.all([fetchErrors(), fetchRuns(), checkAIEnabled()]);
      errors = errs;
      allRuns = runs;
      aiEnabled = ai;
    } catch (e) {
      loadError = e instanceof Error ? e.message : "Failed to load errors";
    } finally {
      loading = false;
      mounted = true;
    }
  });

  // Preserve pagination depth + which fingerprint was selected in the
  // detail pane + scroll position across back/forward navigation.
  export const snapshot = {
    capture: () => ({
      visibleCount,
      selectedFingerprint,
      scrollY: typeof window !== "undefined" ? window.scrollY : 0,
    }),
    restore: (s: { visibleCount: number; selectedFingerprint: string | null; scrollY: number }) => {
      visibleCount = s.visibleCount;
      selectedFingerprint = s.selectedFingerprint;
      queueMicrotask(() => window.scrollTo({ top: s.scrollY, behavior: "instant" as ScrollBehavior }));
    },
  };

  async function handleAnalyze(fingerprint: string) {
    aiLoading = { ...aiLoading, [fingerprint]: true };
    try {
      const result = await analyzeError(fingerprint);
      aiResults = { ...aiResults, [fingerprint]: result };
    } catch { /* ignore */ }
    aiLoading = { ...aiLoading, [fingerprint]: false };
  }

  async function handleFindSimilar(fingerprint: string) {
    similarLoading = { ...similarLoading, [fingerprint]: true };
    try {
      const result = await findSimilarErrors(fingerprint);
      similarResults = { ...similarResults, [fingerprint]: result };
    } catch { /* ignore */ }
    similarLoading = { ...similarLoading, [fingerprint]: false };
  }

  const classificationLabels: Record<string, string> = {
    product_bug: "Product Bug",
    automation_bug: "Automation Bug",
    environment_issue: "Environment Issue",
    flaky_test: "Flaky Test",
    data_issue: "Data Issue",
    timeout: "Timeout",
    unknown: "Unknown",
  };

  async function applyFilters() {
    loading = true;
    try {
      errors = await fetchErrors({
        suite: selectedSuite !== "all" ? selectedSuite : undefined,
        status: selectedStatus !== "all" ? selectedStatus : undefined,
      });
    } catch (e) {
      loadError = e instanceof Error ? e.message : "Failed to load errors";
    } finally {
      loading = false;
    }
  }

  function onSuiteChange() { applyFilters(); }
  function onStatusChange() { applyFilters(); }

  async function selectError(err: ErrorGroup) {
    if (selectedFingerprint === err.fingerprint) return;
    selectedFingerprint = err.fingerprint;
    affectedTests = [];
    testsLoading = true;
    try {
      affectedTests = await fetchAffectedTests(err.fingerprint);
    } catch { /* ignore */ }
    testsLoading = false;
  }

  // After errors load (or the filtered list shifts), pick the first
  // one so the right pane has content immediately. Track the filtered
  // set, not the raw one — if the user searches and their current
  // selection isn't in the result, fall through to the new top item.
  $effect(() => {
    if (filteredErrors.length === 0) {
      selectedFingerprint = null;
      return;
    }
    if (selectedFingerprint === null || !filteredErrors.some((e) => e.fingerprint === selectedFingerprint)) {
      selectError(filteredErrors[0]);
    }
  });

  async function changeStatus(err: ErrorGroup, status: string) {
    try {
      await updateErrorStatus(err.fingerprint, status);
      err.status = status;
      errors = [...errors];
    } catch { /* ignore */ }
  }


  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
</script>

<div class="page">
  <!-- Description sits on its own line; filters get their own
       full-width row below so the status tabs aren't pushed far to
       the right on a wide monitor. -->
  <p class="description">Recurring test failures tracked with status and notes.</p>

  {#if !loading && !loadError && errors.length > 0}
    <section class="summary">
      <div class="stat"><span class="stat-label">Total</span><span class="stat-value">{stats.total}</span></div>
      <div class="stat" class:risk={stats.open > 0}><span class="stat-label">Open</span><span class="stat-value">{stats.open}</span></div>
      <div class="stat" class:medium={stats.newThisWeek > 0}><span class="stat-label">New this week</span><span class="stat-value">{stats.newThisWeek}</span></div>
      <div class="stat" class:medium={stats.recurring > 0}><span class="stat-label">Recurring (&gt;5x)</span><span class="stat-value">{stats.recurring}</span></div>
    </section>
  {/if}

  <div class="filters">
    <select bind:value={selectedSuite} onchange={onSuiteChange}>
      <option value="all">All suites</option>
      {#each suites as suite}
        <option value={suite}>{suite}</option>
      {/each}
    </select>
    <div class="filter-tabs">
      <button class="filter-tab" class:active={selectedStatus === "all"} onclick={() => { selectedStatus = "all"; onStatusChange(); }}>
        All
      </button>
      {#each statuses as s}
        <button class="filter-tab" class:active={selectedStatus === s.value} onclick={() => { selectedStatus = s.value; onStatusChange(); }}>
          <span class="dot" style="background: {s.color}"></span> {s.label}
        </button>
      {/each}
    </div>
    <div class="filter-spacer"></div>
    <div class="search-box">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>
      <input type="text" placeholder="Search error messages..." bind:value={searchQuery} />
    </div>
  </div>

  {#if loading}
    <p class="status-text">Loading...</p>
  {:else if loadError}
    <p class="status-text error">{loadError}</p>
  {:else if filteredErrors.length === 0}
    <div class="empty">
      <p>No errors found.</p>
      <p class="hint">
        {#if searchQuery.trim()}
          No messages match "{searchQuery}". Try a different search.
        {:else if selectedSuite !== "all" || selectedStatus !== "all"}
          Try changing the filters.
        {:else}
          Errors appear here when test runs have failures.
        {/if}
      </p>
    </div>
  {:else}
    <!-- Master / detail split: compact list on the left, full inspector
         on the right. The list stays scrollable; the detail pane
         renders the selected fingerprint's full context (status,
         affected tests, AI, notes) without forcing the user to scroll
         back to the list each time they want to triage another error. -->
    <div class="split">
      <aside class="error-list">
        {#each visibleErrors as err}
          <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role:
               row-as-button pattern, same as runs list. -->
          <button
            class="error-item"
            class:active={selectedFingerprint === err.fingerprint}
            onclick={() => selectError(err)}
          >
            <span class="status-dot" style="background: {statusInfo(err.status).color}"></span>
            <span class="error-count">{err.occurrence_count}x</span>
            <span class="error-main">
              <span class="error-msg" title={err.error_message}>{err.error_message}</span>
              <span class="error-meta">
                <span
                  class="status-chip status-{err.status}"
                  style="--chip-color: {statusInfo(err.status).color}"
                >{statusInfo(err.status).label}</span>
                <span class="error-suite">{err.suite_name}</span>
                <span class="error-tests">{err.affected_tests}t</span>
                {#if err.note_count > 0}<span class="notes-count" title="{err.note_count} notes">{err.note_count}n</span>{/if}
                <span class="error-when" title="Last seen {formatDate(err.last_seen)}">{timeAgo(err.last_seen)}</span>
              </span>
            </span>
          </button>
        {/each}
        {#if hasMoreErrors}
          <div class="load-more">
            <button class="load-more-btn" onclick={loadMoreErrors}>
              Load more ({errors.length - visibleErrors.length} more)
            </button>
          </div>
        {/if}
      </aside>

      <section class="detail-pane">
        {#if !selectedError}
          <p class="muted">Pick an error from the list to inspect it.</p>
        {:else}
          {@const err = selectedError}
          <header class="detail-header">
            <span class="status-badge" style="background: {statusInfo(err.status).color}">{statusInfo(err.status).label}</span>
            <span class="detail-count">{err.occurrence_count}x</span>
            <button class="btn-view" onclick={() => { if (err.latest_test_id) modalTestId = err.latest_test_id; }}>View latest failure</button>
          </header>
          <pre class="detail-error">{err.error_message}</pre>

          <div class="detail-row">
            <div class="detail-section">
              <h4>Status</h4>
              <div class="status-controls">
                {#each statuses as s}
                  <button
                    class="status-btn"
                    class:active={err.status === s.value}
                    style="--status-color: {s.color}"
                    onclick={() => changeStatus(err, s.value)}
                  >{s.label}</button>
                {/each}
              </div>
            </div>
            <div class="detail-section">
              <h4>Details</h4>
              <div class="detail-facts">
                <span>Occurrences: <strong>{err.occurrence_count}</strong></span>
                <span>Affected runs: <strong>{err.affected_runs}</strong></span>
                <span>First seen: <strong>{formatDate(err.first_seen)}</strong></span>
                <span>Last seen: <strong>{formatDate(err.last_seen)}</strong></span>
                <span>Suite: <strong>{err.suite_name}</strong></span>
                <span>Files: <strong>{err.file_paths.join(", ")}</strong></span>
              </div>
            </div>
          </div>

          <!-- AI + Affected Tests share a row on wide viewports so the
               inspector's horizontal real estate isn't wasted. Falls
               back to a single column under 1400px. -->
          <div class="insight-grid">
          {#if aiEnabled}
            <div class="ai-section">
              {#if aiResults[err.fingerprint]}
                {@const ai = aiResults[err.fingerprint]}
                <div class="ai-result">
                  <div class="ai-header">
                    <span class="ai-badge">{classificationLabels[ai.classification] ?? ai.classification}</span>
                    <span class="ai-confidence">{Math.round(ai.confidence * 100)}% confidence</span>
                  </div>
                  <p class="ai-summary">{ai.summary}</p>
                  <p class="ai-fix"><strong>Suggestion:</strong> {ai.suggested_fix}</p>
                </div>
              {:else}
                <button class="btn-analyze" onclick={() => handleAnalyze(err.fingerprint)} disabled={aiLoading[err.fingerprint]}>
                  {aiLoading[err.fingerprint] ? "Analyzing..." : "Analyze with AI"}
                </button>
              {/if}

              {#if similarResults[err.fingerprint]}
                {@const similar = similarResults[err.fingerprint]}
                {#if similar.length > 0}
                  <div class="similar-section">
                    <h4>Similar Failures ({similar.length})</h4>
                    {#each similar as s}
                      <div class="similar-item">
                        <span class="similar-msg">{s.error_message.slice(0, 120)}{s.error_message.length > 120 ? "..." : ""}</span>
                        <span class="similar-meta">
                          {s.suite_name} · {s.occurrence_count}x · {Math.round(s.similarity * 100)}% similar
                          <span class="status-badge mini" style="background: {statusInfo(s.status).color}">{statusInfo(s.status).label}</span>
                        </span>
                      </div>
                    {/each}
                  </div>
                {/if}
              {:else}
                <button class="btn-similar" onclick={() => handleFindSimilar(err.fingerprint)} disabled={similarLoading[err.fingerprint]}>
                  {similarLoading[err.fingerprint] ? "Searching..." : "Find similar failures"}
                </button>
              {/if}
            </div>
          {/if}

            <div class="affected-tests-section">
            <h4>Affected Tests ({affectedTests.length})</h4>
            {#if testsLoading}
              <p class="muted">Loading...</p>
            {:else if affectedTests.length === 0}
              <p class="muted">No tests found.</p>
            {:else}
              <div class="affected-tests-list">
                {#each affectedTests as at}
                  <button class="affected-test" onclick={() => { modalTestId = at.latest_test_id; }}>
                    <span class="at-title">{at.full_title}</span>
                    <span class="at-meta">
                      <span class="at-file">{at.file_path}</span>
                      <span class="at-count">{at.occurrence_count}x</span>
                      <span class="at-time">{timeAgo(at.last_seen)}</span>
                    </span>
                  </button>
                {/each}
              </div>
            {/if}
            </div>
          </div>

          <NotesPanel targetType="error" targetKey={err.fingerprint} />
        {/if}
      </section>
    </div>
  {/if}
</div>

<ErrorModal testId={modalTestId} onclose={() => modalTestId = null} />

<style>
  .page { max-width: 1920px; margin: 0 auto; padding: 1.5rem 2rem; }

  .description { margin: 0 0 0.75rem; color: var(--text-secondary); font-size: 0.875rem; }

  /* Summary tiles — same shape as /runs and /releases. */
  .summary { display: flex; gap: 0.75rem; margin-bottom: 1rem; flex-wrap: wrap; }
  .stat {
    padding: 0.5rem 0.85rem;
    border: 1px solid var(--border); border-radius: 8px;
    background: var(--bg);
    display: flex; flex-direction: column; gap: 0.1rem;
    min-width: 110px;
  }
  .stat-label { font-size: 0.68rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .stat-value { font-size: 1.35rem; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; line-height: 1.15; }
  .stat.risk {
    border-color: color-mix(in srgb, var(--color-fail) 35%, var(--border));
    background: color-mix(in srgb, var(--color-fail) 5%, var(--bg));
  }
  .stat.risk .stat-value { color: var(--color-fail); }
  .stat.medium {
    border-color: color-mix(in srgb, #dfb317 35%, var(--border));
    background: color-mix(in srgb, #dfb317 5%, var(--bg));
  }
  .stat.medium .stat-value { color: #dfb317; }

  .filters {
    display: flex; gap: 0.5rem; align-items: center;
    margin-bottom: 1rem; flex-wrap: wrap;
  }
  .filter-spacer { flex: 1; min-width: 0; }
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
    font-size: 0.8rem; color: var(--text); width: 220px;
  }
  .search-box input::placeholder { color: var(--text-muted); }

  /* .filter-tabs / .filter-tab base styles live in src/app.css.
     The `.dot` colour-swatch extension is /errors-specific and
     stays here. */

  .filter-tabs .dot {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  }

  .status-text { color: var(--text-secondary); }
  .status-text.error { color: var(--color-fail); }

  .empty { padding: 3rem 0; text-align: center; color: var(--text-secondary); }
  .hint { font-size: 0.875rem; color: var(--text-muted); }

  /* Master / detail split — list on the left, inspector on the right.
     Sticky right pane so it keeps the selected error visible while
     the user scrolls a long list. */
  .split {
    display: grid;
    grid-template-columns: minmax(380px, 36%) 1fr;
    gap: 1rem;
    align-items: start;
  }
  .error-list {
    display: flex; flex-direction: column;
    background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
    overflow: hidden;
  }
  .error-item {
    display: grid;
    grid-template-columns: 10px 36px 1fr;
    gap: 0.5rem; align-items: start;
    padding: 0.5rem 0.75rem;
    background: var(--bg); border: none; border-bottom: 1px solid var(--border);
    text-align: left; font: inherit; color: var(--text); cursor: pointer;
    width: 100%;
    transition: background 0.1s;
  }
  .error-item:last-of-type { border-bottom: none; }
  .error-item:hover { background: var(--bg-hover); }
  .error-item.active {
    background: color-mix(in srgb, var(--link) 12%, var(--bg));
    box-shadow: inset 3px 0 0 var(--link);
  }
  .error-item .status-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 0.35rem; }
  .error-item .error-count {
    font-family: monospace; font-weight: 700; font-size: 0.8rem;
    color: var(--color-fail); text-align: right; padding-top: 0.1rem;
  }
  .error-main {
    display: flex; flex-direction: column; gap: 0.15rem;
    min-width: 0;
  }
  .error-item .error-msg {
    font-size: 0.82rem; color: var(--text);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    min-width: 0;
  }
  .error-meta {
    display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap;
    font-size: 0.68rem; color: var(--text-muted);
  }
  /* Status chip — text label, not just a dot, so triagers can scan
     "open" vs "investigating" rows without selecting each one. */
  .status-chip {
    padding: 0.05rem 0.4rem; border-radius: 8px;
    font-size: 0.62rem; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--chip-color);
    background: color-mix(in srgb, var(--chip-color) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--chip-color) 30%, transparent);
    white-space: nowrap;
  }
  .error-suite {
    padding: 0.05rem 0.4rem; border-radius: 8px;
    background: var(--bg-secondary);
  }
  .error-tests { font-variant-numeric: tabular-nums; }
  .notes-count { color: var(--link); }
  .error-when { margin-left: auto; font-variant-numeric: tabular-nums; }

  /* Right-pane inspector */
  .detail-pane {
    background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
    padding: 1rem 1.25rem;
    position: sticky;
    top: 1rem;
    max-height: calc(100vh - 8rem);
    overflow-y: auto;
  }
  .detail-header {
    display: flex; gap: 0.6rem; align-items: center;
    padding-bottom: 0.5rem; border-bottom: 1px solid var(--border-light);
    margin-bottom: 0.75rem;
  }
  .detail-count { font-family: monospace; font-weight: 700; color: var(--color-fail); }
  .detail-error {
    background: color-mix(in srgb, var(--color-fail) 5%, var(--bg-secondary));
    border: 1px solid color-mix(in srgb, var(--color-fail) 20%, var(--border));
    border-radius: 6px;
    padding: 0.6rem 0.8rem;
    font-family: monospace; font-size: 0.8rem;
    color: var(--text);
    white-space: pre-wrap; word-break: break-word;
    margin: 0 0 0.75rem;
    max-height: 12rem; overflow-y: auto;
  }
  .status-badge {
    padding: 0.15rem 0.45rem; border-radius: 8px; font-size: 0.65rem; font-weight: 600;
    color: #fff; flex-shrink: 0; text-transform: uppercase; letter-spacing: 0.02em;
  }

  /* Stack columns on narrow viewports — sticky becomes irrelevant
     when the list pushes the detail pane below it on mobile. */
  @media (max-width: 1024px) {
    .split { grid-template-columns: 1fr; }
    .detail-pane { position: static; max-height: none; }
  }
  .detail-row {
    display: flex; gap: 1.5rem; flex-wrap: wrap; align-items: flex-start; margin-bottom: 1rem;
  }
  .detail-section h4 { margin: 0 0 0.4rem; font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }

  .status-controls { display: flex; gap: 0.25rem; flex-wrap: wrap; }
  .status-btn {
    padding: 0.25rem 0.5rem; border: 1px solid var(--border); border-radius: 4px;
    background: var(--bg); color: var(--text-secondary); font-size: 0.72rem; cursor: pointer;
  }
  .status-btn:hover { border-color: var(--status-color); color: var(--status-color); }
  .status-btn.active { background: var(--status-color); color: #fff; border-color: var(--status-color); }

  .detail-facts { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.78rem; color: var(--text-secondary); }
  .detail-facts strong { color: var(--text); }

  .btn-view {
    padding: 0.4rem 0.75rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--link); font-size: 0.78rem; font-weight: 500;
    cursor: pointer; align-self: flex-start; margin-top: 1.1rem;
  }
  .btn-view:hover { background: var(--bg-hover); }

  /* Affected tests */
  .affected-tests-section { border-top: 1px solid var(--border); padding-top: 0.75rem; margin-bottom: 0.75rem; }
  .affected-tests-section h4 { margin: 0 0 0.5rem; font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .affected-tests-list { display: flex; flex-direction: column; gap: 0.25rem; }
  .affected-test {
    display: flex; flex-direction: column; gap: 0.1rem;
    padding: 0.4rem 0.6rem; background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    cursor: pointer; text-align: left; font: inherit; color: var(--text); width: 100%;
  }
  .affected-test:hover { background: var(--bg-hover); border-color: var(--link); }
  .at-title { font-size: 0.82rem; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .at-meta { display: flex; gap: 0.75rem; font-size: 0.72rem; color: var(--text-muted); }
  .at-file { font-family: monospace; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .at-count { font-weight: 600; color: var(--color-fail); }

  .muted { color: var(--text-muted); font-size: 0.8rem; margin: 0 0 0.5rem; }

  /* AI + Affected Tests side-by-side on wide viewports. Stacks on
     narrow ones — kept independent of the .split breakpoint because
     the inspector pane itself is only ~64% of viewport width and
     needs more horizontal slack before it makes sense to split. */
  .insight-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1rem;
    align-items: start;
  }
  @media (min-width: 1500px) {
    .insight-grid { grid-template-columns: 1fr 1fr; }
    /* When side-by-side, drop the top border on the affected-tests
       section — the columns are visually separated by the gap. */
    .insight-grid .affected-tests-section { border-top: none; padding-top: 0; }
  }

  /* AI Analysis */
  .ai-section { padding: 0.75rem 0; border-top: 1px solid var(--border-light); display: flex; flex-direction: column; gap: 0.5rem; }

  .btn-analyze, .btn-similar {
    padding: 0.35rem 0.75rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--text-secondary); font-size: 0.78rem;
    cursor: pointer; align-self: flex-start;
  }
  .btn-analyze:hover, .btn-similar:hover { background: var(--bg-hover); color: var(--text); }
  .btn-analyze:disabled, .btn-similar:disabled { opacity: 0.5; cursor: wait; }

  .ai-result {
    padding: 0.65rem; background: color-mix(in srgb, var(--link) 5%, transparent);
    border: 1px solid color-mix(in srgb, var(--link) 20%, transparent);
    border-radius: 8px;
  }
  .ai-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.4rem; }
  .ai-badge {
    padding: 0.15rem 0.5rem; border-radius: 10px; font-size: 0.7rem; font-weight: 600;
    background: var(--link); color: #fff;
  }
  .ai-confidence { font-size: 0.7rem; color: var(--text-muted); }
  .ai-summary { font-size: 0.82rem; color: var(--text); margin: 0 0 0.25rem; }
  .ai-fix { font-size: 0.78rem; color: var(--text-secondary); margin: 0; }

  .similar-section { margin-top: 0.25rem; }
  .similar-section h4 { font-size: 0.82rem; margin: 0 0 0.4rem; }
  .similar-item {
    padding: 0.4rem 0; border-top: 1px solid var(--border-light);
    display: flex; flex-direction: column; gap: 0.15rem;
  }
  .similar-msg { font-size: 0.78rem; color: var(--text); }
  .similar-meta { font-size: 0.7rem; color: var(--text-muted); display: flex; align-items: center; gap: 0.4rem; }
  .status-badge.mini { font-size: 0.6rem; padding: 0.05rem 0.3rem; }
</style>
