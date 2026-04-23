<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { API_URL } from '$lib/config';

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
    <div class="logo">
      <svg class="logo-icon" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="logo-bg" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#4F46E5"/>
            <stop offset="100%" stop-color="#7C3AED"/>
          </linearGradient>
        </defs>
        <rect x="16" y="16" width="480" height="480" rx="96" ry="96" fill="url(#logo-bg)"/>
        <rect x="136" y="144" width="240" height="280" rx="20" ry="20" fill="white" opacity="0.95"/>
        <rect x="196" y="112" width="120" height="56" rx="12" ry="12" fill="white" opacity="0.95"/>
        <rect x="220" y="100" width="72" height="36" rx="18" ry="18" fill="url(#logo-bg)"/>
        <polyline points="192,296 240,344 320,248" fill="none" stroke="url(#logo-bg)" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Better Testing
    </div>

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
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
  }

  .logo-icon {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
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
