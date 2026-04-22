<script lang="ts">
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { API_URL } from '$lib/config';

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
