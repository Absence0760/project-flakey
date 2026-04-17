<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/stores";
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
    history.replaceState({}, "", url.toString());
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
  <div class="header">
    <div>
      <p class="description">Tests that alternate between passing and failing across recent runs.</p>
    </div>
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

    <div class="flaky-list">
      {#each sorted as test, i}
        <div class="flaky-card" class:expanded={expandedIndex === i}>
          <button class="card-header" onclick={() => expandedIndex = expandedIndex === i ? null : i}>
          <div class="card-top">
            <div class="rate-ring" style="--rate: {test.flaky_rate}; --rate-color: {rateColor(test.flaky_rate)}">
              <span class="rate-value">{test.flaky_rate}%</span>
            </div>
            <div class="card-info">
              <span class="card-title">{test.title}</span>
              <span class="card-spec">{test.file_path}</span>
            </div>
            <div class="card-stats">
              <span class="stat"><strong>{test.flip_count}</strong> flips</span>
              <span class="stat"><strong>{test.fail_count}</strong>/{test.total_runs} failed</span>
              <span class="stat">{test.suite_name}</span>
            </div>
          </div>

          <div class="card-bottom">
            <div class="timeline">
              {#each test.timeline as status, i}
                <span
                  class="timeline-dot {status}"
                  title="Run #{test.run_ids[i]}: {status}"
                ></span>
              {/each}
            </div>
            <div class="card-meta">
              <span>first {timeAgo(test.first_seen)}</span>
              <span>last {timeAgo(test.last_seen)}</span>
            </div>
          </div>
          </button>

          {#if expandedIndex === i}
            <div class="card-detail">
              <div class="detail-actions">
                <button class="q-btn" class:quarantined={quarantinedSet.has(qKey(test))} onclick={() => toggleQuarantine(test)}>
                  {quarantinedSet.has(qKey(test)) ? "Unquarantine" : "Quarantine"}
                </button>
                {#if aiEnabled && !aiResults[qKey(test)]}
                  <button class="analyze-btn" onclick={() => handleAnalyzeFlaky(test)} disabled={aiLoading[qKey(test)]}>
                    {aiLoading[qKey(test)] ? "Analyzing..." : "Analyze with AI"}
                  </button>
                {/if}
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
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .page { max-width: 1440px; margin: 0 auto; padding: 1.5rem 2rem; }

  .header {
    display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1.5rem;
  }
  .description { margin: 0.25rem 0 0; color: var(--text-secondary); font-size: 0.875rem; }

  .filters { display: flex; gap: 0.5rem; flex-shrink: 0; align-items: center; }
  select {
    padding: 0.35rem 0.6rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--text); font-size: 0.85rem;
  }

  .filter-tabs {
    display: flex; gap: 0.2rem; background: var(--bg-secondary); border-radius: 6px; padding: 0.2rem;
  }
  .filter-tab {
    display: flex; align-items: center; gap: 0.35rem; padding: 0.35rem 0.65rem;
    border: none; border-radius: 4px; background: transparent; color: var(--text-secondary);
    font-size: 0.78rem; cursor: pointer; transition: all 0.15s; white-space: nowrap;
  }
  .filter-tab:hover { color: var(--text); }
  .filter-tab.active { background: var(--bg); color: var(--text); font-weight: 600; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06); }

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

  .flaky-list { display: flex; flex-direction: column; gap: 0.5rem; }

  .flaky-card {
    border: 1px solid var(--border); border-radius: 8px;
    background: var(--bg); transition: border-color 0.1s; overflow: hidden;
  }
  .flaky-card:hover, .flaky-card.expanded { border-color: color-mix(in srgb, var(--color-skip) 60%, var(--border)); }

  .card-header {
    display: block; width: 100%; padding: 0.75rem 1rem; cursor: pointer;
    text-align: left; color: var(--text); font: inherit; background: none; border: none;
  }

  .card-detail {
    border-top: 1px solid var(--border); padding: 0.75rem 1rem; background: var(--bg-secondary);
  }

  .card-top { display: flex; align-items: center; gap: 0.75rem; }

  .rate-ring {
    width: 3rem; height: 3rem; border-radius: 50%; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    background: conic-gradient(var(--rate-color) calc(var(--rate) * 1%), var(--border) 0);
    position: relative;
  }
  .rate-ring::before {
    content: ""; position: absolute;
    width: 2.2rem; height: 2.2rem; border-radius: 50%; background: var(--bg);
  }
  .rate-value {
    position: relative; z-index: 1;
    font-size: 0.65rem; font-weight: 700; color: var(--text);
  }

  .card-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.1rem; }
  .card-title { font-weight: 500; font-size: 0.875rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card-spec { font-size: 0.75rem; color: var(--text-muted); font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .card-stats { display: flex; flex-direction: column; gap: 0.1rem; flex-shrink: 0; text-align: right; }
  .stat { font-size: 0.75rem; color: var(--text-secondary); }
  .stat strong { color: var(--text); }

  .card-bottom {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--border-light);
  }

  .timeline { display: flex; gap: 2px; flex-wrap: wrap; flex: 1; }
  .timeline-dot {
    width: 10px; height: 10px; border-radius: 2px;
  }
  .timeline-dot.passed { background: var(--color-pass); }
  .timeline-dot.failed { background: var(--color-fail); }
  .timeline-dot.skipped { background: var(--color-skip); }

  .card-meta { display: flex; gap: 0.75rem; font-size: 0.7rem; color: var(--text-muted); flex-shrink: 0; }

  .detail-actions { display: flex; gap: 0.4rem; margin-bottom: 0.5rem; }

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
