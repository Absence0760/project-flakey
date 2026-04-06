<script lang="ts">
  import { onMount } from "svelte";
  import { fetchStats, fetchTrends, type DashboardStats, type TrendsData } from "$lib/api";
  import DateRangePicker from "$lib/components/DateRangePicker.svelte";
  import TrendChart from "$lib/components/TrendChart.svelte";
  import BarChart from "$lib/components/BarChart.svelte";

  let stats = $state<DashboardStats | null>(null);
  let trends = $state<TrendsData | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let fromDate = $state<string | undefined>(undefined);
  let toDate = $state<string | undefined>(undefined);

  async function loadStats() {
    loading = true;
    error = null;
    try {
      const filters = { from: fromDate, to: toDate };
      [stats, trends] = await Promise.all([
        fetchStats(filters),
        fetchTrends(filters),
      ]);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load stats";
    } finally {
      loading = false;
    }
  }

  function handleDateChange(from: string | undefined, to: string | undefined) {
    fromDate = from;
    toDate = to;
    loadStats();
  }

  onMount(() => loadStats());

  function formatMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  }

  let passRateSeries = $derived.by(() => {
    if (!trends) return [];
    return [{
      label: "Pass Rate",
      color: "var(--color-pass)",
      data: trends.pass_rate.map((p) => ({ label: p.date, value: Number(p.pass_rate) })),
    }];
  });

  let volumeSeries = $derived.by(() => {
    if (!trends) return [];
    return [
      {
        label: "Passed",
        color: "var(--color-pass)",
        data: trends.pass_rate.map((p) => ({ label: p.date, value: p.passed })),
      },
      {
        label: "Failed",
        color: "var(--color-fail)",
        data: trends.pass_rate.map((p) => ({ label: p.date, value: p.failed })),
      },
    ];
  });

  let durationSeries = $derived.by(() => {
    if (!trends) return [];
    return [
      {
        label: "Avg Duration",
        color: "var(--link)",
        data: trends.duration.map((d) => ({ label: d.date, value: d.avg_duration_ms })),
      },
      {
        label: "Max Duration",
        color: "var(--text-muted)",
        data: trends.duration.map((d) => ({ label: d.date, value: d.max_duration_ms })),
      },
    ];
  });

  let topFailureBars = $derived.by(() => {
    if (!trends) return [];
    return trends.top_failures.map((f) => ({
      label: f.test_title,
      subtitle: f.file_path,
      value: f.failure_count,
    }));
  });

  function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }
</script>

