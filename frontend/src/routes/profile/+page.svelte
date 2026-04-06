<script lang="ts">
</script>

<div class="page">
  <p class="description">Your account settings and preferences.</p>

  <section class="card">
    <h2>Account</h2>
    <div class="fields">
      <div class="field">
        <label>Email</label>
        <span>user@example.com</span>
      </div>
      <div class="field">
        <label>Role</label>
        <span>Admin</span>
      </div>
    </div>
  </section>

  <section class="card">
    <h2>Preferences</h2>
    <p class="placeholder">Notification and display preferences coming soon.</p>
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

  .fields {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .field {
    display: flex;
    gap: 1rem;
    font-size: 0.875rem;
  }

  .field label {
    color: var(--text-secondary);
    min-width: 4rem;
  }

  .placeholder {
    color: var(--text-muted);
    font-size: 0.875rem;
    margin: 0;
  }
</style>
