<script lang="ts">
  import { onMount } from "svelte";

  interface FlakyTest {
    title: string;
    full_title: string;
    file_path: string;
    flip_count: number;
    last_status: string;
    appearances: number;
  }

  let tests = $state<FlakyTest[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      // Fetch recent runs with details to compute flakiness client-side for now
      const res = await fetch("http://localhost:3000/runs");
      if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
      const runs: any[] = await res.json();

      // Fetch details for each run
      const details = await Promise.all(
        runs.slice(0, 20).map(async (r: any) => {
          const res = await fetch(`http://localhost:3000/runs/${r.id}`);
          return res.json();
        })
      );

      // Track status history per test (by full_title)
      const history = new Map<string, { statuses: string[]; file_path: string; title: string; full_title: string }>();

      for (const run of details as any[]) {
        for (const spec of run.specs ?? []) {
          for (const test of spec.tests ?? []) {
            const key = test.full_title || test.title;
            const entry = history.get(key) ?? {
              statuses: [],
              file_path: spec.file_path,
              title: test.title,
              full_title: test.full_title,
            };
            entry.statuses.push(test.status);
            history.set(key, entry);
          }
        }
      }

      // Find flaky tests (status changed between runs)
      tests = Array.from(history.entries())
        .map(([_, entry]) => {
          let flips = 0;
          for (let i = 1; i < entry.statuses.length; i++) {
            if (entry.statuses[i] !== entry.statuses[i - 1]) flips++;
          }
          return {
            title: entry.title,
            full_title: entry.full_title,
            file_path: entry.file_path,
            flip_count: flips,
            last_status: entry.statuses[0] ?? "unknown",
            appearances: entry.statuses.length,
          };
        })
        .filter((t) => t.flip_count > 0)
        .sort((a, b) => b.flip_count - a.flip_count);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load data";
    } finally {
      loading = false;
    }
  });
</script>

<div class="page">
  <h1>Flaky Tests</h1>
  <p class="description">Tests that alternate between passing and failing across recent runs.</p>

  {#if loading}
    <p class="status">Loading...</p>
  {:else if error}
    <p class="status error">{error}</p>
  {:else if tests.length === 0}
    <div class="empty">
      <p>No flaky tests detected.</p>
      <p class="hint">Flaky tests appear after multiple runs when a test flips between pass and fail.</p>
    </div>
  {:else}
    <table>
      <thead>
        <tr>
          <th>Test</th>
          <th>Spec</th>
          <th>Flips</th>
          <th>Runs</th>
          <th>Last</th>
        </tr>
      </thead>
      <tbody>
        {#each tests as test}
          <tr>
            <td class="test-title">{test.title}</td>
            <td class="mono">{test.file_path}</td>
            <td class="flips">{test.flip_count}</td>
            <td>{test.appearances}</td>
            <td>
              <span class="status-badge {test.last_status}">{test.last_status}</span>
            </td>
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

  h1 {
    margin: 0;
    font-size: 1.5rem;
  }

  .description {
    margin: 0.25rem 0 1.5rem;
    color: var(--text-secondary);
    font-size: 0.875rem;
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

  .test-title {
    font-weight: 500;
  }

  .mono {
    font-family: monospace;
    font-size: 0.8rem;
    color: var(--text-secondary);
  }

  .flips {
    font-weight: 700;
    color: var(--color-skip);
  }

  .status-badge {
    display: inline-block;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 600;
    color: white;
  }

  .status-badge.passed { background: var(--color-pass); }
  .status-badge.failed { background: var(--color-fail); }
  .status-badge.skipped,
  .status-badge.pending { background: var(--color-skip); }
</style>
