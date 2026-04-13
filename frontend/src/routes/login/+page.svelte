<script lang="ts">
  import { login, register } from "$lib/auth";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";

  const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

  let mode = $state<"login" | "register" | "forgot">("login");
  let email = $state("");
  let password = $state("");
  let name = $state("");
  let error = $state<string | null>(null);
  let loading = $state(false);
  let verificationSent = $state(false);
  let resetSent = $state(false);
  let resendingVerification = $state(false);

  const inviteToken = $derived($page.url.searchParams.get("invite"));

  // If arriving with an invite token, default to register mode
  $effect(() => {
    if (inviteToken) mode = "register";
  });

  async function handleSubmit() {
    error = null;
    loading = true;
    try {
      if (mode === "forgot") {
        await fetch(`${API_URL}/auth/forgot-password`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
        resetSent = true;
      } else if (mode === "login") {
        await login(email, password);
        goto("/dashboard");
      } else {
        const result = await register(email, password, name, inviteToken ?? undefined);
        // Check if email verification is required (user won't be auto-logged in on next attempt)
        verificationSent = true;
        goto("/dashboard");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Something went wrong";
      if (msg.includes("EMAIL_NOT_VERIFIED") || msg.includes("verify your email")) {
        error = null;
        verificationSent = true;
      } else {
        error = msg;
      }
    } finally {
      loading = false;
    }
  }

  async function resendVerification() {
    resendingVerification = true;
    try {
      await fetch(`${API_URL}/auth/resend-verification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
    } catch { /* ignore */ }
    resendingVerification = false;
  }
</script>

<div class="login-page">
  <div class="login-card">
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
    <p class="subtitle">
      {#if mode === "forgot"}
        Reset your password
      {:else if mode === "register"}
        Create a new account
      {:else}
        Sign in to your account
      {/if}
    </p>

    {#if inviteToken}
      <p class="invite-banner">You've been invited to join an organization. {mode === "login" ? "Sign in" : "Create an account"} to accept.</p>
    {/if}

    {#if verificationSent}
      <div class="info-banner">
        <p>Check your email for a verification link.</p>
        <button class="resend-btn" onclick={resendVerification} disabled={resendingVerification}>
          {resendingVerification ? "Sending..." : "Resend verification email"}
        </button>
      </div>
    {:else if resetSent}
      <div class="info-banner">
        <p>If an account exists with that email, we've sent a password reset link.</p>
        <button class="link-btn" onclick={() => { mode = "login"; resetSent = false; error = null; }}>Back to sign in</button>
      </div>
    {:else}
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

        {#if mode !== "forgot"}
          <label class="field">
            <span>Password</span>
            <input type="password" bind:value={password} placeholder={mode === "register" ? "Min 8 characters" : "Password"} required />
          </label>
        {/if}

        {#if mode === "login"}
          <button type="button" class="forgot-btn" onclick={() => { mode = "forgot"; error = null; }}>Forgot password?</button>
        {/if}

        {#if error}
          <p class="error">{error}</p>
        {/if}

        <button type="submit" class="submit-btn" disabled={loading}>
          {#if loading}
            ...
          {:else if mode === "forgot"}
            Send reset link
          {:else if mode === "register"}
            Create account
          {:else}
            Sign in
          {/if}
        </button>
      </form>

      <p class="switch">
        {#if mode === "forgot"}
          Remember your password? <button onclick={() => { mode = "login"; error = null; }}>Sign in</button>
        {:else if mode === "login"}
          Don't have an account? <button onclick={() => { mode = "register"; error = null; }}>Register</button>
        {:else}
          Already have an account? <button onclick={() => { mode = "login"; error = null; }}>Sign in</button>
        {/if}
      </p>
    {/if}
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

  .info-banner {
    text-align: center;
    padding: 1rem 0.75rem;
    background: color-mix(in srgb, var(--link) 8%, transparent);
    border: 1px solid var(--link);
    border-radius: 6px;
    font-size: 0.85rem;
    color: var(--text);
  }

  .info-banner p {
    margin: 0 0 0.75rem;
  }

  .resend-btn, .link-btn {
    background: none;
    border: none;
    color: var(--link);
    cursor: pointer;
    font-size: 0.8rem;
    font-weight: 500;
    padding: 0;
  }

  .resend-btn:hover, .link-btn:hover {
    text-decoration: underline;
  }

  .resend-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .forgot-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.75rem;
    padding: 0;
    text-align: right;
    margin-top: -0.5rem;
  }

  .forgot-btn:hover {
    color: var(--link);
  }
</style>
