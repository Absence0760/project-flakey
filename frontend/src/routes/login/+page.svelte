<script lang="ts">
  import { login, register } from "$lib/auth";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";

  let mode = $state<"login" | "register">("login");
  let email = $state("");
  let password = $state("");
  let name = $state("");
  let error = $state<string | null>(null);
  let loading = $state(false);

  const inviteToken = $derived($page.url.searchParams.get("invite"));

  // If arriving with an invite token, default to register mode
  $effect(() => {
    if (inviteToken) mode = "register";
  });

  async function handleSubmit() {
    error = null;
    loading = true;
    try {
      if (mode === "login") {
        await login(email, password);
      } else {
        await register(email, password, name, inviteToken ?? undefined);
      }
      // Registration with an invite auto-accepts it via resolveOrg,
      // so always go straight to dashboard
      goto("/dashboard");
    } catch (e) {
      error = e instanceof Error ? e.message : "Something went wrong";
    } finally {
      loading = false;
    }
  }
</script>

<div class="login-page">
  <div class="login-card">
    <div class="logo">Flakey</div>
    <p class="subtitle">{mode === "login" ? "Sign in to your account" : "Create a new account"}</p>

    {#if inviteToken}
      <p class="invite-banner">You've been invited to join an organization. {mode === "login" ? "Sign in" : "Create an account"} to accept.</p>
    {/if}

    <form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
      {#if mode === "register"}
        <label class="field">
          <span>Name</span>
          <input type="text" bind:value={name} placeholder="Your name" />
        </label>
      {/if}

      <label class="field">
        <span>Email</span>
        <input type="email" bind:value={email} placeholder="you@example.com" required />
      </label>

      <label class="field">
        <span>Password</span>
        <input type="password" bind:value={password} placeholder={mode === "register" ? "Min 6 characters" : "Password"} required />
      </label>

      {#if error}
        <p class="error">{error}</p>
      {/if}

      <button type="submit" class="submit-btn" disabled={loading}>
        {loading ? "..." : mode === "login" ? "Sign in" : "Create account"}
      </button>
    </form>

    <p class="switch">
      {#if mode === "login"}
        Don't have an account? <button onclick={() => { mode = "register"; error = null; }}>Register</button>
      {:else}
        Already have an account? <button onclick={() => { mode = "login"; error = null; }}>Sign in</button>
      {/if}
    </p>
  </div>
</div>

<style>
  .login-page {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-secondary);
    padding: 1rem;
  }

  .login-card {
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

  .submit-btn {
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

  .submit-btn:hover:not(:disabled) {
    opacity: 0.9;
  }

  .submit-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .switch {
    text-align: center;
    margin: 1.25rem 0 0;
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  .switch button {
    background: none;
    border: none;
    color: var(--link);
    cursor: pointer;
    font-size: 0.8rem;
    padding: 0;
    font-weight: 500;
  }

  .switch button:hover {
    text-decoration: underline;
  }

  .invite-banner {
    margin: 0 0 1rem;
    padding: 0.5rem 0.75rem;
    background: color-mix(in srgb, var(--link) 8%, transparent);
    border: 1px solid var(--link);
    border-radius: 6px;
    font-size: 0.8rem;
    color: var(--text);
    text-align: center;
  }
</style>
