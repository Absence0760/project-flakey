<script lang="ts">
  // SSO handoff landing. The backend callback has already set the httpOnly
  // session cookies and bounced the browser here. We read the session into the
  // SPA's localStorage auth model (so isLoggedIn() + Bearer authFetch work),
  // then continue to the originally-requested page.
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { setAuth, type User } from "$lib/stores/auth";
  import { API_URL } from "$lib/utils/config";

  let error = $state<string | null>(null);

  function safeReturn(raw: string | null): string {
    if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/dashboard";
    return raw;
  }

  onMount(async () => {
    const returnTo = safeReturn($page.url.searchParams.get("returnTo"));
    try {
      const res = await fetch(`${API_URL}/auth/sso/session`, { credentials: "include" });
      if (!res.ok) throw new Error("session");
      const data = (await res.json()) as { token: string; refreshToken: string | null; user: User };
      setAuth(data.user, data.token, data.refreshToken ?? undefined);
      goto(returnTo);
    } catch {
      error = "We couldn't complete your sign-in. Please try again.";
      setTimeout(() => goto("/login?sso_error=session_handoff_failed"), 1500);
    }
  });
</script>

<div class="sso-complete">
  {#if error}
    <p class="error">{error}</p>
  {:else}
    <p>Signing you in…</p>
  {/if}
</div>

<style>
  .sso-complete {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    font-size: 0.9rem;
  }
  .error {
    color: var(--error-text);
  }
</style>
