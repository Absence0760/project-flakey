<script lang="ts">
  import { onMount } from "svelte";
  import { fetchRuns, type Run } from "$lib/api";

  let allRuns = $state<Run[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let selectedSuite = $state("all");

  let suites = $derived([...new Set(allRuns.map((r) => r.suite_name))].sort());
  let runs = $derived(
    selectedSuite === "all" ? allRuns : allRuns.filter((r) => r.suite_name === selectedSuite)
  );

  onMount(async () => {
    try {
      allRuns = await fetchRuns();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load runs";
    } finally {
      loading = false;
    }
  });

  function statusColor(run: Run): string {
    if (run.failed > 0) return "var(--color-fail)";
    if (run.passed === run.total) return "var(--color-pass)";
    return "var(--color-skip)";
  }

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString();
  }
</script>

<div class="page">
  <div class="header">
    {#if suites.length > 1}
      <select bind:value={selectedSuite}>
        <option value="all">All suites</option>
        {#each suites as suite}
          <option value={suite}>{suite}</option>
        {/each}
      </select>
    {/if}
  </div>

  {#if loading}
    <p class="status">Loading runs...</p>
  {:else if error}
    <p class="status error">{error}</p>
  {:else if runs.length === 0}
    <div class="empty">
      <p>No test runs yet.</p>
      <p class="hint">Run your Cypress tests and upload results to see them here.</p>
    </div>
  {:else}
    <table>
      <thead>
        <tr>
          <th>Run</th>
          <th>Suite</th>
          <th>Branch</th>
          <th>Status</th>
          <th>Tests</th>
          <th>Duration</th>
          <th>Date</th>
        </tr>
      </thead>
      <tbody>
        {#each runs as run}
          <tr>
            <td><a href="/runs/{run.id}">#{run.id}</a></td>
            <td>{run.suite_name}</td>
            <td class="mono">{run.branch || "—"}</td>
            <td>
              <span class="badge" style="background: {statusColor(run)}">
                {run.failed > 0 ? `${run.failed} failed` : "passed"}
              </span>
            </td>
            <td>{run.passed}/{run.total}</td>
            <td class="mono">{formatDuration(run.duration_ms)}</td>
            <td>{formatDate(run.created_at)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .page {
    max-width: 1100px;
    padding: 2rem 2rem;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1.5rem;
  }

  select {
    padding: 0.35rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font-size: 0.85rem;
  }

  .status {
    color: var(--text-secondary);
  }

  .status.error {
    color: var(--color-fail);
  }

  .empty {
    padding: 3rem 0;
    text-align: center;
    color: var(--text-secondary);
  }

  .hint {
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  th {
    text-align: left;
    padding: 0.5rem;
    border-bottom: 2px solid var(--border);
    font-size: 0.8rem;
    text-transform: uppercase;
    color: var(--text-secondary);
  }

  td {
    padding: 0.5rem;
    border-bottom: 1px solid var(--border-light);
  }

  .mono {
    font-family: monospace;
    font-size: 0.875rem;
  }

  a {
    color: var(--link);
    text-decoration: none;
  }

  a:hover {
    text-decoration: underline;
  }

  .badge {
    display: inline-block;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    color: white;
    font-size: 0.8rem;
    font-weight: 600;
  }
</style>
