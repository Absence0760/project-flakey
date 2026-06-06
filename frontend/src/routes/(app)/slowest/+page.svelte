<script lang="ts">
  import { onMount } from "svelte";
  import { timeAgo, absoluteDate } from "$lib/utils/format";
  import { page } from "$app/stores";
  import { replaceState } from "$app/navigation";
  import { fetchSlowestTests, fetchRuns, type SlowestTest } from "$lib/api";
  import NotesPanel from "$lib/components/panels/NotesPanel.svelte";

  let tests = $state<SlowestTest[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let selectedSuite = $state("all");
  let suites = $state<string[]>([]);
  let sortBy = $state<"avg_duration_ms" | "max_duration_ms" | "trend_pct" | "p95_ms">("avg_duration_ms");
  let searchQuery = $state("");

  function syncUrl() {
    const url = new URL(window.location.href);
    const set = (k: string, v: string, def: string) => { if (v !== def) url.searchParams.set(k, v); else url.searchParams.delete(k); };
    set("suite", selectedSuite, "all");
    set("sort", sortBy, "avg_duration_ms");
    set("q", searchQuery, "");
    replaceState(url, {});
  }
  function readUrl() {
    const p = $page.url.searchParams;
    selectedSuite = p.get("suite") ?? "all";
    sortBy = (p.get("sort") as typeof sortBy) ?? "avg_duration_ms";
    searchQuery = p.get("q") ?? "";
  }
  let mounted = $state(false);
  $effect(() => { selectedSuite; sortBy; searchQuery; if (mounted) syncUrl(); });
  let expandedIndex = $state<number | null>(null);

  // Search filters by title, file path, and suite — the readable strings
  // on a row. Applied before sort so search results stay correctly ranked.
  let filtered = $derived(
    tests.filter((t) => {
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      return t.title.toLowerCase().includes(q)
        || (t.file_path ?? "").toLowerCase().includes(q)
        || t.suite_name.toLowerCase().includes(q);
    })
  );

  let sorted = $derived(
    [...filtered].sort((a, b) => {
      if (sortBy === "trend_pct") return b.trend_pct - a.trend_pct;
      return (b as any)[sortBy] - (a as any)[sortBy];
    })
  );

  let maxDuration = $derived(
    sorted.length > 0 ? Math.max(...sorted.map((t) => t.max_duration_ms)) : 1
  );

  // Summary tiles — computed off the full unfiltered set so the
  // numbers stay stable as the user narrows the list below. Mirrors
  // /flaky / /releases convention.
  // "Slowest avg" is the slowest test's avg duration; "above P95"
  // counts tests whose own avg exceeds their own P95-of-runs (i.e.
  // their average is dragged up by a heavy tail). "Regressing"
  // counts tests trending > 10% slower run-over-run.
  let stats = $derived({
    total: tests.length,
    slowestAvg: tests.length > 0 ? Math.max(...tests.map((t) => t.avg_duration_ms)) : 0,
    abovePct: tests.filter((t) => t.avg_duration_ms > t.p95_ms).length,
    regressing: tests.filter((t) => t.trend_pct > 10).length,
  });

  // At-risk band — tests trending > 10% slower run-over-run, sorted
  // by how fast they're regressing. Capped at 5 so the band stays
  // scannable; mirrors the /releases / /flaky pinned-strip pattern.
  let regressing = $derived(
    [...tests]
      .filter((t) => t.trend_pct > 10)
      .sort((a, b) => b.trend_pct - a.trend_pct)
      .slice(0, 5)
  );

  // Client-side pagination (page size 50). Reset when sort/suite/search
  // changes so the slice always reflects the current ordering.
  const PAGE_SIZE = 50;
  let visibleCount = $state(PAGE_SIZE);
  const visibleSorted = $derived(sorted.slice(0, visibleCount));
  const hasMoreSlowest = $derived(visibleSorted.length < sorted.length);

  $effect(() => {
    selectedSuite; sortBy; searchQuery; // tracked deps
    visibleCount = PAGE_SIZE;
  });

  function loadMoreSlowest() {
    visibleCount = Math.min(visibleCount + PAGE_SIZE, sorted.length);
  }

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

  // Preserve pagination + expanded card + scroll across back/forward.
  export const snapshot = {
    capture: () => ({
      visibleCount,
      expandedIndex,
      scrollY: typeof window !== "undefined" ? window.scrollY : 0,
    }),
    restore: (s: { visibleCount: number; expandedIndex: number | null; scrollY: number }) => {
      visibleCount = s.visibleCount;
      expandedIndex = s.expandedIndex;
      queueMicrotask(() => window.scrollTo({ top: s.scrollY, behavior: "instant" as ScrollBehavior }));
    },
  };

  function formatMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
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

  // Identity key for a slowest-test row — matches the at-risk band's
  // scroll target. Title + suite is unique enough across the seeded
  // dataset and survives pagination index shifts.
  function rowKey(t: SlowestTest) { return `${t.title}|${t.suite_name}`; }

  function scrollToTest(t: SlowestTest) {
    const key = rowKey(t);
    const idx = sorted.findIndex((s) => rowKey(s) === key);
    if (idx === -1) return;
    if (idx >= visibleCount) visibleCount = Math.min(idx + 10, sorted.length);
    expandedIndex = idx;
    setTimeout(() => {
      const row = document.querySelectorAll(".test-list .test-card")[idx] as HTMLElement | undefined;
      row?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 30);
  }
</script>

<div class="page" data-ready={!loading ? "true" : undefined}>
  <!-- Summary tile strip — same shape as /flaky / /releases / /runs.
       Counts read from the full `tests` set so the strip stays stable
       as the user filters / searches below. -->
  {#if !loading && tests.length > 0}
    <section class="summary">
      <div class="stat">
        <span class="stat-label">Tracked tests</span>
        <span class="stat-value">{stats.total}</span>
        <span class="stat-sub">with 2+ runs</span>
      </div>
      <div class="stat">
        <span class="stat-label">Slowest avg</span>
        <span class="stat-value">{formatMs(stats.slowestAvg)}</span>
        <span class="stat-sub">top of list</span>
      </div>
      <div class="stat" class:medium={stats.abovePct > 0}>
        <span class="stat-label">Heavy-tail</span>
        <span class="stat-value">{stats.abovePct}</span>
        <span class="stat-sub">avg above own P95</span>
      </div>
      <div class="stat" class:risk={stats.regressing > 0}>
        <span class="stat-label">Regressing</span>
        <span class="stat-value">{stats.regressing}</span>
        <span class="stat-sub">trending &gt; 10% slower</span>
      </div>
    </section>
  {/if}

  <!-- Header: one-line description on the left, suite filter on the
       right. Same `.filters select` selector the e2e specs anchor on. -->
  <div class="header">
    <p class="description">Tests ranked by duration with percentiles and trend analysis.</p>
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
    <!-- At-risk band — pinned tests trending > 10% slower. Mirrors the
         /releases / /flaky pinned strip. Clicking a row scrolls the
         matching card into view and expands it. -->
    {#if regressing.length > 0}
      <section class="at-risk-band" aria-label="Tests getting slower">
        <header class="at-risk-header">
          <svg class="at-risk-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 1.5L15 14H1L8 1.5zm0 4.5v4M8 11.5v.5"/>
          </svg>
          <span class="at-risk-title">{regressing.length} test{regressing.length === 1 ? "" : "s"} getting slower (&gt; 10% trend)</span>
        </header>
        <div class="at-risk-list">
          {#each regressing as t}
            <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
            <div
              role="button"
              tabindex="0"
              class="at-risk-item"
              onclick={() => scrollToTest(t)}
              onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); (e.currentTarget as HTMLElement).click(); } }}
            >
              <span class="at-risk-trend">+{t.trend_pct}%</span>
              <span class="at-risk-suite">{t.suite_name}</span>
              <span class="at-risk-test" title={t.title}>{t.title}</span>
              <span class="at-risk-spacer"></span>
              <span class="at-risk-avg">{formatMs(t.avg_duration_ms)} avg</span>
              <span class="at-risk-last" title={absoluteDate(t.last_seen)}>{timeAgo(t.last_seen)}</span>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <!-- Toolbar: sort tabs (segmented control) + search box on a single
         row. `.sort-bar` class kept so the e2e selector
         `.sort-bar .filter-tab` still resolves. -->
    <div class="sort-bar toolbar">
      <div class="sort-group">
        <span class="sort-label">Sort by</span>
        <div class="filter-tabs">
          <button class="filter-tab" class:active={sortBy === "avg_duration_ms"} onclick={() => sortBy = "avg_duration_ms"}>Average</button>
          <button class="filter-tab" class:active={sortBy === "max_duration_ms"} onclick={() => sortBy = "max_duration_ms"}>Max</button>
          <button class="filter-tab" class:active={sortBy === "p95_ms"} onclick={() => sortBy = "p95_ms"}>P95</button>
          <button class="filter-tab" class:active={sortBy === "trend_pct"} onclick={() => sortBy = "trend_pct"}>Getting slower</button>
        </div>
      </div>

      <div class="toolbar-right">
        <div class="search-box">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>
          <input type="text" placeholder="Search tests..." bind:value={searchQuery} />
        </div>
        {#if searchQuery}
          <span class="filter-summary">showing {sorted.length} of {tests.length}</span>
        {/if}
      </div>
    </div>

    {#if sorted.length === 0}
      <div class="empty filtered-empty">
        <p>No tests match your search.</p>
        <p class="hint">Try clearing the search box or switching suites.</p>
      </div>
    {:else}
      <!-- Horizontal ranked bars — each row's bar fills its proportional
           share of the slowest test in the visible set, so the eye picks
           out the worst offenders without needing to read numbers.
           Sparkline sits at the right to surface recent-run trend at a
           glance; the precise avg + range numbers sit above the bar. -->
      <div class="test-list">
        {#each visibleSorted as test, i}
          <div class="test-card" class:expanded={expandedIndex === i}>
            <button class="test-header" onclick={() => expandedIndex = expandedIndex === i ? null : i}>
              <span class="rank">#{i + 1}</span>
              <div class="test-info">
                <div class="title-row">
                  <span class="test-title">{test.title}</span>
                  {#if selectedSuite === "all"}
                    <span class="suite-badge">{test.suite_name}</span>
                  {/if}
                  <span class="trend-value" style="color: {trendColor(test.trend_pct)}">{trendLabel(test.trend_pct)}</span>
                </div>
                <div class="bar-row">
                  <div class="duration-bar-track">
                    <div class="duration-bar-fill" style="width: {(test.avg_duration_ms / maxDuration) * 100}%"></div>
                    <div class="duration-bar-max" style="left: {(test.max_duration_ms / maxDuration) * 100}%" title="max {formatMs(test.max_duration_ms)}"></div>
                  </div>
                  <div class="bar-stats">
                    <span class="dur-avg">{formatMs(test.avg_duration_ms)}</span>
                    <span class="dur-range">{formatMs(test.min_duration_ms)}–{formatMs(test.max_duration_ms)}</span>
                  </div>
                </div>
                <span class="test-meta">
                  <span class="mono">{test.file_path}</span>
                </span>
              </div>

              <div class="spark" title="Recent durations">
                {#each test.duration_history.slice(-20) as dur}
                  <div class="spark-bar" class:hot={dur > test.p95_ms} style="height: {sparkHeight(dur, test.max_duration_ms)}px"></div>
                {/each}
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
                    <span class="detail-value" title={absoluteDate(test.first_seen)}>{timeAgo(test.first_seen)}</span>
                  </div>
                  <div class="detail-item">
                    <span class="detail-label">Last seen</span>
                    <span class="detail-value" title={absoluteDate(test.last_seen)}>{timeAgo(test.last_seen)}</span>
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
      {#if hasMoreSlowest}
        <div class="load-more">
          <button class="load-more-btn" onclick={loadMoreSlowest}>
            Load more ({sorted.length - visibleSorted.length} more)
          </button>
        </div>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .page { max-width: 1920px; margin: 0 auto; padding: 1.5rem 2rem; }

  /* Summary tile strip — same shape as /flaky / /releases. */
  .summary { display: flex; gap: 0.75rem; margin-bottom: 1rem; }
  .stat {
    flex: 1; background: var(--bg); border: 1px solid var(--border);
    border-radius: 8px; padding: 0.6rem 0.9rem;
    display: flex; flex-direction: column; gap: 0.1rem;
  }
  .stat-label { font-size: 0.68rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .stat-value { font-size: 1.35rem; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; line-height: 1.15; }
  .stat-sub { font-size: 0.7rem; color: var(--text-muted); }
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

  .header {
    display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem;
    gap: 1rem; flex-wrap: wrap;
  }
  .description { margin: 0; color: var(--text-secondary); font-size: 0.875rem; }
  .filters { display: flex; gap: 0.5rem; align-items: center; flex-shrink: 0; }
  select {
    padding: 0.35rem 0.6rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--text); font-size: 0.85rem;
  }

  /* At-risk band — tests trending faster than +10%. Mirrors the
     /releases / /flaky pinned strip: tinted background, 4px left
     stripe, hidden when empty, items are clickable scroll-to rows. */
  .at-risk-band {
    background: color-mix(in srgb, var(--color-fail) 6%, var(--bg));
    border: 1px solid color-mix(in srgb, var(--color-fail) 25%, var(--border));
    border-left: 4px solid var(--color-fail);
    border-radius: 8px;
    padding: 0.65rem 0.85rem;
    margin-bottom: 1rem;
    display: flex; flex-direction: column; gap: 0.45rem;
  }
  .at-risk-header { display: flex; align-items: center; gap: 0.4rem; }
  .at-risk-icon { color: var(--color-fail); }
  .at-risk-title { font-weight: 600; font-size: 0.82rem; color: var(--text); }
  .at-risk-list { display: flex; flex-direction: column; gap: 0.3rem; }
  .at-risk-item {
    display: flex; align-items: center; gap: 0.7rem;
    padding: 0.4rem 0.65rem;
    background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    font-size: 0.82rem; cursor: pointer;
    transition: border-color 0.1s;
  }
  .at-risk-item:hover { border-color: var(--color-fail); }
  .at-risk-item:focus-visible { outline: 2px solid var(--color-fail); outline-offset: -2px; }
  .at-risk-trend {
    padding: 0.1rem 0.45rem; border-radius: 10px;
    background: color-mix(in srgb, var(--color-fail) 18%, transparent);
    color: var(--color-fail); font-weight: 700; font-size: 0.78rem;
    font-variant-numeric: tabular-nums; flex-shrink: 0;
  }
  .at-risk-suite {
    padding: 0.1rem 0.45rem; border-radius: 10px;
    background: var(--bg-secondary); color: var(--text-secondary);
    font-size: 0.7rem; flex-shrink: 0; max-width: 160px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .at-risk-test {
    color: var(--text); font-weight: 500;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    min-width: 0;
  }
  .at-risk-spacer { flex: 1; }
  .at-risk-avg, .at-risk-last { color: var(--text-muted); font-size: 0.75rem; flex-shrink: 0; font-variant-numeric: tabular-nums; }

  /* Toolbar — sort tabs + search on one row. `.sort-bar` class kept
     so e2e selector `.sort-bar .filter-tab` still resolves. */
  .sort-bar.toolbar {
    display: flex; justify-content: space-between; align-items: center;
    gap: 0.75rem; margin-bottom: 0.8rem; flex-wrap: wrap;
  }
  .sort-group { display: flex; align-items: center; gap: 0.5rem; }
  .sort-label { font-size: 0.75rem; color: var(--text-muted); }
  .toolbar-right { display: flex; align-items: center; gap: 0.6rem; }
  .filter-summary { font-style: italic; color: var(--text-muted); font-size: 0.78rem; }
  .search-box {
    display: flex; align-items: center; gap: 0.4rem;
    padding: 0.35rem 0.6rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--text-muted);
  }
  .search-box:focus-within { border-color: var(--link); }
  .search-box input {
    border: none; background: transparent; outline: none;
    font-size: 0.8rem; color: var(--text); width: 200px;
  }
  .search-box input::placeholder { color: var(--text-muted); }

  /* .filter-tabs / .filter-tab base styles live in src/app.css. */

  .status-text { color: var(--text-secondary); }
  .status-text.err { color: var(--color-fail); }
  .empty { text-align: center; padding: 3rem 0; color: var(--text-muted); }
  .filtered-empty { padding: 2rem 0; }
  .hint { font-size: 0.8rem; margin-top: 0.5rem; }

  .test-list { display: flex; flex-direction: column; gap: 0.4rem; }

  .test-card {
    border: 1px solid var(--border); border-radius: 8px; background: var(--bg);
    overflow: hidden; transition: border-color 0.1s;
  }
  .test-card:hover, .test-card.expanded { border-color: color-mix(in srgb, var(--color-skip) 60%, var(--border)); }

  .test-header {
    display: flex; align-items: stretch; gap: 0.85rem; width: 100%;
    padding: 0.7rem 1rem; cursor: pointer; text-align: left; color: var(--text);
    font: inherit; background: none; border: none;
  }

  .rank {
    font-family: monospace; font-size: 0.78rem; font-weight: 700;
    color: var(--text-muted);
    min-width: 2.5rem; text-align: right; flex-shrink: 0;
    align-self: center;
  }

  .test-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.3rem; }

  /* Title + suite + trend on the first line */
  .title-row { display: flex; align-items: baseline; gap: 0.6rem; }
  .test-title {
    font-size: 0.88rem; font-weight: 500;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    flex: 1 1 auto; min-width: 0;
  }
  .suite-badge {
    padding: 0.1rem 0.45rem; border-radius: 10px; font-size: 0.65rem;
    background: var(--bg-secondary); color: var(--text-secondary);
    flex-shrink: 0;
  }
  .trend-value { font-size: 0.75rem; font-weight: 700; flex-shrink: 0; min-width: 56px; text-align: right; }

  /* Full-width duration bar — the visual centerpiece. Bar fills the
     available row width so a 12s vs 6s test is obvious at a glance
     without reading numbers. Numeric stats sit immediately to the
     right at a fixed width. */
  .bar-row { display: flex; align-items: center; gap: 0.6rem; }
  .duration-bar-track {
    flex: 1 1 auto;
    height: 10px;
    background: var(--bg-secondary);
    border-radius: 5px; overflow: hidden; position: relative;
    border: 1px solid var(--border-light);
  }
  .duration-bar-fill {
    height: 100%;
    background: linear-gradient(90deg,
      color-mix(in srgb, var(--color-skip) 30%, transparent) 0%,
      color-mix(in srgb, var(--color-skip) 75%, transparent) 100%);
    border-radius: 4px 0 0 4px;
    transition: width 0.25s ease-out;
  }
  /* Max-duration tick mark sits on top of the bar so the user can
     see the spread between avg and max without an extra row. */
  .duration-bar-max {
    position: absolute; top: -2px;
    width: 2px; height: calc(100% + 4px);
    background: var(--color-fail);
    transform: translateX(-1px);
    opacity: 0.6;
  }
  .bar-stats {
    display: flex; flex-direction: column; align-items: flex-end;
    flex-shrink: 0; min-width: 130px;
    line-height: 1.1;
  }
  .dur-avg { font-family: monospace; font-size: 0.95rem; font-weight: 700; color: var(--text); }
  .dur-range { font-family: monospace; font-size: 0.7rem; color: var(--text-muted); }

  /* File path on a faded second line */
  .test-meta { display: flex; align-items: center; gap: 0.5rem; font-size: 0.72rem; color: var(--text-muted); }
  .mono { font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }

  /* Sparkline at the right edge — taller now to balance the bigger
     bar; bars above P95 turn red to surface regression visually. */
  .spark {
    display: flex; align-items: flex-end; gap: 2px;
    height: 32px; flex-shrink: 0;
    align-self: center;
    padding-left: 0.5rem;
    border-left: 1px solid var(--border-light);
  }
  .spark-bar { width: 4px; background: var(--color-skip); border-radius: 1px 1px 0 0; opacity: 0.7; }
  .spark-bar.hot { background: var(--color-fail); opacity: 0.85; }

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
