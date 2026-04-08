<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';

  const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

  let password = $state('');
  let confirmPassword = $state('');
  let error = $state<string | null>(null);
  let loading = $state(false);
  let success = $state(false);

  async function handleSubmit() {
    error = null;

    if (password.length < 8) {
      error = 'Password must be at least 8 characters';
      return;
    }

    if (password !== confirmPassword) {
      error = 'Passwords do not match';
      return;
    }

    loading = true;
    try {
      const res = await fetch(`${API_URL}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: $page.params.token, password }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        error = (body as { error?: string }).error ?? 'Reset failed';
        return;
      }

      success = true;
    } catch {
      error = 'Something went wrong. Please try again.';
    } finally {
      loading = false;
    }
  }
</script>

<div class="reset-page">
  <div class="reset-card">
    <div class="logo">Flakey</div>

    {#if success}
      <p class="message success">Your password has been reset.</p>
      <button class="btn" onclick={() => goto('/login')}>Sign in</button>
    {:else}
      <p class="subtitle">Choose a new password</p>

      <form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
        <label class="field">
          <span>New password</span>
          <input type="password" bind:value={password} placeholder="Min 8 characters" required />
        </label>

        <label class="field">
          <span>Confirm password</span>
          <input type="password" bind:value={confirmPassword} placeholder="Confirm password" required />
        </label>

        {#if error}
          <p class="error">{error}</p>
        {/if}

        <button type="submit" class="btn" disabled={loading}>
          {loading ? '...' : 'Reset password'}
        </button>
      </form>
    {/if}
  </div>
</div>

<style>
  .reset-page {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-secondary);
    padding: 1rem;
  }

  .reset-card {
    width: 100%;
    max-width: 380px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 2.5rem 2rem;
  }

  .logo {
    font-weight: 700;
    font-size: 1.5rem;
    color: var(--text);
    text-align: center;
    margin-bottom: 0.25rem;
  }

  .subtitle {
    text-align: center;
    color: var(--text-muted);
    font-size: 0.85rem;
    margin: 0 0 1.75rem;
  }

  .message {
    text-align: center;
    font-size: 0.9rem;
    margin: 0 0 1.5rem;
  }

  .success {
    color: var(--color-pass);
  }

  form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .field span {
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--text-secondary);
  }

  .field input {
    padding: 0.55rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font-size: 0.875rem;
    outline: none;
    transition: border-color 0.15s;
  }

  .field input:focus {
    border-color: var(--link);
  }

  .field input::placeholder {
    color: var(--text-muted);
  }

  .error {
    margin: 0;
    padding: 0.5rem 0.75rem;
    background: var(--error-bg);
    border: 1px solid var(--error-border);
    border-radius: 6px;
    color: var(--error-text);
    font-size: 0.8rem;
  }

  .btn {
    padding: 0.6rem;
    border: none;
    border-radius: 6px;
    background: var(--link);
    color: #fff;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.15s;
  }

  .btn:hover:not(:disabled) {
    opacity: 0.9;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
