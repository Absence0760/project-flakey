<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { fetchRun, type RunDetail, type Spec } from "$lib/api";
  import ErrorModal from "$lib/components/ErrorModal.svelte";

  let run = $state<RunDetail | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let modalTestId = $state<number | null>(null);
  let statusFilter = $state<string>("all");
  let searchQuery = $state("");
  let collapsedSpecs = $state<Set<number>>(new Set());

  onMount(async () => {
    const id = Number($page.params.id);
    try {
      run = await fetchRun(id);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load run";
    } finally {
      loading = false;
    }
  });

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60000);
    const secs = ((ms % 60000) / 1000).toFixed(0);
    return `${mins}m ${secs}s`;
  }

  function formatTimestamp(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      month: "short", day: "numeric", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
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
    return `${days}d ago`;
  }

  function toggleSpec(specId: number) {
    const next = new Set(collapsedSpecs);
    if (next.has(specId)) next.delete(specId);
    else next.add(specId);
    collapsedSpecs = next;
  }

  function passRate(r: RunDetail): number {
    if (r.total === 0) return 0;
    return Math.round((r.passed / r.total) * 100);
  }

  let filteredSpecs = $derived.by(() => {
    if (!run) return [];
    return run.specs.map((spec) => {
      const tests = spec.tests.filter((t) => {
        if (statusFilter !== "all" && t.status !== statusFilter) return false;
        if (searchQuery && !t.title.toLowerCase().includes(searchQuery.toLowerCase())) return false;
        return true;
      });
      return { ...spec, tests };
    }).filter((spec) => spec.tests.length > 0);
  });

  let filterCounts = $derived.by(() => {
    if (!run) return { all: 0, passed: 0, failed: 0, skipped: 0 };
    const all = run.specs.flatMap((s) => s.tests);
    return {
      all: all.length,
      passed: all.filter((t) => t.status === "passed").length,
      failed: all.filter((t) => t.status === "failed").length,
      skipped: all.filter((t) => t.status === "skipped" || t.status === "pending").length,
    };
  });
</script>

