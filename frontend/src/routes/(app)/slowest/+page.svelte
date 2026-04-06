<script lang="ts">
  import { onMount } from "svelte";
  import { fetchSlowestTests, fetchRuns, type SlowestTest } from "$lib/api";

  let tests = $state<SlowestTest[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let selectedSuite = $state("all");
  let suites = $state<string[]>([]);

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
    try {
      const runs = await fetchRuns();
      suites = [...new Set(runs.map((r) => r.suite_name))].sort();
    } catch {}
    load();
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
    return `${days}d ago`;
  }

  function barWidth(ms: number, max: number): number {
    return Math.max(2, (ms / max) * 100);
  }

  let maxDuration = $derived(tests.length > 0 ? tests[0].avg_duration_ms : 1);
</script>

<div class="page">
  <div class="header">
    <p class="description">Tests ranked by average duration across recent runs.</p>
    {#if suites.length > 1}
      <select bind:value={selectedSuite} onchange={load}>
        <option value="all">All suites</option>
        {#each suites as suite}
          <option value={suite}>{suite}</option>
        {/each}
      </select>
    {/if}
  </div>

  {#if loading}
    <p class="status">Loading...</p>
  {:else if error}
    <p class="status error">{error}</p>
  {:else if tests.length === 0}
    <div class="empty">
      <p>No test data available yet.</p>
      <p class="hint">Tests need at least 2 passing runs to appear here.</p>
    </div>
  {:else}
    <div class="test-list">
      {#each tests as test, i}
        <div class="test-row">
          <span class="rank">#{i + 1}</span>
          <div class="test-info">
            <span class="test-title">{test.title}</span>
            <span class="test-meta">
              <span class="mono">{test.file_path}</span>
              {#if selectedSuite === "all"}
                <span class="suite-badge">{test.suite_name}</span>
              {/if}
              <span>{test.run_count} runs · last {timeAgo(test.last_seen)}</span>
            </span>
          </div>
          <div class="duration-col">
            <div class="duration-bar-track">
              <div class="duration-bar" style:width="{barWidth(test.avg_duration_ms, maxDuration)}%"></div>
            </div>
            <div class="duration-values">
              <span class="dur-avg">{formatMs(test.avg_duration_ms)}</span>
              <span class="dur-range">{formatMs(test.min_duration_ms)} – {formatMs(test.max_duration_ms)}</span>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .page { padding: 2rem; }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1.5rem;
  }

  .description {
    margin: 0;
    color: var(--text-secondary);
    font-size: 0.875rem;
  }

  select {
    padding: 0.35rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font-size: 0.85rem;
  }

  .status { color: var(--text-secondary); }
  .status.error { color: var(--color-fail); }

  .empty { text-align: center; padding: 3rem 0; }
  .empty p { margin: 0; color: var(--text-muted); }
  .hint { font-size: 0.8rem; margin-top: 0.5rem !important; }

  .test-list { display: flex; flex-direction: column; }

  .test-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.65rem 0;
    border-bottom: 1px solid var(--border-light);
  }

  .rank {
    font-family: monospace;
    font-size: 0.75rem;
    color: var(--text-muted);
    min-width: 2rem;
    text-align: right;
    flex-shrink: 0;
  }

  .test-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .test-title {
    font-size: 0.85rem;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .test-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .mono {
    font-family: monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 250px;
  }

  .suite-badge {
    padding: 0.1rem 0.4rem;
    border-radius: 10px;
    font-size: 0.65rem;
    background: var(--bg-secondary);
    color: var(--text-secondary);
  }

  .duration-col {
    width: 220px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .duration-bar-track {
    height: 6px;
    background: var(--border-light);
    border-radius: 3px;
    overflow: hidden;
  }

  .duration-bar {
    height: 100%;
    border-radius: 3px;
    background: var(--color-skip);
    min-width: 2px;
  }

  .duration-values {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }

  .dur-avg {
    font-family: monospace;
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--text);
  }

  .dur-range {
    font-family: monospace;
    font-size: 0.68rem;
    color: var(--text-muted);
  }
</style>
