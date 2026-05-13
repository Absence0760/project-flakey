<script lang="ts">
  import { onMount } from "svelte";
  import { login, register } from "$lib/auth";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { API_URL } from "$lib/config";

  let mode = $state<"login" | "register" | "forgot">("login");
  let email = $state("");
  let password = $state("");
  let name = $state("");
  let error = $state<string | null>(null);
  let loading = $state(false);
  let verificationSent = $state(false);
  let resetSent = $state(false);
  let resendingVerification = $state(false);
  // null while still fetching; true/false once the backend responds.
  // null treats as "open" for graceful degradation if the endpoint
  // is unreachable.
  let registrationOpen = $state<boolean | null>(null);

  onMount(async () => {
    try {
      const res = await fetch(`${API_URL}/auth/registration-status`);
      if (res.ok) {
        const body = (await res.json()) as { open?: boolean };
        registrationOpen = body.open === true;
      }
    } catch {
      // Leave null; the form still works, just without the banner.
    }
  });

  const inviteToken = $derived($page.url.searchParams.get("invite"));
  const initialMode = $derived($page.url.searchParams.get("mode"));

  // Default to register mode when:
  //   - the URL carries an invite token (existing behaviour), OR
  //   - `?mode=register` is explicit (landing-page CTA, README link).
  // Default to forgot mode when `?mode=forgot`. Anything else leaves
  // the form on login.
  $effect(() => {
    if (inviteToken) mode = "register";
    else if (initialMode === "register") mode = "register";
    else if (initialMode === "forgot") mode = "forgot";
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
      Flakey
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
    {:else if mode === "register" && registrationOpen === false}
      <!--
        Closed-registration mode + register mode + no magic-link token.
        Two real paths still work from here:
          1. The user's email matches a pending org_invites row — the
             backend's POST /auth/register will accept the submit even
             without an invite_token because resolveOrg() looks up
             invites by email.
          2. The user has a magic-link URL like /login?invite=<token>
             and just navigated here without it — they should re-open
             that URL.
        The banner explains both without blocking the form.
      -->
      <div class="info-banner invite-only-banner" data-test="invite-only-banner">
        <p>
          <strong>This instance is invite-only.</strong> If your email has been invited, fill out the form below — we'll find the pending invite by email and join you to that org. Otherwise, ask an admin for an invite link.
        </p>
        <button class="link-btn" onclick={() => { mode = "login"; }}>Back to sign in</button>
      </div>
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

  /* Closed-registration banner uses the warning palette (yellow-ish)
     to distinguish from the info-blue used for verification + reset.
     Same shape, different colour means it reads as "heads up" rather
     than "you've done a thing successfully". */
  .invite-only-banner {
    margin: 0 0 1rem;
    background: color-mix(in srgb, var(--color-skip) 10%, transparent);
    border-color: color-mix(in srgb, var(--color-skip) 50%, transparent);
    text-align: left;
  }

  .invite-only-banner p {
    margin: 0 0 0.5rem;
    line-height: 1.5;
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
