<script lang="ts">
  // Admin SSO configuration (owner/admin only). Backed by GET/PUT /sso/config.
  // The client secret is write-only — the API never returns it, only whether
  // one is stored (hasClientSecret).
  import { onMount } from "svelte";
  import { authFetch, getAuth } from "$lib/stores/auth";
  import { API_URL } from "$lib/utils/config";
  import { toast, toastError } from "$lib/stores/toast";

  interface SsoConfig {
    configured: boolean;
    protocol: "oidc" | "saml";
    enabled: boolean;
    enforced: boolean;
    jitProvisioning: boolean;
    allowedDomains: string[];
    defaultRole: "owner" | "admin" | "viewer";
    roleClaim: string | null;
    roleMap: Record<string, string>;
    oidcIssuer: string | null;
    oidcClientId: string | null;
    hasClientSecret: boolean;
  }

  const auth = getAuth();
  const isAdmin = auth.user?.orgRole === "owner" || auth.user?.orgRole === "admin";

  let loading = $state(true);
  let saving = $state(false);
  let disabled = $state(false); // true when the instance has SSO turned off

  // Form model.
  let enabled = $state(false);
  let enforced = $state(false);
  let jitProvisioning = $state(false);
  let allowedDomainsText = $state("");
  let defaultRole = $state<"owner" | "admin" | "viewer">("viewer");
  let oidcIssuer = $state("");
  let oidcClientId = $state("");
  let oidcClientSecret = $state(""); // blank = leave stored secret untouched
  let hasClientSecret = $state(false);
  let roleClaim = $state("");
  let roleMapText = $state(""); // "idp-value=flakey-role" lines

  let ready = $state(false);

  function parseRoleMap(text: string): Record<string, string> {
    const map: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const [k, v] = line.split("=").map((s) => s.trim());
      if (k && v) map[k] = v;
    }
    return map;
  }
  function roleMapToText(map: Record<string, string>): string {
    return Object.entries(map).map(([k, v]) => `${k}=${v}`).join("\n");
  }

  async function load() {
    loading = true;
    try {
      const res = await authFetch(`${API_URL}/sso/config`);
      if (res.status === 404) { disabled = true; return; }
      if (!res.ok) { toastError("Failed to load SSO config"); return; }
      const data = (await res.json()) as Partial<SsoConfig>;
      if (data.configured) {
        enabled = !!data.enabled;
        enforced = !!data.enforced;
        jitProvisioning = !!data.jitProvisioning;
        allowedDomainsText = (data.allowedDomains ?? []).join(", ");
        defaultRole = data.defaultRole ?? "viewer";
        oidcIssuer = data.oidcIssuer ?? "";
        oidcClientId = data.oidcClientId ?? "";
        hasClientSecret = !!data.hasClientSecret;
        roleClaim = data.roleClaim ?? "";
        roleMapText = roleMapToText(data.roleMap ?? {});
      }
    } finally {
      loading = false;
      ready = true;
    }
  }

  async function save() {
    saving = true;
    try {
      const payload: Record<string, unknown> = {
        protocol: "oidc",
        enabled,
        enforced,
        jitProvisioning,
        allowedDomains: allowedDomainsText.split(",").map((s) => s.trim()).filter(Boolean),
        defaultRole,
        roleClaim: roleClaim.trim() || null,
        roleMap: parseRoleMap(roleMapText),
        oidcIssuer: oidcIssuer.trim() || null,
        oidcClientId: oidcClientId.trim() || null,
      };
      // Only send the secret when the admin typed a new one.
      if (oidcClientSecret.trim()) payload.oidcClientSecret = oidcClientSecret.trim();

      const res = await authFetch(`${API_URL}/sso/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toastError((body as { error?: string }).error ?? "Save failed");
        return;
      }
      oidcClientSecret = "";
      const data = await res.json();
      hasClientSecret = !!data.hasClientSecret;
      toast("SSO configuration saved");
    } finally {
      saving = false;
    }
  }

  onMount(load);
</script>

<div class="sso-settings" data-ready={ready}>
  <h1>Single sign-on</h1>

  {#if disabled}
    <p class="muted">SSO is not enabled on this Flakey instance. An operator must set <code>FLAKEY_SSO_ENABLED=true</code> on the backend.</p>
  {:else if !isAdmin}
    <p class="muted">Only organization owners and admins can manage SSO.</p>
  {:else if loading}
    <p class="muted">Loading…</p>
  {:else}
    <p class="muted">
      Configure OpenID Connect login against your identity provider (Entra ID, Okta, Keycloak, …).
      SSO is additive — it's another way to sign in; it doesn't change what a session can do.
    </p>

    <form onsubmit={(e) => { e.preventDefault(); save(); }}>
      <label class="check"><input type="checkbox" bind:checked={enabled} /> Enable SSO for this organization</label>

      <label class="field">
        <span>OIDC issuer URL</span>
        <input type="url" bind:value={oidcIssuer} placeholder="https://idp.example.com/realms/acme" />
      </label>
      <label class="field">
        <span>Client ID</span>
        <input type="text" bind:value={oidcClientId} placeholder="flakey-web" />
      </label>
      <label class="field">
        <span>Client secret {#if hasClientSecret}<em>(stored — leave blank to keep)</em>{/if}</span>
        <input type="password" bind:value={oidcClientSecret} placeholder={hasClientSecret ? "••••••••" : "Paste secret"} autocomplete="new-password" />
      </label>

      <label class="check"><input type="checkbox" bind:checked={jitProvisioning} /> Auto-provision new users on first sign-in (JIT)</label>

      <label class="field">
        <span>Allowed email domains (comma-separated, blank = any)</span>
        <input type="text" bind:value={allowedDomainsText} placeholder="example.com, example.org" />
      </label>

      <label class="field">
        <span>Default role for provisioned users</span>
        <select bind:value={defaultRole}>
          <option value="viewer">viewer</option>
          <option value="admin">admin</option>
          <option value="owner">owner</option>
        </select>
      </label>

      <label class="field">
        <span>Role claim (token claim carrying IdP roles, e.g. flakey_roles)</span>
        <input type="text" bind:value={roleClaim} placeholder="flakey_roles" />
      </label>
      <label class="field">
        <span>Role map (one <code>idp-value=flakey-role</code> per line)</span>
        <textarea bind:value={roleMapText} rows="3" placeholder={"flakey-admin=admin\nflakey-viewer=viewer"}></textarea>
      </label>

      <label class="check" title="Enforcement in /auth/login is deferred pending security review; this records the org's intent.">
        <input type="checkbox" bind:checked={enforced} /> Require SSO (disable password login) — <em>not yet enforced</em>
      </label>

      <button type="submit" class="submit-btn" disabled={saving}>{saving ? "Saving…" : "Save SSO configuration"}</button>
    </form>
  {/if}
</div>

<style>
  .sso-settings { max-width: 640px; padding: 1.5rem; }
  h1 { font-size: 1.35rem; margin: 0 0 0.5rem; }
  .muted { color: var(--text-muted); font-size: 0.9rem; line-height: 1.5; }
  form { display: flex; flex-direction: column; gap: 1rem; margin-top: 1.25rem; }
  .field { display: flex; flex-direction: column; gap: 0.3rem; }
  .field span { font-size: 0.8rem; font-weight: 500; color: var(--text-secondary); }
  .field em { color: var(--text-muted); font-weight: 400; font-style: italic; }
  .field input, .field select, .field textarea {
    padding: 0.5rem 0.7rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--text); font-size: 0.875rem; font-family: inherit;
  }
  .check { display: flex; align-items: center; gap: 0.5rem; font-size: 0.875rem; color: var(--text); }
  .submit-btn {
    align-self: flex-start; padding: 0.55rem 1rem; border: none; border-radius: 6px;
    background: var(--link); color: #fff; font-weight: 600; cursor: pointer;
  }
  .submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
