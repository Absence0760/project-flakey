<script lang="ts">
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';

  const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

  let status = $state<'verifying' | 'success' | 'error'>('verifying');
  let error = $state('');

  onMount(async () => {
    const token = $page.params.token;
    try {
      const res = await fetch(`${API_URL}/auth/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        error = (body as { error?: string }).error ?? 'Verification failed';
        status = 'error';
        return;
      }

      status = 'success';
    } catch {
      error = 'Something went wrong. Please try again.';
      status = 'error';
    }
  });
</script>

<div class="verify-page">
  <div class="verify-card">
    <div class="logo">Flakey</div>

    {#if status === 'verifying'}
      <p class="message">Verifying your email...</p>
    {:else if status === 'success'}
      <p class="message success">Your email has been verified!</p>
      <button class="btn" onclick={() => goto('/login')}>Sign in</button>
    {:else}
      <p class="message error-msg">{error}</p>
      <button class="btn" onclick={() => goto('/login')}>Back to sign in</button>
    {/if}
  </div>
</div>

<style>
  .verify-page {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-secondary);
    padding: 1rem;
  }

  .verify-card {
    width: 100%;
    max-width: 380px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 2.5rem 2rem;
    text-align: center;
  }

  .logo {
    font-weight: 700;
    font-size: 1.5rem;
    color: var(--text);
    margin-bottom: 1.5rem;
  }

  .message {
    color: var(--text-secondary);
    font-size: 0.9rem;
    margin: 0 0 1.5rem;
  }

  .success {
    color: var(--color-pass);
  }

  .error-msg {
    color: var(--color-fail);
  }

  .btn {
    padding: 0.6rem 1.5rem;
    border: none;
    border-radius: 6px;
    background: var(--link);
    color: #fff;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
  }

  .btn:hover {
    opacity: 0.9;
  }
</style>
