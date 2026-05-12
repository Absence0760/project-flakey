<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { replaceState } from "$app/navigation";
  import { fetchFlakyTests, fetchRuns, checkAIEnabled, analyzeFlakyTest, fetchQuarantinedTests, quarantineTest, unquarantineTest, type FlakyTest, type Run, type FlakyAnalysis } from "$lib/api";
  import NotesPanel from "$lib/components/NotesPanel.svelte";

  let tests = $state<FlakyTest[]>([]);
  let allRuns = $state<Run[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let aiEnabled = $state(false);
  let aiResults = $state<Record<string, FlakyAnalysis>>({});
  let aiLoading = $state<Record<string, boolean>>({});
  let quarantinedSet = $state<Set<string>>(new Set());

  function qKey(t: FlakyTest) { return `${t.full_title}|${t.suite_name}`; }

  let selectedSuite = $state("all");
  let runWindow = $state(30);

  let suites = $derived([...new Set(allRuns.map((r) => r.suite_name))].sort());

  let sortBy = $state<"flaky_rate" | "flip_count" | "fail_count" | "last_seen">("flaky_rate");

  function syncUrl() {
    const url = new URL(window.location.href);
    const set = (k: string, v: string, def: string) => { if (v !== def) url.searchParams.set(k, v); else url.searchParams.delete(k); };
    set("suite", selectedSuite, "all");
    set("sort", sortBy, "flaky_rate");
    set("window", String(runWindow), "30");
    replaceState(url, {});
  }
  function readUrl() {
    const p = $page.url.searchParams;
    selectedSuite = p.get("suite") ?? "all";
    sortBy = (p.get("sort") as typeof sortBy) ?? "flaky_rate";
    const w = Number(p.get("window"));
    if (w > 0) runWindow = w;
  }
  let mounted = $state(false);
  $effect(() => { selectedSuite; sortBy; runWindow; if (mounted) syncUrl(); });
  let expandedIndex = $state<number | null>(null);
  let sorted = $derived(
    [...tests].sort((a, b) => {
      if (sortBy === "last_seen") return new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime();
      return (b as any)[sortBy] - (a as any)[sortBy];
    })
  );

  // Client-side pagination — render the first N rows so a very long
  // flaky list doesn't blow the page on first paint. Reset when the
  // sort/window changes (otherwise the slice is stale relative to
  // the new ordering).
  const PAGE_SIZE = 50;
  let visibleCount = $state(PAGE_SIZE);
  const visibleSorted = $derived(sorted.slice(0, visibleCount));
  const hasMoreFlaky = $derived(visibleSorted.length < sorted.length);

  $effect(() => {
    selectedSuite; sortBy; runWindow; // tracked deps
    visibleCount = PAGE_SIZE;
  });

  function loadMoreFlaky() {
    visibleCount = Math.min(visibleCount + PAGE_SIZE, sorted.length);
  }

  onMount(async () => {
    readUrl();
    try {
      const [flakyData, runs, ai, qt] = await Promise.all([
        fetchFlakyTests({ runs: runWindow }),
        fetchRuns(),
        checkAIEnabled(),
        fetchQuarantinedTests(),
      ]);
      tests = flakyData;
      allRuns = runs;
      aiEnabled = ai;
      quarantinedSet = new Set(qt.map(q => `${q.full_title}|${q.suite_name}`));
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load data";
    } finally {
      loading = false;
      mounted = true;
    }
  });

  async function reload() {
    loading = true;
    error = null;
    try {
      tests = await fetchFlakyTests({
        suite: selectedSuite !== "all" ? selectedSuite : undefined,
        runs: runWindow,
      });
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load data";
    } finally {
      loading = false;
    }
  }

  function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    return `${Math.floor(days / 30)}mo ago`;
  }

  function rateColor(rate: number): string {
    if (rate >= 40) return "var(--color-fail)";
    if (rate >= 20) return "#dfb317";
    return "var(--color-pass)";
  }

  async function handleAnalyzeFlaky(test: FlakyTest) {
    const key = qKey(test);
    aiLoading = { ...aiLoading, [key]: true };
    try {
      const result = await analyzeFlakyTest({
        fullTitle: test.full_title,
        filePath: test.file_path,
        suiteName: test.suite_name,
        flakyRate: test.flaky_rate,
        flipCount: test.flip_count,
        totalRuns: test.total_runs,
        timeline: test.timeline,
      });
      aiResults = { ...aiResults, [key]: result };
    } catch { /* ignore */ }
    aiLoading = { ...aiLoading, [key]: false };
  }

  async function toggleQuarantine(test: FlakyTest) {
    const key = qKey(test);
    if (quarantinedSet.has(key)) {
      await unquarantineTest(test.full_title, test.suite_name);
      quarantinedSet.delete(key);
      quarantinedSet = new Set(quarantinedSet);
    } else {
      await quarantineTest(test.full_title, test.file_path, test.suite_name, `Flaky rate: ${test.flaky_rate}%`);
      quarantinedSet.add(key);
      quarantinedSet = new Set(quarantinedSet);
    }
  }
