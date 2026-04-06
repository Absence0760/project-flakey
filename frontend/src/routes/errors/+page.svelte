<script lang="ts">
  import { onMount } from "svelte";
  import { fetchErrors, fetchRuns, type ErrorGroup, type Run } from "$lib/api";
  import ErrorModal from "$lib/components/ErrorModal.svelte";

  let errors = $state<ErrorGroup[]>([]);
  let allRuns = $state<Run[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let modalTestId = $state<number | null>(null);

  let selectedSuite = $state("all");
  let selectedRunId = $state("all");

  let suites = $derived([...new Set(allRuns.map((r) => r.suite_name))].sort());
  let filteredRuns = $derived(
    selectedSuite === "all" ? allRuns : allRuns.filter((r) => r.suite_name === selectedSuite)
  );

  onMount(async () => {
    try {
      const [errs, runs] = await Promise.all([fetchErrors(), fetchRuns()]);
      errors = errs;
      allRuns = runs;
    } catch (e) {
      loadError = e instanceof Error ? e.message : "Failed to load errors";
    } finally {
      loading = false;
    }
  });

  async function applyFilters() {
    loading = true;
    try {
      errors = await fetchErrors({
        suite: selectedSuite !== "all" ? selectedSuite : undefined,
        run_id: selectedRunId !== "all" ? Number(selectedRunId) : undefined,
      });
    } catch (e) {
      loadError = e instanceof Error ? e.message : "Failed to load errors";
    } finally {
      loading = false;
    }
  }

  function onSuiteChange() {
    selectedRunId = "all";
    applyFilters();
  }

  function onRunChange() {
    applyFilters();
  }

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
    <div>
      <h1>Errors</h1>
      <p class="description">Failures grouped by error message.</p>
    </div>
    <div class="filters">
      <select bind:value={selectedSuite} onchange={onSuiteChange}>
        <option value="all">All suites</option>
        {#each suites as suite}
          <option value={suite}>{suite}</option>
        {/each}
      </select>
      <select bind:value={selectedRunId} onchange={onRunChange}>
        <option value="all">All runs</option>
        {#each filteredRuns as run}
          <option value={String(run.id)}>Run #{run.id} — {run.branch}</option>
        {/each}
      </select>
    </div>
  </div>

  {#if loading}
    <p class="status">Loading...</p>
  {:else if loadError}
    <p class="status error">{loadError}</p>
  {:else if errors.length === 0}
    <div class="empty">
      <p>No errors found.</p>
      <p class="hint">
        {#if selectedSuite !== "all" || selectedRunId !== "all"}
          Try changing the filters or selecting "All suites" / "All runs".
        {:else}
          Errors appear here when test runs have failures.
        {/if}
      </p>
    </div>
  {:else}
    <div class="error-list">
      {#each errors as err, i}
        <button class="error-card" onclick={() => { if (err.latest_test_id) modalTestId = err.latest_test_id; }}>
          <div class="error-main">
            <span class="error-count">{err.count}x</span>
            <div class="error-info">
              <span class="error-test">{err.test_title}</span>
              <span class="error-message">{err.error_message}</span>
            </div>
          </div>
          <div class="error-meta">
            <span class="error-spec">{err.file_path}</span>
            <span class="error-suite">{err.suite_name}</span>
            <span class="error-time">{timeAgo(err.latest_run_date)}</span>
          </div>
        </button>
      {/each}
    </div>
  {/if}
</div>

<ErrorModal testId={modalTestId} onclose={() => modalTestId = null} />

<style>
  .page {
    max-width: 960px;
    margin: 0 auto;
    padding: 2rem 1rem;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 1.5rem;
  }

  h1 {
    margin: 0;
    font-size: 1.5rem;
  }

  .description {
    margin: 0.25rem 0 0;
    color: var(--text-secondary);
    font-size: 0.875rem;
  }

  .filters {
    display: flex;
    gap: 0.5rem;
    flex-shrink: 0;
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

  .empty {
    padding: 3rem 0;
    text-align: center;
    color: var(--text-secondary);
  }

  .hint {
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  .error-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .error-card {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    width: 100%;
    padding: 0.75rem 1rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    cursor: pointer;
    text-align: left;
    color: var(--text);
    font: inherit;
    transition: background 0.1s, border-color 0.1s;
  }

  .error-card:hover {
    background: var(--bg-hover);
    border-color: var(--color-fail);
  }

  .error-main {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
  }

  .error-count {
    font-weight: 700;
    font-size: 0.85rem;
    color: var(--color-fail);
    min-width: 2rem;
    padding-top: 0.1rem;
  }

  .error-info {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
    flex: 1;
  }

  .error-test {
    font-weight: 500;
    font-size: 0.875rem;
  }

  .error-message {
    font-size: 0.8rem;
    color: var(--color-fail);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .error-meta {
    display: flex;
    gap: 1rem;
    padding-left: 2.75rem;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .error-spec {
    font-family: monospace;
    flex: 1;
  }

  .error-suite {
    font-weight: 500;
  }

</style>