<div class="page">
  <div class="header">
    <DateRangePicker from={fromDate} to={toDate} onchange={handleDateChange} />
  </div>

  {#if loading}
    <p class="status">Loading...</p>
  {:else if error}
    <p class="status error">{error}</p>
  {:else if stats}
    <div class="metrics">
      <div class="metric">
        <span class="metric-value">{stats.total_runs}</span>
        <span class="metric-label">Total Runs</span>
      </div>
      <div class="metric">
        <span class="metric-value">{stats.total_tests}</span>
        <span class="metric-label">Total Tests</span>
      </div>
      <div class="metric">
        <span class="metric-value pass">{stats.pass_rate}%</span>
        <span class="metric-label">Pass Rate</span>
      </div>
      <div class="metric">
        <span class="metric-value fail">{stats.total_failed}</span>
        <span class="metric-label">Total Failures</span>
      </div>
    </div>

    {#if trends}
      <div class="charts">
        <section class="chart-card wide">
          <h2>Pass Rate Over Time</h2>
          <TrendChart
            series={passRateSeries}
            height={220}
            yMax={100}
            formatY={(v) => `${v}%`}
          />
        </section>

        <section class="chart-card">
          <h2>Test Volume</h2>
          <TrendChart
            series={volumeSeries}
            height={200}
            formatY={(v) => String(v)}
          />
        </section>

        <section class="chart-card">
          <h2>Run Duration</h2>
          <TrendChart
            series={durationSeries}
            height={200}
            formatY={formatMs}
            formatTooltip={(p) => formatMs(p.value)}
          />
        </section>

        <section class="chart-card wide">
          <h2>Top Failing Tests</h2>
          <BarChart
            bars={topFailureBars}
            formatValue={(v) => `${v}x`}
          />
        </section>
      </div>
    {/if}

    <div class="panels">
      <section class="panel">
        <h2>Recent Runs</h2>
        {#if stats.recent_runs.length === 0}
          <p class="empty">No runs yet.</p>
        {:else}
          <ul class="run-list">
            {#each stats.recent_runs as run}
              <li>
                <a href="/runs/{run.id}">
                  <span class="run-id">#{run.id}</span>
                  <span class="run-suite">{run.suite_name}</span>
                  <span class="run-result" class:has-failures={run.failed > 0}>
                    {run.passed}/{run.total}
                  </span>
                  <span class="run-time">{timeAgo(run.created_at)}</span>
                </a>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <section class="panel">
        <h2>Recent Failures</h2>
        {#if stats.recent_failures.length === 0}
          <p class="empty">No failures. Nice!</p>
        {:else}
          <ul class="failure-list">
            {#each stats.recent_failures as failure}
              <li>
                <a href="/runs/{failure.run_id}">
                  <span class="failure-test">{failure.test_title}</span>
                  <span class="failure-error">{failure.error_message}</span>
                  <span class="failure-spec">{failure.file_path}</span>
                </a>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    </div>
  {/if}
</div>

<style>
  .page {
    padding: 2rem 2rem;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    margin-bottom: 1.5rem;
  }

  .status { color: var(--text-secondary); }
  .status.error { color: var(--color-fail); }

  .metrics {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1rem;
    margin-bottom: 2rem;
  }

  .metric {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .metric-value {
    font-size: 1.75rem;
    font-weight: 700;
  }

  .metric-value.pass { color: var(--color-pass); }
  .metric-value.fail { color: var(--color-fail); }

  .metric-label {
    font-size: 0.8rem;
    color: var(--text-muted);
    text-transform: uppercase;
  }

  .charts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    margin-bottom: 2rem;
  }

  .chart-card {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1rem 1.25rem;
    min-width: 0;
    overflow: hidden;
  }

  .chart-card.wide {
    grid-column: 1 / -1;
  }

  .chart-card h2 {
    margin: 0 0 0.75rem;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .panels {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }

  .panel {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1.25rem;
  }

  .panel h2 {
    margin: 0 0 1rem;
    font-size: 0.95rem;
  }

  .empty {
    color: var(--text-muted);
    font-size: 0.875rem;
    margin: 0;
  }

  .run-list, .failure-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .run-list a {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.4rem 0.5rem;
    border-radius: 4px;
    text-decoration: none;
    color: var(--text);
    font-size: 0.85rem;
    transition: background 0.1s;
  }

  .run-list a:hover {
    background: var(--bg-hover);
  }

  .run-id {
    color: var(--link);
    font-weight: 600;
    min-width: 2.5rem;
  }

  .run-suite {
    flex: 1;
    color: var(--text-secondary);
  }

  .run-result {
    font-family: monospace;
    font-size: 0.8rem;
    color: var(--color-pass);
  }

  .run-result.has-failures {
    color: var(--color-fail);
  }

  .run-time {
    color: var(--text-muted);
    font-size: 0.8rem;
    min-width: 4rem;
    text-align: right;
  }

  .failure-list a {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0.5rem;
    border-radius: 4px;
    text-decoration: none;
    color: var(--text);
    transition: background 0.1s;
  }

  .failure-list a:hover {
    background: var(--bg-hover);
  }

  .failure-list li + li {
    border-top: 1px solid var(--border-light);
  }

  .failure-test {
    font-size: 0.85rem;
    font-weight: 500;
  }

  .failure-error {
    font-size: 0.8rem;
    color: var(--color-fail);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .failure-spec {
    font-size: 0.75rem;
    color: var(--text-muted);
    font-family: monospace;
  }
</style>
