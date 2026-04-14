<script lang="ts">
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { isLoggedIn, acceptInvite } from "$lib/auth";

  let status = $state<"loading" | "success" | "error">("loading");
  let orgName = $state("");
  let errorMsg = $state("");

  const token = $derived($page.params.token);

  $effect(() => {
    if (!token) return;

    if (!isLoggedIn()) {
      goto(`/login?invite=${token}`);
      return;
    }

    acceptInvite(token)
      .then((result) => {
        orgName = result.org_name;
        status = "success";
      })
      .catch((err) => {
        errorMsg = err instanceof Error ? err.message : "Failed to accept invite";
        status = "error";
      });
  });
</script>

<div class="invite-page">
  <div class="invite-card">
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

    {#if status === "loading"}
      <p class="message">Accepting invite...</p>
    {:else if status === "success"}
      <p class="message success">You've joined <strong>{orgName}</strong>!</p>
      <button class="btn-primary" onclick={() => goto("/dashboard")}>Go to Dashboard</button>
    {:else}
      <p class="message error">{errorMsg}</p>
      <p class="hint">
        The invite may have expired or already been used.
        <br />Contact your admin for a new invite.
      </p>
      <button class="btn-primary" onclick={() => goto("/dashboard")}>Go to Dashboard</button>
    {/if}
  </div>
</div>

<style>
  .invite-page {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-secondary);
    padding: 1rem;
  }

  .invite-card {
    width: 100%;
    max-width: 400px;
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
    font-size: 1rem;
    color: var(--text);
    margin: 0 0 1.5rem;
  }

  .message.success {
    color: var(--color-pass);
  }

  .message.error {
    color: var(--error-text);
    padding: 0.5rem 0.75rem;
    background: var(--error-bg);
    border: 1px solid var(--error-border);
    border-radius: 6px;
  }

  .hint {
    font-size: 0.8rem;
    color: var(--text-muted);
    margin: 0 0 1.5rem;
    line-height: 1.5;
  }

  .btn-primary {
    padding: 0.6rem 1.25rem;
    border: none;
    border-radius: 6px;
    background: var(--link);
    color: #fff;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
  }

  .btn-primary:hover {
    opacity: 0.9;
  }
</style>
