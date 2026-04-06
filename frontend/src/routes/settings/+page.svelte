<script lang="ts">
  const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
</script>

<div class="page">
  <p class="description">Project-level configuration.</p>

  <section class="card">
    <h2>Notifications</h2>
    <p class="placeholder">Webhook and Slack notification settings coming soon.</p>
  </section>

  <section class="card">
    <h2>Data Retention</h2>
    <p class="placeholder">Configure how long test run data is retained.</p>
  </section>

  <section class="card">
    <h2>API</h2>
    <div class="field">
      <label>Endpoint</label>
      <code>{apiUrl}</code>
    </div>
  </section>
</div>

<style>
  .page {
    max-width: 1100px;
    padding: 2rem 2rem;
  }

  .description {
    margin: 0.25rem 0 2rem;
    color: var(--text-secondary);
    font-size: 0.875rem;
  }

  .card {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1.25rem;
    margin-bottom: 1rem;
  }

  .card h2 {
    margin: 0 0 0.75rem;
    font-size: 1rem;
  }

  .field {
    display: flex;
    gap: 1rem;
    font-size: 0.875rem;
    align-items: center;
  }

  .field label {
    color: var(--text-secondary);
    min-width: 5rem;
  }

  .field code {
    padding: 0.25rem 0.5rem;
    background: var(--bg-hover);
    border-radius: 4px;
    font-size: 0.8rem;
  }

  .placeholder {
    color: var(--text-muted);
    font-size: 0.875rem;
    margin: 0;
  }
</style>
