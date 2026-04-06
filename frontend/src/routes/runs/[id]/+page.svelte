<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/stores";
  import { fetchRun, type RunDetail } from "$lib/api";

  let run = $state<RunDetail | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  onMount(async () => {
    const id = Number($page.params.id);
    try {
      run = await fetchRun(id);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load run";
    } finally {
      loading = false;
    }
  });

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function statusIcon(status: string): string {
    switch (status) {
      case "passed": return "PASS";
      case "failed": return "FAIL";
      case "skipped": return "SKIP";
      case "pending": return "PEND";
      default: return "?";
    }
  }
</script>

<div class="page">
  <a href="/" class="back">Back to runs</a>

  {#if loading}
    <p class="status">Loading...</p>
  {:else if error}
    <p class="status error">{error}</p>
  {:else if run}
    <header>
      <h1>Run #{run.id}</h1>
      <div class="meta">
        <span><strong>Suite:</strong> {run.suite_name}</span>
        <span><strong>Branch:</strong> {run.branch || "—"}</span>
        <span><strong>Duration:</strong> {formatDuration(run.duration_ms)}</span>
      </div>
      <div class="stats">
        <span class="stat pass">{run.passed} passed</span>
        <span class="stat fail">{run.failed} failed</span>
        <span class="stat skip">{run.skipped} skipped</span>
        <span class="stat total">{run.total} total</span>
      </div>
    </header>

    {#each run.specs as spec}
      <section class="spec">
        <h2>{spec.file_path || spec.title}</h2>
        <ul class="tests">
          {#each spec.tests as test}
            <li class="test {test.status}">
              <span class="test-status">{statusIcon(test.status)}</span>
              <span class="test-title">{test.title}</span>
              <span class="test-duration">{formatDuration(test.duration_ms)}</span>
              {#if test.error_message}
                <pre class="test-error">{test.error_message}</pre>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/each}
  {/if}
</div>

<style>
  .page {
    max-width: 960px;
    margin: 0 auto;
    padding: 2rem 1rem;
  }

  .back {
    color: #0066cc;
    text-decoration: none;
    font-size: 0.875rem;
  }

  .back:hover {
    text-decoration: underline;
  }

  header {
    margin: 1rem 0 2rem;
  }

  h1 {
    margin: 0 0 0.5rem;
  }

  .meta {
    display: flex;
    gap: 1.5rem;
    color: #666;
    font-size: 0.875rem;
    margin-bottom: 0.75rem;
  }

  .stats {
    display: flex;
    gap: 1rem;
  }

  .stat {
    padding: 0.25rem 0.75rem;
    border-radius: 4px;
    font-size: 0.8rem;
    font-weight: 600;
  }

  .stat.pass { background: var(--color-pass); color: white; }
  .stat.fail { background: var(--color-fail); color: white; }
  .stat.skip { background: var(--color-skip); color: white; }
  .stat.total { background: #666; color: white; }

  .spec {
    margin-bottom: 2rem;
  }

  .spec h2 {
    font-size: 1rem;
    font-family: monospace;
    color: #333;
    border-bottom: 1px solid #eee;
    padding-bottom: 0.5rem;
  }

  .tests {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .test {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.4rem 0;
    border-bottom: 1px solid #f5f5f5;
  }

  .test-status {
    font-family: monospace;
    font-size: 0.75rem;
    font-weight: 700;
    width: 3rem;
  }

  .test.passed .test-status { color: var(--color-pass); }
  .test.failed .test-status { color: var(--color-fail); }
  .test.skipped .test-status,
  .test.pending .test-status { color: var(--color-skip); }

  .test-title {
    flex: 1;
  }

  .test-duration {
    font-family: monospace;
    font-size: 0.8rem;
    color: #999;
  }

  .test-error {
    width: 100%;
    margin: 0.5rem 0 0 3.5rem;
    padding: 0.75rem;
    background: #fff5f5;
    border: 1px solid #ffdddd;
    border-radius: 4px;
    font-size: 0.8rem;
    color: #c00;
    white-space: pre-wrap;
    overflow-x: auto;
  }

  .status { color: #666; }
  .status.error { color: var(--color-fail); }
</style>
