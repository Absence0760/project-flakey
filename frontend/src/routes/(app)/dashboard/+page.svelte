<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { fetchStats, fetchTrends, fetchSuiteComparisons, type DashboardStats, type TrendsData, type SuiteComparison } from "$lib/api";
  import DateRangePicker from "$lib/components/DateRangePicker.svelte";
  import TrendChart from "$lib/components/TrendChart.svelte";
  import BarChart from "$lib/components/BarChart.svelte";

  let stats = $state<DashboardStats | null>(null);
  let trends = $state<TrendsData | null>(null);
  let suites = $state<SuiteComparison[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  function daysAgo(n: number): string {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  }
  function today(): string {
    return new Date().toISOString().slice(0, 10);
  }
  let fromDate = $state<string | undefined>(daysAgo(7));
  let toDate = $state<string | undefined>(today());

  function syncUrl() {
    const url = new URL(window.location.href);
    if (fromDate) url.searchParams.set("from", fromDate); else url.searchParams.delete("from");
    if (toDate) url.searchParams.set("to", toDate); else url.searchParams.delete("to");
    history.replaceState({}, "", url.toString());
  }
  function readUrl() {
    const p = $page.url.searchParams;
    const f = p.get("from");
    const t = p.get("to");
    if (f) fromDate = f;
    if (t) toDate = t;
  }

  async function loadStats() {
    loading = true;
    error = null;
    try {
      const filters = { from: fromDate, to: toDate };
      [stats, trends, suites] = await Promise.all([
        fetchStats(filters),
        fetchTrends(filters),
        fetchSuiteComparisons(filters),
      ]);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load stats";
    } finally {
      loading = false;
    }
  }

  function handleDateChange(from: string | undefined, to: string | undefined) {
    fromDate = from ?? daysAgo(7);
    toDate = to ?? today();
    syncUrl();
    loadStats();
  }

  onMount(() => {
    readUrl();
    loadStats();
  });

  function formatMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  }

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60000);
    const secs = Math.round((ms % 60000) / 1000);
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  }

  function formatDelta(val: number, suffix = ""): string {
    if (val === 0) return `0${suffix}`;
    return `${val > 0 ? "+" : ""}${val}${suffix}`;
  }

  function passRate(r: { total: number; passed: number }): number {
    return r.total > 0 ? Math.round((r.passed / r.total) * 100) : 0;
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

    <!-- Suite Health -->
    {#if suites.length > 0}
      <section class="section">
        <h2 class="section-title">Suite Health</h2>
        <div class="suite-grid">
          {#each suites as suite}
            {@const rate = passRate(suite.latest)}
            {@const improving = suite.diff && suite.diff.failed < 0}
            {@const regressing = suite.diff && suite.diff.failed > 0}
            <a href={suite.previous ? `/compare?a=${suite.previous.id}&b=${suite.latest.id}` : `/runs/${suite.latest.id}`} class="suite-card" class:healthy={suite.latest.failed === 0} class:unhealthy={suite.latest.failed > 0}>
              <!-- Top: name + trend -->
              <div class="sc-top">
                <h3>{suite.suite_name}</h3>
                {#if suite.diff}
                  <span class="sc-trend" class:improving class:regressing class:stable={!improving && !regressing}>
                    {#if improving}
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 10l4-4 4 4"/></svg>
                    {:else if regressing}
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M4 6l4 4 4-4"/></svg>
                    {:else}
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 8h10"/></svg>
                    {/if}
                  </span>
                {/if}
              </div>

              <!-- Pass rate ring + big number -->
              <div class="sc-rate-row">
                <div class="sc-ring" title="{rate}% pass rate">
                  <svg viewBox="0 0 36 36">
                    <path class="ring-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                    <path class="ring-fill" class:good={rate >= 90} class:warn={rate >= 50 && rate < 90} class:bad={rate < 50}
                      stroke-dasharray="{rate}, 100"
                      d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                  </svg>
                  <span class="ring-text">{rate}%</span>
                </div>
                <div class="sc-rate-detail">
                  {#if suite.diff && suite.diff.pass_rate !== 0}
                    <span class="sc-rate-delta" class:up={suite.diff.pass_rate > 0} class:down={suite.diff.pass_rate < 0}>
                      {formatDelta(suite.diff.pass_rate, "%")}
                    </span>
                  {/if}
                  <span class="sc-time">{timeAgo(suite.latest.created_at)}</span>
                </div>
              </div>

              <!-- Mini stats -->
              <div class="sc-stats">
                <div class="sc-stat">
                  <span class="sc-stat-val">{suite.latest.total}</span>
                  <span class="sc-stat-lbl">total</span>
                </div>
                <div class="sc-stat">
                  <span class="sc-stat-val pass">{suite.latest.passed}</span>
                  <span class="sc-stat-lbl">pass</span>
                </div>
                <div class="sc-stat">
                  <span class="sc-stat-val fail">{suite.latest.failed}</span>
                  <span class="sc-stat-lbl">fail</span>
                  {#if suite.diff && suite.diff.failed !== 0}
                    <span class="sc-stat-delta" class:worse={suite.diff.failed > 0} class:better={suite.diff.failed < 0}>{formatDelta(suite.diff.failed)}</span>
                  {/if}
                </div>
                <div class="sc-stat">
                  <span class="sc-stat-val skip">{suite.latest.skipped}</span>
                  <span class="sc-stat-lbl">skip</span>
                  {#if suite.diff && suite.diff.skipped !== 0}
                    <span class="sc-stat-delta skip-delta">{formatDelta(suite.diff.skipped)}</span>
                  {/if}
                </div>
                <div class="sc-stat">
                  <span class="sc-stat-val muted">{formatDuration(suite.latest.duration_ms)}</span>
                  <span class="sc-stat-lbl">time</span>
                  {#if suite.diff && suite.previous && suite.previous.duration_ms > 0}
                    {@const dPct = Math.round((suite.diff.duration_ms / suite.previous.duration_ms) * 100)}
                    {#if dPct !== 0}
                      <span class="sc-stat-delta" class:worse={dPct > 0} class:better={dPct < 0}>{formatDelta(dPct, "%")}</span>
                    {/if}
                  {/if}
                </div>
              </div>

              <!-- Comparison bar -->
              {#if suite.previous}
                <div class="sc-compare-bar">
                  <div class="sc-bar-segment pass-seg" style="width: {passRate(suite.latest)}%"></div>
                  <div class="sc-bar-segment fail-seg" style="width: {suite.latest.total > 0 ? Math.round(suite.latest.failed / suite.latest.total * 100) : 0}%"></div>
                  <div class="sc-bar-segment skip-seg" style="width: {suite.latest.total > 0 ? Math.round(suite.latest.skipped / suite.latest.total * 100) : 0}%"></div>
                </div>
              {:else}
                <div class="sc-compare-bar">
                  <div class="sc-bar-segment pass-seg" style="width: {passRate(suite.latest)}%"></div>
                  <div class="sc-bar-segment fail-seg" style="width: {suite.latest.total > 0 ? Math.round(suite.latest.failed / suite.latest.total * 100) : 0}%"></div>
                </div>
              {/if}

              <!-- Footer -->
              <div class="sc-footer">
                {#if suite.previous}
                  <span class="sc-run-label">Run #{suite.latest.id} vs #{suite.previous.id}</span>
                {:else}
                  <span class="sc-run-label">Run #{suite.latest.id} — first run</span>
                {/if}
              </div>
            </a>
          {/each}
        </div>
      </section>
    {/if}

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
                  {#if run.aborted}
                    <span class="run-badge aborted" title="Run aborted before completion">ABORTED</span>
                  {/if}
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
    max-width: 1440px;
    margin: 0 auto;
    padding: 1.5rem 2rem;
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

  /* Section */
  .section { margin-bottom: 2rem; }
  .section-title { margin: 0 0 1rem; font-size: 1rem; font-weight: 600; color: var(--text-secondary); }

  /* Suite Health Cards */
  .suite-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 0.75rem;
  }

  .suite-card {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1rem 1.15rem;
    background: var(--bg);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    text-decoration: none;
    color: var(--text);
    transition: all 0.2s;
    position: relative;
    overflow: hidden;
  }

  .suite-card:hover {
    border-color: var(--text-muted);
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06);
    transform: translateY(-1px);
  }

  .suite-card.healthy { border-left: 3px solid var(--color-pass); }
  .suite-card.unhealthy { border-left: 3px solid var(--color-fail); }

  .sc-top { display: flex; align-items: center; justify-content: space-between; }
  .sc-top h3 { margin: 0; font-size: 0.9rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .sc-trend {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .sc-trend.improving { background: color-mix(in srgb, var(--color-pass) 12%, transparent); color: var(--color-pass); }
  .sc-trend.regressing { background: color-mix(in srgb, var(--color-fail) 12%, transparent); color: var(--color-fail); }
  .sc-trend.stable { background: var(--bg-secondary); color: var(--text-muted); }

  /* Ring */
  .sc-rate-row { display: flex; align-items: center; gap: 0.85rem; }

  .sc-ring {
    position: relative;
    width: 52px;
    height: 52px;
    flex-shrink: 0;
  }
  .sc-ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
  .ring-bg { fill: none; stroke: var(--border); stroke-width: 3.5; }
  .ring-fill { fill: none; stroke-width: 3.5; stroke-linecap: round; transition: stroke-dasharray 0.5s ease; }
  .ring-fill.good { stroke: var(--color-pass); }
  .ring-fill.warn { stroke: var(--link); }
  .ring-fill.bad { stroke: var(--color-fail); }
  .ring-text {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.72rem;
    font-weight: 700;
  }

  .sc-rate-detail { display: flex; flex-direction: column; gap: 0.15rem; }
  .sc-rate-delta { font-size: 0.85rem; font-weight: 700; }
  .sc-rate-delta.up { color: var(--color-pass); }
  .sc-rate-delta.down { color: var(--color-fail); }
  .sc-time { font-size: 0.72rem; color: var(--text-muted); }

  /* Stats */
  .sc-stats {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 0.25rem;
  }
  .sc-stat { display: flex; flex-direction: column; align-items: center; gap: 0.05rem; }
  .sc-stat-val { font-size: 0.85rem; font-weight: 700; }
  .sc-stat-val.pass { color: var(--color-pass); }
  .sc-stat-val.fail { color: var(--color-fail); }
  .sc-stat-val.skip { color: var(--color-skip); }
  .sc-stat-val.muted { color: var(--text-secondary); font-size: 0.78rem; }
  .sc-stat-lbl { font-size: 0.6rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .sc-stat-delta { font-size: 0.65rem; font-weight: 600; }
  .sc-stat-delta.worse { color: var(--color-fail); }
  .sc-stat-delta.better { color: var(--color-pass); }
  .sc-stat-delta.skip-delta { color: var(--color-skip); }

  /* Stacked bar */
  .sc-compare-bar {
    display: flex;
    height: 4px;
    border-radius: 2px;
    overflow: hidden;
    background: var(--border);
  }
  .sc-bar-segment { min-width: 0; transition: width 0.4s ease; }
  .pass-seg { background: var(--color-pass); }
  .fail-seg { background: var(--color-fail); }
  .skip-seg { background: var(--color-skip); }

  /* Footer */
  .sc-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.72rem;
    color: var(--text-muted);
  }
  .sc-run-label { font-weight: 500; }
  .sc-vs { font-style: italic; }

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
    max-height: 360px;
    overflow-y: auto;
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

  .run-badge.aborted {
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    background: color-mix(in srgb, var(--color-fail) 15%, transparent);
    color: var(--color-fail);
    border: 1px solid color-mix(in srgb, var(--color-fail) 35%, transparent);
    margin-right: 0.4rem;
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