<div class="page">
  {#if loading}
    <p class="status-msg">Loading...</p>
  {:else if error}
    <p class="status-msg error">{error}</p>
  {:else if run}
    <!-- Breadcrumb -->
    <nav class="breadcrumb">
      <a href="/">Runs</a>
      <span class="sep">/</span>
      <span>#{run.id}</span>
    </nav>

    <!-- Header card -->
    <header class="run-header">
      <div class="header-top">
        <div class="header-left">
          <div class="title-row">
            <h1>Run #{run.id}</h1>
            <span class="run-status-badge" class:all-pass={run.failed === 0} class:has-fail={run.failed > 0}>
              {run.failed === 0 ? "Passed" : `${run.failed} Failed`}
            </span>
          </div>
          <div class="meta-row">
            <span class="meta-item" title="Suite">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 6h12"/></svg>
              {run.suite_name}
            </span>
            <span class="meta-item" title="Branch">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="5" cy="4" r="1.5"/><circle cx="11" cy="4" r="1.5"/><circle cx="5" cy="12" r="1.5"/><path d="M5 5.5v5M11 5.5c0 3-6 3-6 5"/></svg>
              {run.branch || "—"}
            </span>
            {#if run.commit_sha}
              <span class="meta-item mono" title="Commit">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="3"/><path d="M8 1v4M8 11v4M1 8h4M11 8h4"/></svg>
                {run.commit_sha.slice(0, 7)}
              </span>
            {/if}
            <span class="meta-item" title="Started">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 2"/></svg>
              <span title={formatTimestamp(run.started_at)}>{timeAgo(run.started_at)}</span>
            </span>
            <span class="meta-item" title="Duration">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2h4M8 2v3M3.5 6l1-1M12.5 6l-1-1"/><circle cx="8" cy="9.5" r="4.5"/></svg>
              {formatDuration(run.duration_ms)}
            </span>
          </div>
        </div>

        <!-- Progress ring -->
        <div class="progress-ring" title="{passRate(run)}% pass rate">
          <svg viewBox="0 0 36 36" class="ring-svg">
            <path class="ring-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
            <path class="ring-fill" class:good={passRate(run) >= 90} class:warn={passRate(run) >= 50 && passRate(run) < 90} class:bad={passRate(run) < 50}
              stroke-dasharray="{passRate(run)}, 100"
              d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
          </svg>
          <div class="ring-label">
            <span class="ring-pct">{passRate(run)}%</span>
          </div>
        </div>
      </div>

      <!-- Stats bar -->
      <div class="stats-bar">
        <div class="stat-item">
          <span class="stat-num">{run.total}</span>
          <span class="stat-label">Total</span>
        </div>
        <div class="stat-divider"></div>
        <div class="stat-item">
          <span class="stat-num pass">{run.passed}</span>
          <span class="stat-label">Passed</span>
        </div>
        <div class="stat-divider"></div>
        <div class="stat-item">
          <span class="stat-num fail">{run.failed}</span>
          <span class="stat-label">Failed</span>
        </div>
        <div class="stat-divider"></div>
        <div class="stat-item">
          <span class="stat-num skip">{run.skipped}</span>
          <span class="stat-label">Skipped</span>
        </div>
        <div class="stat-divider"></div>
        <div class="stat-item">
          <span class="stat-num">{run.specs.length}</span>
          <span class="stat-label">Specs</span>
        </div>
      </div>
    </header>

    <!-- Filter toolbar -->
    <div class="toolbar">
      <div class="filter-tabs">
        <button class="filter-tab" class:active={statusFilter === "all"} onclick={() => statusFilter = "all"}>
          All <span class="tab-count">{filterCounts.all}</span>
        </button>
        <button class="filter-tab" class:active={statusFilter === "passed"} onclick={() => statusFilter = "passed"}>
          <span class="dot pass"></span> Passed <span class="tab-count">{filterCounts.passed}</span>
        </button>
        <button class="filter-tab" class:active={statusFilter === "failed"} onclick={() => statusFilter = "failed"}>
          <span class="dot fail"></span> Failed <span class="tab-count">{filterCounts.failed}</span>
        </button>
        <button class="filter-tab" class:active={statusFilter === "skipped"} onclick={() => statusFilter = "skipped"}>
          <span class="dot skip"></span> Skipped <span class="tab-count">{filterCounts.skipped}</span>
        </button>
      </div>
      <div class="search-box">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>
        <input type="text" placeholder="Filter tests..." bind:value={searchQuery} />
      </div>
    </div>

    <!-- Specs & Tests -->
    {#if filteredSpecs.length === 0}
      <p class="empty">No tests match the current filter.</p>
    {/if}

    {#each filteredSpecs as spec}
      <section class="spec-section">
        <button class="spec-header" onclick={() => toggleSpec(spec.id)}>
          <svg class="chevron" class:collapsed={collapsedSpecs.has(spec.id)} width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M3 4.5L6 7.5L9 4.5"/>
          </svg>
          <span class="spec-path">{spec.file_path || spec.title}</span>
          <div class="spec-badges">
            {#if spec.passed > 0}<span class="spec-badge pass">{spec.passed}</span>{/if}
            {#if spec.failed > 0}<span class="spec-badge fail">{spec.failed}</span>{/if}
            {#if spec.skipped > 0}<span class="spec-badge skip">{spec.skipped}</span>{/if}
            <span class="spec-duration">{formatDuration(spec.duration_ms)}</span>
          </div>
        </button>

        {#if !collapsedSpecs.has(spec.id)}
          <ul class="test-list">
            {#each spec.tests as test}
              <li class="test-row">
                <div class="test-main">
                  <span class="test-status-dot {test.status}"></span>
                  {#if test.status === "failed"}
                    <button class="test-name clickable" onclick={() => modalTestId = test.id}>
                      {test.title}
                    </button>
                  {:else}
                    <span class="test-name">{test.title}</span>
                  {/if}
                  <div class="test-meta">
                    {#if test.screenshot_paths && test.screenshot_paths.length > 0}
                      <span class="test-badge" title="{test.screenshot_paths.length} screenshot(s)">
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="3.5" width="13" height="9" rx="1.5"/><circle cx="8" cy="8" r="2.5"/><circle cx="12" cy="5.5" r="0.75" fill="currentColor" stroke="none"/></svg>
                        {test.screenshot_paths.length}
                      </span>
                    {/if}
                    <span class="test-dur">{formatDuration(test.duration_ms)}</span>
                  </div>
                </div>
                {#if test.error_message}
                  <button class="test-error-bar" onclick={() => modalTestId = test.id}>
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 5v3.5M8 10.5v.5"/></svg>
                    <span class="error-text">{test.error_message}</span>
                    <span class="error-action">View details</span>
                  </button>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/each}
  {/if}
</div>

<ErrorModal testId={modalTestId} onclose={() => modalTestId = null} />

<style>
  .page {
    max-width: 960px;
    margin: 0 auto;
    padding: 1.5rem 1rem 3rem;
  }

  .status-msg { color: var(--text-secondary); }
  .status-msg.error { color: var(--color-fail); }

  /* Breadcrumb */
  .breadcrumb {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
    margin-bottom: 1rem;
  }

  .breadcrumb a {
    color: var(--text-muted);
    text-decoration: none;
  }

  .breadcrumb a:hover {
    color: var(--link);
  }

  .sep {
    color: var(--text-muted);
  }

  .breadcrumb > span:last-child {
    color: var(--text-secondary);
    font-weight: 500;
  }

  /* Header */
  .run-header {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.25rem;
    margin-bottom: 1rem;
    background: var(--bg);
  }

  .header-top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1.5rem;
    margin-bottom: 1.25rem;
  }

  .header-left {
    flex: 1;
    min-width: 0;
  }

  .title-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
  }

  h1 {
    margin: 0;
    font-size: 1.35rem;
  }

  .run-status-badge {
    padding: 0.2rem 0.6rem;
    border-radius: 20px;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .run-status-badge.all-pass {
    background: color-mix(in srgb, var(--color-pass) 15%, transparent);
    color: var(--color-pass);
  }

  .run-status-badge.has-fail {
    background: color-mix(in srgb, var(--color-fail) 15%, transparent);
    color: var(--color-fail);
  }

  .meta-row {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
  }

  .meta-item {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.8rem;
    color: var(--text-secondary);
  }

  .meta-item.mono {
    font-family: monospace;
  }

  .meta-item svg {
    flex-shrink: 0;
    opacity: 0.6;
  }

  /* Progress ring */
  .progress-ring {
    position: relative;
    width: 64px;
    height: 64px;
    flex-shrink: 0;
  }

  .ring-svg {
    width: 100%;
    height: 100%;
    transform: rotate(-90deg);
  }

  .ring-bg {
    fill: none;
    stroke: var(--border);
    stroke-width: 3;
  }

  .ring-fill {
    fill: none;
    stroke-width: 3;
    stroke-linecap: round;
    transition: stroke-dasharray 0.6s ease;
  }

  .ring-fill.good { stroke: var(--color-pass); }
  .ring-fill.warn { stroke: var(--color-skip); }
  .ring-fill.bad { stroke: var(--color-fail); }

  .ring-label {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }

  .ring-pct {
    font-size: 0.85rem;
    font-weight: 700;
    color: var(--text);
  }

  /* Stats bar */
  .stats-bar {
    display: flex;
    align-items: center;
    gap: 0;
    padding-top: 1rem;
    border-top: 1px solid var(--border-light);
  }

  .stat-item {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.15rem;
  }

  .stat-num {
    font-size: 1.1rem;
    font-weight: 700;
    color: var(--text);
  }

  .stat-num.pass { color: var(--color-pass); }
  .stat-num.fail { color: var(--color-fail); }
  .stat-num.skip { color: var(--color-skip); }

  .stat-label {
    font-size: 0.7rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .stat-divider {
    width: 1px;
    height: 28px;
    background: var(--border-light);
  }

  /* Toolbar */
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
    flex-wrap: wrap;
  }

  .filter-tabs {
    display: flex;
    gap: 0.2rem;
    background: var(--bg-secondary);
    border-radius: 6px;
    padding: 0.2rem;
  }

  .filter-tab {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.35rem 0.65rem;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 0.78rem;
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
  }

  .filter-tab:hover {
    color: var(--text);
  }

  .filter-tab.active {
    background: var(--bg);
    color: var(--text);
    font-weight: 600;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
  }

  .tab-count {
    font-size: 0.7rem;
    color: var(--text-muted);
    font-weight: 400;
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
  }

  .dot.pass { background: var(--color-pass); }
  .dot.fail { background: var(--color-fail); }
  .dot.skip { background: var(--color-skip); }

  .search-box {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text-muted);
    transition: border-color 0.15s;
  }

  .search-box:focus-within {
    border-color: var(--link);
  }

  .search-box input {
    border: none;
    background: transparent;
    outline: none;
    font-size: 0.8rem;
    color: var(--text);
    width: 160px;
  }

  .search-box input::placeholder {
    color: var(--text-muted);
  }

  .empty {
    text-align: center;
    color: var(--text-muted);
    font-size: 0.875rem;
    padding: 2rem 0;
  }

  /* Spec sections */
  .spec-section {
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 0.5rem;
    overflow: hidden;
  }

  .spec-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.65rem 0.85rem;
    border: none;
    background: var(--bg-secondary);
    color: var(--text);
    font-size: 0.82rem;
    cursor: pointer;
    text-align: left;
    transition: background 0.1s;
  }

  .spec-header:hover {
    background: var(--bg-hover);
  }

  .chevron {
    flex-shrink: 0;
    transition: transform 0.15s;
    color: var(--text-muted);
  }

  .chevron.collapsed {
    transform: rotate(-90deg);
  }

  .spec-path {
    flex: 1;
    font-family: monospace;
    font-size: 0.78rem;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .spec-badges {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-shrink: 0;
  }

  .spec-badge {
    padding: 0.1rem 0.4rem;
    border-radius: 10px;
    font-size: 0.7rem;
    font-weight: 600;
    min-width: 1.2rem;
    text-align: center;
  }

  .spec-badge.pass {
    background: color-mix(in srgb, var(--color-pass) 15%, transparent);
    color: var(--color-pass);
  }

  .spec-badge.fail {
    background: color-mix(in srgb, var(--color-fail) 15%, transparent);
    color: var(--color-fail);
  }

  .spec-badge.skip {
    background: color-mix(in srgb, var(--color-skip) 15%, transparent);
    color: var(--color-skip);
  }

  .spec-duration {
    font-family: monospace;
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  /* Test list */
  .test-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .test-row {
    border-top: 1px solid var(--border-light);
  }

  .test-main {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 0.85rem 0.5rem 1.6rem;
  }

  .test-status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .test-status-dot.passed { background: var(--color-pass); }
  .test-status-dot.failed { background: var(--color-fail); }
  .test-status-dot.skipped,
  .test-status-dot.pending { background: var(--color-skip); }

  .test-name {
    flex: 1;
    font-size: 0.83rem;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .test-name.clickable {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-size: 0.83rem;
    color: var(--link);
    cursor: pointer;
    text-align: left;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .test-name.clickable:hover {
    text-decoration: underline;
  }

  .test-meta {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-shrink: 0;
  }

  .test-badge {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .test-badge svg {
    opacity: 0.7;
  }

  .test-dur {
    font-family: monospace;
    font-size: 0.75rem;
    color: var(--text-muted);
    min-width: 3.5rem;
    text-align: right;
  }

  /* Error bar */
  .test-error-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 0.85rem 0.5rem 2.8rem;
    border: none;
    background: var(--error-bg);
    border-top: 1px solid var(--error-border);
    cursor: pointer;
    text-align: left;
    transition: background 0.15s;
  }

  .test-error-bar:hover {
    background: color-mix(in srgb, var(--color-fail) 10%, var(--error-bg));
  }

  .test-error-bar svg {
    flex-shrink: 0;
    color: var(--error-text);
    opacity: 0.7;
  }

  .error-text {
    flex: 1;
    font-size: 0.78rem;
    font-family: monospace;
    color: var(--error-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .error-action {
    flex-shrink: 0;
    font-size: 0.72rem;
    color: var(--link);
    opacity: 0;
    transition: opacity 0.15s;
  }

  .test-error-bar:hover .error-action {
    opacity: 1;
  }
</style>
