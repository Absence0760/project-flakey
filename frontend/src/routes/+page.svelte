<script lang="ts">
  import { onMount } from "svelte";
  import { fetchRuns, type Run } from "$lib/api";

  let runs = $state<Run[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      runs = await fetchRuns();
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
  <header>
    <h1>Flakey</h1>
    <p class="subtitle">Test Run Dashboard</p>
  </header>

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
    max-width: 960px;
    margin: 0 auto;
    padding: 2rem 1rem;
  }

  header {
    margin-bottom: 2rem;
  }

  h1 {
    margin: 0;
    font-size: 1.75rem;
  }

  .subtitle {
    margin: 0.25rem 0 0;
    color: #666;
  }

  .status {
    color: #666;
  }

  .status.error {
    color: var(--color-fail);
  }

  .empty {
    padding: 3rem 0;
    text-align: center;
    color: #666;
  }

  .hint {
    font-size: 0.875rem;
    color: #999;
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  th {
    text-align: left;
    padding: 0.5rem;
    border-bottom: 2px solid #e0e0e0;
    font-size: 0.8rem;
    text-transform: uppercase;
    color: #666;
  }

  td {
    padding: 0.5rem;
    border-bottom: 1px solid #eee;
  }

  .mono {
    font-family: monospace;
    font-size: 0.875rem;
  }

  a {
    color: #0066cc;
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
