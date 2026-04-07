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
    <div class="logo">Flakey</div>

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
