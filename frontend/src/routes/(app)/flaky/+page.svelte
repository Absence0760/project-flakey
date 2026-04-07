<script lang="ts">
  import { onMount } from "svelte";
  import { fetchFlakyTests, fetchRuns, type FlakyTest, type Run } from "$lib/api";

  let tests = $state<FlakyTest[]>([]);
  let allRuns = $state<Run[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  let selectedSuite = $state("all");
  let runWindow = $state(30);

  let suites = $derived([...new Set(allRuns.map((r) => r.suite_name))].sort());

  let sortBy = $state<"flaky_rate" | "flip_count" | "fail_count" | "last_seen">("flaky_rate");
  let sorted = $derived(
    [...tests].sort((a, b) => {
      if (sortBy === "last_seen") return new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime();
      return (b as any)[sortBy] - (a as any)[sortBy];
    })
  );

  onMount(async () => {
    try {
      const [flakyData, runs] = await Promise.all([
        fetchFlakyTests({ runs: runWindow }),
        fetchRuns(),
      ]);
      tests = flakyData;
      allRuns = runs;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load data";
    } finally {
      loading = false;
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
      <select bind:value={runWindow} onchange={reload}>
        <option value={10}>Last 10 runs</option>
        <option value={20}>Last 20 runs</option>
        <option value={30}>Last 30 runs</option>
        <option value={50}>Last 50 runs</option>
        <option value={100}>Last 100 runs</option>
      </select>
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
      Sort by:
      <button class:active={sortBy === "flaky_rate"} onclick={() => sortBy = "flaky_rate"}>Flaky rate</button>
      <button class:active={sortBy === "flip_count"} onclick={() => sortBy = "flip_count"}>Flips</button>
      <button class:active={sortBy === "fail_count"} onclick={() => sortBy = "fail_count"}>Failures</button>
      <button class:active={sortBy === "last_seen"} onclick={() => sortBy = "last_seen"}>Last seen</button>
    </div>

    <div class="flaky-list">
      {#each sorted as test}
        <div class="flaky-card">
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
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .page { max-width: 1100px; padding: 2rem; }

  .header {
    display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1.5rem;
  }
  .description { margin: 0.25rem 0 0; color: var(--text-secondary); font-size: 0.875rem; }

  .filters { display: flex; gap: 0.5rem; flex-shrink: 0; }
  select {
    padding: 0.35rem 0.6rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--text); font-size: 0.85rem;
  }

  .status-text { color: var(--text-secondary); }
  .status-text.err { color: var(--color-fail); }

  .empty { padding: 3rem 0; text-align: center; color: var(--text-secondary); }
  .hint { font-size: 0.875rem; color: var(--text-muted); }

  .summary {
    font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.75rem;
  }
  .summary-count { font-weight: 700; color: var(--color-fail); font-size: 1rem; }

  .sort-bar {
    display: flex; align-items: center; gap: 0.35rem; margin-bottom: 1rem;
    font-size: 0.75rem; color: var(--text-muted);
  }
  .sort-bar button {
    padding: 0.2rem 0.5rem; border: 1px solid var(--border); border-radius: 4px;
    background: var(--bg); color: var(--text-secondary); font-size: 0.72rem; cursor: pointer;
  }
  .sort-bar button:hover { background: var(--bg-hover); }
  .sort-bar button.active { background: var(--link); color: #fff; border-color: var(--link); }

  .flaky-list { display: flex; flex-direction: column; gap: 0.5rem; }

  .flaky-card {
    border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem 1rem;
    background: var(--bg); transition: border-color 0.1s;
  }
  .flaky-card:hover { border-color: color-mix(in srgb, var(--color-skip) 60%, var(--border)); }

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
</style>
