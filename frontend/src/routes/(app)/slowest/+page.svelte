<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { fetchSlowestTests, fetchRuns, type SlowestTest } from "$lib/api";
  import NotesPanel from "$lib/components/NotesPanel.svelte";

  let tests = $state<SlowestTest[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let selectedSuite = $state("all");
  let suites = $state<string[]>([]);
  let sortBy = $state<"avg_duration_ms" | "max_duration_ms" | "trend_pct" | "p95_ms">("avg_duration_ms");

  function syncUrl() {
    const url = new URL(window.location.href);
    const set = (k: string, v: string, def: string) => { if (v !== def) url.searchParams.set(k, v); else url.searchParams.delete(k); };
    set("suite", selectedSuite, "all");
    set("sort", sortBy, "avg_duration_ms");
    history.replaceState({}, "", url.toString());
  }
  function readUrl() {
    const p = $page.url.searchParams;
    selectedSuite = p.get("suite") ?? "all";
    sortBy = (p.get("sort") as typeof sortBy) ?? "avg_duration_ms";
  }
  let mounted = $state(false);
  $effect(() => { selectedSuite; sortBy; if (mounted) syncUrl(); });
  let expandedIndex = $state<number | null>(null);

  let sorted = $derived(
    [...tests].sort((a, b) => {
      if (sortBy === "trend_pct") return b.trend_pct - a.trend_pct;
      return (b as any)[sortBy] - (a as any)[sortBy];
    })
  );

  let maxDuration = $derived(
    sorted.length > 0 ? Math.max(...sorted.map((t) => t.max_duration_ms)) : 1
  );

  async function load() {
    loading = true;
    error = null;
    try {
      tests = await fetchSlowestTests(selectedSuite === "all" ? undefined : selectedSuite);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load";
    } finally {
      loading = false;
    }
  }

  onMount(async () => {
    readUrl();
    try {
      const runs = await fetchRuns();
      suites = [...new Set(runs.map((r) => r.suite_name))].sort();
    } catch {}
    await load();
    mounted = true;
  });

  function formatMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  }

  function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const days = Math.floor(diff / 86400000);
    if (days === 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return `${days}d ago`;
    return `${Math.floor(days / 30)}mo ago`;
  }

  function trendLabel(pct: number): string {
    if (pct > 5) return `+${pct}%`;
    if (pct < -5) return `${pct}%`;
    return "stable";
  }

  function trendColor(pct: number): string {
    if (pct > 20) return "var(--color-fail)";
    if (pct > 5) return "#dfb317";
    if (pct < -5) return "var(--color-pass)";
    return "var(--text-muted)";
  }

  function sparkHeight(val: number, max: number): number {
    return Math.max(2, (val / max) * 24);
  }
</script>

