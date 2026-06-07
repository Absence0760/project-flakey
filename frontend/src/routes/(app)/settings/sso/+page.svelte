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
  let protocol = $state<"oidc" | "saml">("oidc");
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
  // SAML
  let samlEntryPoint = $state("");
  let samlIdpCert = $state("");
  let samlIssuer = $state("");
  let samlAudience = $state("");
  // SCIM provisioning
  let scimEnabled = $state(false);
  let scimTokenPrefix = $state<string | null>(null);
  let newScimToken = $state<string | null>(null); // shown once after issuance
  let scimBaseUrl = $state<string | null>(null);
  let scimBusy = $state(false);

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
        protocol = data.protocol ?? "oidc";
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
        samlEntryPoint = (data as Record<string, string>).samlEntryPoint ?? "";
        samlIdpCert = (data as Record<string, string>).samlIdpCert ?? "";
        samlIssuer = (data as Record<string, string>).samlIssuer ?? "";
        samlAudience = (data as Record<string, string>).samlAudience ?? "";
        scimEnabled = !!(data as Record<string, unknown>).scimEnabled;
        scimTokenPrefix = ((data as Record<string, string>).scimTokenPrefix as string) ?? null;
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
        protocol,
        enabled,
        enforced,
        jitProvisioning,
        allowedDomains: allowedDomainsText.split(",").map((s) => s.trim()).filter(Boolean),
        defaultRole,
        roleClaim: roleClaim.trim() || null,
        roleMap: parseRoleMap(roleMapText),
        oidcIssuer: oidcIssuer.trim() || null,
        oidcClientId: oidcClientId.trim() || null,
        samlEntryPoint: samlEntryPoint.trim() || null,
        samlIdpCert: samlIdpCert.trim() || null,
        samlIssuer: samlIssuer.trim() || null,
        samlAudience: samlAudience.trim() || null,
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

  async function issueScimToken() {
    scimBusy = true;
    try {
      const res = await authFetch(`${API_URL}/sso/scim/token`, { method: "POST" });
      if (!res.ok) { toastError("Failed to issue SCIM token"); return; }
      const data = await res.json();
      newScimToken = data.token;
      scimBaseUrl = data.scimBaseUrl;
      scimTokenPrefix = data.prefix;
      scimEnabled = true;
      toast("SCIM token issued — copy it now, it won't be shown again");
    } finally {
      scimBusy = false;
    }
  }

  async function disableScim() {
    scimBusy = true;
    try {
      const res = await authFetch(`${API_URL}/sso/scim/token`, { method: "DELETE" });
      if (!res.ok) { toastError("Failed to disable SCIM"); return; }
      scimEnabled = false;
      scimTokenPrefix = null;
      newScimToken = null;
      toast("SCIM provisioning disabled");
    } finally {
      scimBusy = false;
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
      Configure OpenID Connect or SAML login against your identity provider (Entra ID, Okta, Keycloak, …).
      SSO is additive — it's another way to sign in; it doesn't change what a session can do.
    </p>

    <form onsubmit={(e) => { e.preventDefault(); save(); }}>
      <label class="check"><input type="checkbox" bind:checked={enabled} /> Enable SSO for this organization</label>

      <label class="field">
        <span>Protocol</span>
        <select bind:value={protocol}>
          <option value="oidc">OpenID Connect (OIDC)</option>
          <option value="saml">SAML 2.0</option>
        </select>
      </label>

      {#if protocol === "oidc"}
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
      {:else}
        <label class="field">
          <span>IdP SSO URL (entry point)</span>
          <input type="url" bind:value={samlEntryPoint} placeholder="https://idp.example.com/saml/sso" />
        </label>
        <label class="field">
          <span>IdP signing certificate (PEM or base64 body)</span>
          <textarea bind:value={samlIdpCert} rows="4" placeholder="MIID...."></textarea>
        </label>
        <label class="field">
          <span>SP entity ID (issuer) — optional</span>
          <input type="text" bind:value={samlIssuer} placeholder="flakey-sp" />
        </label>
        <label class="field">
          <span>Expected audience — optional (defaults to SP entity ID)</span>
          <input type="text" bind:value={samlAudience} placeholder="flakey-sp" />
        </label>
      {/if}

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

    <section class="scim">
      <h2>SCIM provisioning</h2>
      <p class="muted">
        Let your identity provider create, update, and deactivate users automatically.
        A deactivation removes the user's org membership, revoking access on their next request.
      </p>
      {#if scimEnabled}
        <p class="muted">SCIM is <strong>enabled</strong>{#if scimTokenPrefix} (token <code>{scimTokenPrefix}…</code>){/if}.</p>
      {:else}
        <p class="muted">SCIM is not enabled.</p>
      {/if}

      {#if newScimToken}
        <div class="token-reveal" data-test="scim-token">
          <p><strong>Copy this token now — it won't be shown again.</strong></p>
          <code class="token">{newScimToken}</code>
          {#if scimBaseUrl}<p class="muted">SCIM base URL: <code>{scimBaseUrl}</code></p>{/if}
        </div>
      {/if}

      <div class="scim-actions">
        <button class="submit-btn" onclick={issueScimToken} disabled={scimBusy}>
          {scimEnabled ? "Rotate SCIM token" : "Enable SCIM & generate token"}
        </button>
        {#if scimEnabled}
          <button class="link-btn" onclick={disableScim} disabled={scimBusy}>Disable SCIM</button>
        {/if}
      </div>
    </section>
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
  .scim { margin-top: 2.5rem; padding-top: 1.5rem; border-top: 1px solid var(--border); }
  .scim h2 { font-size: 1.1rem; margin: 0 0 0.5rem; }
  .scim-actions { display: flex; align-items: center; gap: 1rem; margin-top: 1rem; }
  .token-reveal {
    margin: 1rem 0; padding: 0.85rem 1rem; border: 1px solid var(--link);
    border-radius: 6px; background: color-mix(in srgb, var(--link) 8%, transparent);
  }
  .token-reveal p { margin: 0 0 0.5rem; }
  .token { display: block; word-break: break-all; font-size: 0.8rem; background: var(--bg-secondary); padding: 0.5rem; border-radius: 4px; }
  .link-btn { background: none; border: none; color: var(--error-text); cursor: pointer; font-size: 0.85rem; padding: 0; }
  .link-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