</script>

<div class="page">
  <!-- No <h1> — sidebar nav + URL already label the page, same as
       /manual-tests. Subtitle stays as a quick orientation cue. -->
  <div class="header">
    <p class="description">Tests that alternate between passing and failing across recent runs.</p>
    <div class="filters">
      <select bind:value={selectedSuite} onchange={reload}>
        <option value="all">All suites</option>
        {#each suites as suite}
          <option value={suite}>{suite}</option>
        {/each}
      </select>
      <div class="filter-tabs">
        {#each [10, 20, 30, 50, 100] as w}
          <button class="filter-tab" class:active={runWindow === w} onclick={() => { runWindow = w; reload(); }}>{w} runs</button>
        {/each}
      </div>
    </div>
  </div>

  {#if loading}
    <p class="status-text">Loading...</p>
  {:else if error}
    <p class="status-text err">{error}</p>
  {:else if tests.length === 0}
    <div class="empty">
      <p>No flaky tests detected.</p>
      <p class="hint">Flaky tests appear when a test passes in some runs and fails in others.</p>
    </div>
  {:else}
    <div class="summary">
      <span class="summary-count">{tests.length}</span> flaky test{tests.length !== 1 ? "s" : ""} found across {runWindow} recent runs
    </div>

    <div class="sort-bar">
      <span class="sort-label">Sort by:</span>
      <div class="filter-tabs">
        <button class="filter-tab" class:active={sortBy === "flaky_rate"} onclick={() => sortBy = "flaky_rate"}>Flaky rate</button>
        <button class="filter-tab" class:active={sortBy === "flip_count"} onclick={() => sortBy = "flip_count"}>Flips</button>
        <button class="filter-tab" class:active={sortBy === "fail_count"} onclick={() => sortBy = "fail_count"}>Failures</button>
        <button class="filter-tab" class:active={sortBy === "last_seen"} onclick={() => sortBy = "last_seen"}>Last seen</button>
      </div>
    </div>

    <!-- Heatmap-style table — each row is a flaky test, each cell in
         the timeline column is one recent run. Pattern jumps out at
         a glance: clustered failures vs. randomly-scattered failures
         look very different, and the eye picks up alternating
         pass/fail (true flakiness) immediately. Clicking a row
         expands AI analysis / quarantine controls / notes inline. -->
    <div class="flaky-heatmap">
      <table class="heatmap-table">
        <thead>
          <tr>
            <th class="col-test">Test</th>
            <th class="col-suite">Suite</th>
            <th class="col-rate">Rate</th>
            <th class="col-flips">Flips</th>
            <th class="col-fails">Fails</th>
            <th class="col-timeline">Timeline (latest →)</th>
            <th class="col-last">Last</th>
          </tr>
        </thead>
        <tbody>
          {#each visibleSorted as test, i}
            <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role:
                 same row-as-button pattern used on /manual-tests + runs list. -->
            <tr
              role="button"
              tabindex="0"
              class="flaky-row"
              class:expanded={expandedIndex === i}
              onclick={() => expandedIndex = expandedIndex === i ? null : i}
              onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); (e.currentTarget as HTMLElement).click(); } }}
            >
              <td class="col-test">
                <div class="test-cell">
                  <span class="test-title" title={test.title}>{test.title}</span>
                  <span class="test-spec" title={test.file_path}>{test.file_path}</span>
                </div>
              </td>
              <td class="col-suite"><span class="suite-chip">{test.suite_name}</span></td>
              <td class="col-rate">
                <span class="rate-pill" style="background: color-mix(in srgb, {rateColor(test.flaky_rate)} 18%, transparent); color: {rateColor(test.flaky_rate)};">{test.flaky_rate}%</span>
              </td>
              <td class="col-flips"><strong>{test.flip_count}</strong></td>
              <td class="col-fails"><strong>{test.fail_count}</strong><span class="dim">/{test.total_runs}</span></td>
              <td class="col-timeline">
                <div class="timeline">
                  {#each test.timeline as status, ti}
                    <span class="timeline-dot {status}" title="Run #{test.run_ids[ti]}: {status}"></span>
                  {/each}
                </div>
              </td>
              <td class="col-last">{timeAgo(test.last_seen)}</td>
            </tr>
            {#if expandedIndex === i}
              <tr class="flaky-detail-row">
                <td colspan="7" class="flaky-detail">
                  <div class="detail-actions">
                    <button class="q-btn" class:quarantined={quarantinedSet.has(qKey(test))} onclick={() => toggleQuarantine(test)}>
                      {quarantinedSet.has(qKey(test)) ? "Unquarantine" : "Quarantine"}
                    </button>
                    {#if aiEnabled && !aiResults[qKey(test)]}
                      <button class="analyze-btn" onclick={() => handleAnalyzeFlaky(test)} disabled={aiLoading[qKey(test)]}>
                        {aiLoading[qKey(test)] ? "Analyzing..." : "Analyze with AI"}
                      </button>
                    {/if}
                    <span class="meta-spacer"></span>
                    <span class="meta-tag">first {timeAgo(test.first_seen)}</span>
                  </div>
                  {#if quarantinedSet.has(qKey(test))}
                    <div class="q-banner">This test is quarantined. CI can skip it via <code>GET /quarantine/check?suite={test.suite_name}</code></div>
                  {/if}
                  {#if aiResults[qKey(test)]}
                    {@const ai = aiResults[qKey(test)]}
                    <div class="ai-result">
                      <div class="ai-header">
                        <span class="ai-severity" class:high={ai.severity === "high"} class:medium={ai.severity === "medium"}>{ai.severity} severity</span>
                        {#if ai.shouldQuarantine}
                          <span class="ai-rec">Quarantine recommended</span>
                        {/if}
                      </div>
                      <p class="ai-text"><strong>Root cause:</strong> {ai.rootCause}</p>
                      <p class="ai-text"><strong>Suggestion:</strong> {ai.stabilizationSuggestion}</p>
                    </div>
                  {/if}
                  <NotesPanel targetType="test" targetKey={test.full_title + '|' + test.file_path} />
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
      <div class="heatmap-legend">
        <span><span class="timeline-dot passed"></span> pass</span>
        <span><span class="timeline-dot failed"></span> fail</span>
        <span><span class="timeline-dot skipped"></span> skip</span>
      </div>
    </div>
    {#if hasMoreFlaky}
      <div class="load-more">
        <button class="load-more-btn" onclick={loadMoreFlaky}>
          Load more ({sorted.length - visibleSorted.length} more)
        </button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .page { max-width: 1920px; margin: 0 auto; padding: 1.5rem 2rem; }

  .header {
    display: flex; justify-content: space-between; align-items: center;
    gap: 1rem; margin-bottom: 1rem; flex-wrap: wrap;
  }
  .description { margin: 0; color: var(--text-secondary); font-size: 0.875rem; }

  .filters { display: flex; gap: 0.5rem; flex-shrink: 0; align-items: center; }
  select {
    padding: 0.35rem 0.6rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--text); font-size: 0.85rem;
  }

  /* .filter-tabs / .filter-tab base styles live in src/app.css. */

  .status-text { color: var(--text-secondary); }
  .status-text.err { color: var(--color-fail); }

  .empty { padding: 3rem 0; text-align: center; color: var(--text-secondary); }
  .hint { font-size: 0.875rem; color: var(--text-muted); }

  .summary {
    font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.75rem;
  }
  .summary-count { font-weight: 700; color: var(--color-fail); font-size: 1rem; }

  .sort-bar {
    display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem;
  }
  .sort-label { font-size: 0.75rem; color: var(--text-muted); }

  /* Heatmap table — fixed layout so timeline cells fill all available
     width and dots stay evenly distributed. Test + Suite columns clip
     long content with an ellipsis. */
  .flaky-heatmap {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .heatmap-table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    font-size: 0.85rem;
  }
  .heatmap-table th, .heatmap-table td {
    padding: 0.55rem 0.75rem;
    text-align: left;
    border-bottom: 1px solid var(--border);
    overflow: hidden;
    vertical-align: middle;
  }
  .heatmap-table th {
    background: var(--bg-secondary);
    color: var(--text-muted);
    font-weight: 600; text-transform: uppercase;
    font-size: 0.68rem; letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .heatmap-table tbody tr:last-child td { border-bottom: none; }
  .heatmap-table tbody tr.flaky-row { cursor: pointer; transition: background 0.1s; }
  .heatmap-table tbody tr.flaky-row:hover { background: var(--bg-hover); }
  .heatmap-table tbody tr.flaky-row:focus-visible { outline: 2px solid var(--link); outline-offset: -2px; }
  .heatmap-table tbody tr.flaky-row.expanded { background: var(--bg-hover); }

  /* Column widths — Test takes whatever's left; Timeline gets a wide
     fixed share so dots stay readable; the rest are compact. */
  .col-test     { width: 28%; }
  .col-suite    { width: 130px; }
  .col-rate     { width: 80px; text-align: center; }
  .col-flips    { width: 70px; text-align: right; font-variant-numeric: tabular-nums; }
  .col-fails    { width: 90px; text-align: right; font-variant-numeric: tabular-nums; }
  .col-timeline { width: auto; }
  .col-last     { width: 100px; white-space: nowrap; color: var(--text-muted); font-size: 0.78rem; }

  .test-cell { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
  .test-title { font-weight: 500; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .test-spec  { font-family: monospace; font-size: 0.72rem; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .suite-chip {
    padding: 0.1rem 0.45rem; border-radius: 10px; font-size: 0.7rem;
    background: var(--bg-secondary); color: var(--text-secondary);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    display: inline-block; max-width: 100%;
  }
  .rate-pill {
    display: inline-block;
    padding: 0.15rem 0.55rem; border-radius: 10px;
    font-weight: 700; font-size: 0.78rem; font-variant-numeric: tabular-nums;
  }
  .dim { color: var(--text-muted); }

  /* Timeline — fills its column. Dots scale to fit so adding more
     historical runs doesn't break the layout. */
  .timeline {
    display: flex; gap: 2px; align-items: center; min-width: 0;
  }
  .timeline-dot {
    flex: 1 1 0;
    min-width: 6px; max-width: 14px;
    height: 14px;
    border-radius: 2px;
    display: inline-block;
  }
  .timeline-dot.passed  { background: var(--color-pass); }
  .timeline-dot.failed  { background: var(--color-fail); }
  .timeline-dot.skipped { background: var(--color-skip); }

  .heatmap-legend {
    display: flex; gap: 1rem; padding: 0.4rem 0.75rem;
    background: var(--bg-secondary);
    border-top: 1px solid var(--border);
    font-size: 0.7rem; color: var(--text-muted);
  }
  .heatmap-legend .timeline-dot { width: 10px; height: 10px; flex: 0 0 auto; margin-right: 0.25rem; vertical-align: middle; }

  /* Expanded detail row spans full width and looks like a panel
     below the parent row, not another table row. */
  .flaky-detail-row td.flaky-detail {
    padding: 0.75rem 1rem 1rem;
    background: color-mix(in srgb, var(--link) 4%, var(--bg-secondary));
    border-top: 1px dashed var(--border);
  }
  .detail-actions { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.5rem; }
  .meta-spacer { flex: 1; }
  .meta-tag { font-size: 0.72rem; color: var(--text-muted); }

  .q-btn, .analyze-btn {
    padding: 0.3rem 0.65rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--text-secondary); font-size: 0.75rem;
    cursor: pointer;
  }
  .q-btn:hover { background: var(--bg-hover); }
  .q-btn.quarantined { background: color-mix(in srgb, #dfb317 12%, transparent); border-color: #dfb317; color: #dfb317; }
  .analyze-btn:hover { background: var(--bg-hover); }
  .analyze-btn:disabled { opacity: 0.5; cursor: wait; }

  .q-banner {
    padding: 0.4rem 0.65rem; margin-bottom: 0.5rem;
    background: color-mix(in srgb, #dfb317 8%, transparent);
    border: 1px solid #dfb317; border-radius: 6px;
    font-size: 0.75rem; color: var(--text);
  }
  .q-banner code { font-size: 0.7rem; background: var(--bg-secondary); padding: 0.1rem 0.3rem; border-radius: 3px; }

  .ai-result {
    padding: 0.65rem; margin-bottom: 0.5rem;
    background: color-mix(in srgb, var(--link) 5%, transparent);
    border: 1px solid color-mix(in srgb, var(--link) 20%, transparent);
    border-radius: 8px;
  }
  .ai-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.35rem; }
  .ai-severity {
    padding: 0.1rem 0.45rem; border-radius: 10px; font-size: 0.68rem; font-weight: 600;
    background: var(--color-pass); color: #fff; text-transform: capitalize;
  }
  .ai-severity.medium { background: #dfb317; }
  .ai-severity.high { background: var(--color-fail); }
  .ai-rec { font-size: 0.7rem; color: #dfb317; font-weight: 500; }
  .ai-text { font-size: 0.78rem; color: var(--text-secondary); margin: 0 0 0.2rem; }
</style>