<div class="page">
  <div class="header">
    <div>
      <p class="description">Tests ranked by duration with percentiles and trend analysis.</p>
    </div>
    <div class="filters">
      {#if suites.length > 1}
        <select bind:value={selectedSuite} onchange={load}>
          <option value="all">All suites</option>
          {#each suites as suite}
            <option value={suite}>{suite}</option>
          {/each}
        </select>
      {/if}
    </div>
  </div>

  <div class="sort-bar">
    <span class="sort-label">Sort by:</span>
    <div class="filter-tabs">
      <button class="filter-tab" class:active={sortBy === "avg_duration_ms"} onclick={() => sortBy = "avg_duration_ms"}>Average</button>
      <button class="filter-tab" class:active={sortBy === "max_duration_ms"} onclick={() => sortBy = "max_duration_ms"}>Max</button>
      <button class="filter-tab" class:active={sortBy === "p95_ms"} onclick={() => sortBy = "p95_ms"}>P95</button>
      <button class="filter-tab" class:active={sortBy === "trend_pct"} onclick={() => sortBy = "trend_pct"}>Getting slower</button>
    </div>
  </div>

  {#if loading}
    <p class="status-text">Loading...</p>
  {:else if error}
    <p class="status-text err">{error}</p>
  {:else if tests.length === 0}
    <div class="empty">
      <p>No test data available yet.</p>
      <p class="hint">Tests need at least 2 passing runs to appear here.</p>
    </div>
  {:else}
    <div class="test-list">
      {#each sorted as test, i}
        <div class="test-card" class:expanded={expandedIndex === i}>
          <button class="test-header" onclick={() => expandedIndex = expandedIndex === i ? null : i}>
            <span class="rank">#{i + 1}</span>
            <div class="test-info">
              <span class="test-title">{test.title}</span>
              <span class="test-meta">
                <span class="mono">{test.file_path}</span>
                {#if selectedSuite === "all"}
                  <span class="suite-badge">{test.suite_name}</span>
                {/if}
              </span>
            </div>

            <div class="spark">
              {#each test.duration_history.slice(-20) as dur}
                <div class="spark-bar" style="height: {sparkHeight(dur, test.max_duration_ms)}px"></div>
              {/each}
            </div>

            <div class="trend-col">
              <span class="trend-value" style="color: {trendColor(test.trend_pct)}">{trendLabel(test.trend_pct)}</span>
            </div>

            <div class="duration-col">
              <div class="duration-bar-track">
                <div class="duration-bar-range" style="left: {(test.min_duration_ms / maxDuration) * 100}%; width: {((test.max_duration_ms - test.min_duration_ms) / maxDuration) * 100}%"></div>
                <div class="duration-bar-avg" style="left: {(test.avg_duration_ms / maxDuration) * 100}%"></div>
              </div>
              <div class="duration-values">
                <span class="dur-avg">{formatMs(test.avg_duration_ms)}</span>
                <span class="dur-range">{formatMs(test.min_duration_ms)} – {formatMs(test.max_duration_ms)}</span>
              </div>
            </div>
          </button>

          {#if expandedIndex === i}
            <div class="test-detail">
              <div class="detail-grid">
                <div class="detail-item">
                  <span class="detail-label">P50</span>
                  <span class="detail-value">{formatMs(test.p50_ms)}</span>
                </div>
                <div class="detail-item">
                  <span class="detail-label">P95</span>
                  <span class="detail-value">{formatMs(test.p95_ms)}</span>
                </div>
                <div class="detail-item">
                  <span class="detail-label">P99</span>
                  <span class="detail-value">{formatMs(test.p99_ms)}</span>
                </div>
                <div class="detail-item">
                  <span class="detail-label">Runs</span>
                  <span class="detail-value">{test.run_count}</span>
                </div>
                <div class="detail-item">
                  <span class="detail-label">First seen</span>
                  <span class="detail-value">{timeAgo(test.first_seen)}</span>
                </div>
                <div class="detail-item">
                  <span class="detail-label">Last seen</span>
                  <span class="detail-value">{timeAgo(test.last_seen)}</span>
                </div>
              </div>

              <div class="history-chart">
                <h4>Duration History (last {test.duration_history.length} runs)</h4>
                <div class="history-bars">
                  {#each test.duration_history as dur, j}
                    <div class="history-bar-wrapper" title="Run {j + 1}: {formatMs(dur)}">
                      <div
                        class="history-bar"
                        class:above-p95={dur > test.p95_ms}
                        style="height: {Math.max(2, (dur / test.max_duration_ms) * 60)}px"
                      ></div>
                    </div>
                  {/each}
                </div>
                <div class="history-legend">
                  <span class="legend-item"><span class="legend-bar normal"></span> Normal</span>
                  <span class="legend-item"><span class="legend-bar hot"></span> Above P95</span>
                  <span class="legend-line">avg {formatMs(test.avg_duration_ms)}</span>
                </div>
              </div>

              <div class="test-notes">
                <NotesPanel targetType="test" targetKey={test.title + '|' + test.file_path} />
              </div>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .page { max-width: 1100px; padding: 2rem; }

  .header {
    display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem;
  }
  .description { margin: 0; color: var(--text-secondary); font-size: 0.875rem; }
  .filters { display: flex; gap: 0.5rem; }
  select {
    padding: 0.35rem 0.6rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--text); font-size: 0.85rem;
  }

  .sort-bar {
    display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem;
  }
  .sort-label { font-size: 0.75rem; color: var(--text-muted); }

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
  .empty { text-align: center; padding: 3rem 0; color: var(--text-muted); }
  .hint { font-size: 0.8rem; margin-top: 0.5rem; }

  .test-list { display: flex; flex-direction: column; gap: 0.4rem; }

  .test-card {
    border: 1px solid var(--border); border-radius: 8px; background: var(--bg);
    overflow: hidden; transition: border-color 0.1s;
  }
  .test-card:hover, .test-card.expanded { border-color: color-mix(in srgb, var(--color-skip) 60%, var(--border)); }

  .test-header {
    display: flex; align-items: center; gap: 0.75rem; width: 100%;
    padding: 0.65rem 1rem; cursor: pointer; text-align: left; color: var(--text);
    font: inherit; background: none; border: none;
  }

  .rank {
    font-family: monospace; font-size: 0.75rem; color: var(--text-muted);
    min-width: 2rem; text-align: right; flex-shrink: 0;
  }

  .test-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.15rem; }
  .test-title { font-size: 0.85rem; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .test-meta { display: flex; align-items: center; gap: 0.5rem; font-size: 0.72rem; color: var(--text-muted); }
  .mono { font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
  .suite-badge {
    padding: 0.1rem 0.4rem; border-radius: 10px; font-size: 0.65rem;
    background: var(--bg-secondary); color: var(--text-secondary);
  }

  /* Sparkline */
  .spark { display: flex; align-items: flex-end; gap: 1px; height: 24px; flex-shrink: 0; }
  .spark-bar { width: 3px; background: var(--color-skip); border-radius: 1px 1px 0 0; }

  /* Trend */
  .trend-col { width: 50px; flex-shrink: 0; text-align: right; }
  .trend-value { font-size: 0.75rem; font-weight: 700; }

  /* Duration bar */
  .duration-col { width: 180px; flex-shrink: 0; display: flex; flex-direction: column; gap: 0.25rem; }
  .duration-bar-track {
    height: 6px; background: var(--border-light); border-radius: 3px;
    overflow: hidden; position: relative;
  }
  .duration-bar-range {
    position: absolute; height: 100%; background: color-mix(in srgb, var(--color-skip) 40%, transparent);
    border-radius: 3px;
  }
  .duration-bar-avg {
    position: absolute; width: 2px; height: 100%; background: var(--color-skip); border-radius: 1px;
    transform: translateX(-1px);
  }
  .duration-values { display: flex; justify-content: space-between; align-items: baseline; }
  .dur-avg { font-family: monospace; font-size: 0.82rem; font-weight: 600; color: var(--text); }
  .dur-range { font-family: monospace; font-size: 0.68rem; color: var(--text-muted); }

  /* Expanded detail */
  .test-detail { border-top: 1px solid var(--border); padding: 1rem; background: var(--bg-secondary); }

  .detail-grid {
    display: grid; grid-template-columns: repeat(6, 1fr); gap: 0.75rem; margin-bottom: 1rem;
  }
  .detail-item { display: flex; flex-direction: column; gap: 0.1rem; }
  .detail-label { font-size: 0.68rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .detail-value { font-size: 0.85rem; font-weight: 600; font-family: monospace; color: var(--text); }

  .history-chart h4 {
    margin: 0 0 0.5rem; font-size: 0.75rem; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.05em;
  }

  .history-bars {
    display: flex; align-items: flex-end; gap: 2px; height: 60px;
    padding: 0; border-bottom: 1px solid var(--border-light);
  }
  .history-bar-wrapper { flex: 1; display: flex; align-items: flex-end; justify-content: center; }
  .history-bar {
    width: 100%; max-width: 12px; border-radius: 2px 2px 0 0;
    background: var(--color-skip); transition: background 0.1s;
  }
  .history-bar.above-p95 { background: var(--color-fail); }

  .history-legend {
    display: flex; gap: 1rem; margin-top: 0.4rem; font-size: 0.7rem; color: var(--text-muted);
  }
  .legend-item { display: flex; align-items: center; gap: 0.3rem; }
  .legend-bar { width: 10px; height: 8px; border-radius: 2px; }
  .legend-bar.normal { background: var(--color-skip); }
  .legend-bar.hot { background: var(--color-fail); }
  .legend-line { margin-left: auto; font-family: monospace; }

  .test-notes { margin-top: 0.75rem; }
</style>
