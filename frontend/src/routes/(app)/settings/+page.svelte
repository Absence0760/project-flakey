<script lang="ts">
  import { onMount } from "svelte";
  import { getAuth } from "$lib/auth";
  import { authFetch } from "$lib/auth";

  const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
  const auth = getAuth();
  const orgId = auth.user?.orgId;

  function headers() {
    return { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` };
  }

  // --- Team ---
  interface Member { id: number; email: string; name: string; role: string; joined_at: string; }
  let members = $state<Member[]>([]);
  let membersLoading = $state(true);
  let inviteEmail = $state("");
  let inviteRole = $state<"admin" | "viewer">("viewer");
  let inviteResult = $state<{ invite_token: string } | null>(null);
  let inviteError = $state<string | null>(null);
  let copied = $state(false);

  function inviteUrl(token: string): string {
    return `${window.location.origin}/invite/${token}`;
  }

  async function copyInviteLink() {
    if (!inviteResult) return;
    await navigator.clipboard.writeText(inviteUrl(inviteResult.invite_token));
    copied = true;
    setTimeout(() => copied = false, 2000);
  }

  async function loadMembers() {
    membersLoading = true;
    const res = await authFetch(`${apiUrl}/orgs/${orgId}/members`);
    if (res.ok) members = await res.json();
    membersLoading = false;
  }

  async function invite() {
    inviteError = null; inviteResult = null;
    if (!inviteEmail) { inviteError = "Email is required"; return; }
    const res = await authFetch(`${apiUrl}/orgs/${orgId}/invites`, { method: "POST", headers: headers(), body: JSON.stringify({ email: inviteEmail, role: inviteRole }) });
    if (res.ok) { inviteResult = await res.json(); inviteEmail = ""; }
    else { const b = await res.json().catch(() => ({})); inviteError = (b as any).error ?? "Failed"; }
  }

  async function changeRole(userId: number, role: string) {
    await authFetch(`${apiUrl}/orgs/${orgId}/members/${userId}`, { method: "PATCH", headers: headers(), body: JSON.stringify({ role }) });
    loadMembers();
  }

  async function removeMember(userId: number) {
    await authFetch(`${apiUrl}/orgs/${orgId}/members/${userId}`, { method: "DELETE", headers: { Authorization: `Bearer ${auth.token}` } });
    loadMembers();
  }

  // --- Suites ---
  interface Suite { suite_name: string; run_count: number; last_run: string; archived: boolean; }
  let suites = $state<Suite[]>([]);
  let suitesLoading = $state(true);
  let renamingId = $state<string | null>(null);
  let renameValue = $state("");

  async function loadSuites() {
    suitesLoading = true;
    const res = await authFetch(`${apiUrl}/suites`);
    if (res.ok) suites = await res.json();
    suitesLoading = false;
  }

  async function renameSuite(oldName: string) {
    if (!renameValue || renameValue === oldName) { renamingId = null; return; }
    await authFetch(`${apiUrl}/suites/${encodeURIComponent(oldName)}/rename`, { method: "PATCH", headers: headers(), body: JSON.stringify({ new_name: renameValue }) });
    renamingId = null;
    loadSuites();
  }

  async function toggleArchive(name: string, archived: boolean) {
    await authFetch(`${apiUrl}/suites/${encodeURIComponent(name)}/archive`, { method: "PATCH", headers: headers(), body: JSON.stringify({ archived: !archived }) });
    loadSuites();
  }

  async function deleteSuite(name: string) {
    if (!confirm(`Delete suite "${name}" and all its runs? This cannot be undone.`)) return;
    await authFetch(`${apiUrl}/suites/${encodeURIComponent(name)}`, { method: "DELETE", headers: { Authorization: `Bearer ${auth.token}` } });
    loadSuites();
  }

  // --- Webhooks ---
  interface Webhook { id: number; name: string; url: string; events: string[]; active: boolean; platform: string; }
  let webhooks = $state<Webhook[]>([]);
  let webhooksLoading = $state(true);
  let newWhName = $state("");
  let newWhUrl = $state("");
  let newWhEvents = $state<string[]>(["run.failed"]);
  let newWhPlatform = $state("generic");
  let testResult = $state<{ id: number; ok: boolean } | null>(null);

  function detectPlatform(url: string): string {
    if (url.includes("hooks.slack.com")) return "slack";
    if (url.includes("webhook.office.com") || url.includes("logic.azure.com")) return "teams";
    if (url.includes("discord.com/api/webhooks")) return "discord";
    return "generic";
  }

  async function loadWebhooks() {
    webhooksLoading = true;
    const res = await authFetch(`${apiUrl}/webhooks`);
    if (res.ok) webhooks = await res.json();
    webhooksLoading = false;
  }

  async function createWebhook() {
    if (!newWhUrl) return;
    await authFetch(`${apiUrl}/webhooks`, { method: "POST", headers: headers(), body: JSON.stringify({ name: newWhName, url: newWhUrl, events: newWhEvents, platform: newWhPlatform }) });
    newWhName = ""; newWhUrl = ""; newWhEvents = ["run.failed"]; newWhPlatform = "generic";
    loadWebhooks();
  }

  async function toggleWebhook(id: number, active: boolean) {
    await authFetch(`${apiUrl}/webhooks/${id}`, { method: "PATCH", headers: headers(), body: JSON.stringify({ active: !active }) });
    loadWebhooks();
  }

  async function deleteWebhook(id: number) {
    await authFetch(`${apiUrl}/webhooks/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${auth.token}` } });
    loadWebhooks();
  }

  async function testWebhook(id: number) {
    testResult = null;
    const res = await authFetch(`${apiUrl}/webhooks/${id}/test`, { method: "POST", headers: { Authorization: `Bearer ${auth.token}` } });
    const data = await res.json();
    testResult = { id, ok: data.ok };
    setTimeout(() => { if (testResult?.id === id) testResult = null; }, 3000);
  }

  // --- GitHub Integration ---
  let githubRepo = $state("");
  let githubToken = $state("");
  let hasGithubToken = $state(false);
  let githubSaved = $state(false);
  let githubError = $state<string | null>(null);

  async function loadGithub() {
    const res = await authFetch(`${apiUrl}/orgs/${orgId}/settings`);
    if (res.ok) {
      const data = await res.json();
      githubRepo = data.github_repo ?? "";
      hasGithubToken = data.has_github_token ?? false;
    }
  }

  async function saveGithub() {
    githubError = null;
    if (githubRepo && !/^[^/]+\/[^/]+$/.test(githubRepo)) {
      githubError = "Format: owner/repo";
      return;
    }
    const body: Record<string, string | null> = { github_repo: githubRepo || null };
    if (githubToken) body.github_token = githubToken;
    const res = await authFetch(`${apiUrl}/orgs/${orgId}/settings`, { method: "PATCH", headers: headers(), body: JSON.stringify(body) });
    if (res.ok) {
      githubSaved = true;
      githubToken = "";
      hasGithubToken = !!body.github_token || hasGithubToken;
      setTimeout(() => githubSaved = false, 2000);
    }
  }

  async function removeGithub() {
    await authFetch(`${apiUrl}/orgs/${orgId}/settings`, { method: "PATCH", headers: headers(), body: JSON.stringify({ github_token: null, github_repo: null }) });
    githubRepo = "";
    githubToken = "";
    hasGithubToken = false;
  }

  // --- Retention ---
  let retentionDays = $state<string>("");
  let retentionSaved = $state(false);

  async function loadRetention() {
    const res = await authFetch(`${apiUrl}/orgs/${orgId}/settings`);
    if (res.ok) {
      const data = await res.json();
      retentionDays = data.retention_days != null ? String(data.retention_days) : "";
    }
  }

  async function saveRetention() {
    const value = retentionDays === "" ? null : Number(retentionDays);
    await authFetch(`${apiUrl}/orgs/${orgId}/settings`, { method: "PATCH", headers: headers(), body: JSON.stringify({ retention_days: value }) });
    retentionSaved = true;
    setTimeout(() => retentionSaved = false, 2000);
  }

  // --- Audit ---
  interface AuditEntry { id: number; action: string; target_type: string; target_id: string; detail: any; created_at: string; user_email: string; user_name: string; }
  let auditLog = $state<AuditEntry[]>([]);
  let auditLoading = $state(true);

  async function loadAudit() {
    auditLoading = true;
    const res = await authFetch(`${apiUrl}/audit?limit=30`);
    if (res.ok) auditLog = await res.json();
    auditLoading = false;
  }

  // --- Helpers ---
  let isOwner = $derived(auth.user?.orgRole === "owner");
  let isAdmin = $derived(auth.user?.orgRole === "admin" || isOwner);

  function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  function formatAction(a: string): string {
    return a.replace(".", " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  onMount(() => {
    loadMembers();
    loadSuites();
    loadRetention();
    if (isAdmin) { loadWebhooks(); loadGithub(); loadAudit(); }
  });
</script>

<div class="page">
  <!-- Team -->
  <section class="card">
    <h2>Team</h2>
    <p class="card-desc">{members.length} member{members.length !== 1 ? "s" : ""}</p>

    {#if isAdmin}
      <div class="row-form">
        <input type="email" bind:value={inviteEmail} placeholder="Email address" />
        <select bind:value={inviteRole}>
          <option value="viewer">Viewer</option>
          <option value="admin">Admin</option>
        </select>
        <button class="btn-primary" onclick={invite}>Invite</button>
      </div>
      {#if inviteError}<p class="form-error">{inviteError}</p>{/if}
      {#if inviteResult}
        <div class="success-banner">
          <p>Invite created! Share this link with the user:</p>
          <div class="invite-link-row">
            <code class="invite-link">{inviteUrl(inviteResult.invite_token)}</code>
            <button class="btn-sm" onclick={copyInviteLink}>{copied ? "Copied!" : "Copy"}</button>
            <button class="btn-sm" onclick={() => { inviteResult = null; copied = false; }}>Dismiss</button>
          </div>
        </div>
      {/if}
    {/if}

    {#if membersLoading}
      <p class="muted">Loading...</p>
    {:else}
      <div class="list">
        {#each members as m}
          <div class="list-row">
            <div class="avatar">{m.name?.charAt(0)?.toUpperCase() || m.email.charAt(0).toUpperCase()}</div>
            <div class="list-info">
              <span class="list-primary">{m.name || m.email}</span>
              <span class="list-secondary">{m.email}</span>
            </div>
            <span class="list-meta">{timeAgo(m.joined_at)}</span>
            {#if m.role === "owner"}
              <span class="pill owner">Owner</span>
            {:else if isOwner && m.id !== auth.user?.id}
              <select class="inline-select" value={m.role} onchange={(e) => changeRole(m.id, (e.target as HTMLSelectElement).value)}>
                <option value="admin">Admin</option>
                <option value="viewer">Viewer</option>
              </select>
              <button class="btn-icon danger" onclick={() => removeMember(m.id)} title="Remove">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3l10 10M13 3L3 13"/></svg>
              </button>
            {:else}
              <span class="pill {m.role}">{m.role}</span>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <!-- Suites -->
  {#if isAdmin}
    <section class="card">
      <h2>Suites</h2>
      <p class="card-desc">Manage, rename, archive, or delete test suites.</p>

      {#if suitesLoading}
        <p class="muted">Loading...</p>
      {:else if suites.length === 0}
        <p class="muted">No suites yet.</p>
      {:else}
        <div class="list">
          {#each suites as s}
            <div class="list-row" class:archived={s.archived}>
              <div class="list-info">
                {#if renamingId === s.suite_name}
                  <form class="inline-rename" onsubmit={(e) => { e.preventDefault(); renameSuite(s.suite_name); }}>
                    <input type="text" bind:value={renameValue} />
                    <button type="submit" class="btn-sm">Save</button>
                    <button type="button" class="btn-sm" onclick={() => renamingId = null}>Cancel</button>
                  </form>
                {:else}
                  <span class="list-primary">{s.suite_name}</span>
                  <span class="list-secondary">{s.run_count} run{s.run_count !== 1 ? "s" : ""} · last {timeAgo(s.last_run)}</span>
                {/if}
              </div>
              {#if s.archived}<span class="pill archived">Archived</span>{/if}
              <button class="btn-sm" onclick={() => { renamingId = s.suite_name; renameValue = s.suite_name; }}>Rename</button>
              <button class="btn-sm" onclick={() => toggleArchive(s.suite_name, s.archived)}>{s.archived ? "Unarchive" : "Archive"}</button>
              {#if isOwner}
                <button class="btn-sm danger" onclick={() => deleteSuite(s.suite_name)}>Delete</button>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </section>
  {/if}

  <!-- Webhooks -->
  {#if isAdmin}
    <section class="card">
      <h2>Notifications</h2>
      <p class="card-desc">Webhooks for Slack, Teams, or Discord.</p>

      <div class="row-form">
        <input type="text" bind:value={newWhName} placeholder="Name (optional)" />
        <input type="url" bind:value={newWhUrl} placeholder="Webhook URL" oninput={() => { newWhPlatform = detectPlatform(newWhUrl); }} />
        <select bind:value={newWhPlatform}>
          <option value="generic">Generic JSON</option>
          <option value="slack">Slack</option>
          <option value="teams">Teams</option>
          <option value="discord">Discord</option>
        </select>
        <label class="checkbox-label">
          <input type="checkbox" checked={newWhEvents.includes("run.failed")} onchange={() => {
            newWhEvents = newWhEvents.includes("run.failed") ? newWhEvents.filter(e => e !== "run.failed") : [...newWhEvents, "run.failed"];
          }} /> Run failed
        </label>
        <label class="checkbox-label">
          <input type="checkbox" checked={newWhEvents.includes("flaky.detected")} onchange={() => {
            newWhEvents = newWhEvents.includes("flaky.detected") ? newWhEvents.filter(e => e !== "flaky.detected") : [...newWhEvents, "flaky.detected"];
          }} /> Flaky detected
        </label>
        <button class="btn-primary" onclick={createWebhook}>Add</button>
      </div>

      {#if webhooksLoading}
        <p class="muted">Loading...</p>
      {:else if webhooks.length === 0}
        <p class="muted">No webhooks configured.</p>
      {:else}
        <div class="list">
          {#each webhooks as wh}
            <div class="list-row">
              <div class="list-info">
                <span class="list-primary">{wh.name || "Unnamed"}</span>
                <span class="list-secondary mono">{wh.url.replace(/^https?:\/\//, "").slice(0, 40)}...</span>
              </div>
              {#if wh.platform && wh.platform !== "generic"}
                <span class="pill platform">{wh.platform}</span>
              {/if}
              <div class="wh-events">
                {#each wh.events as ev}
                  <span class="pill event">{ev}</span>
                {/each}
              </div>
              <button class="btn-sm" onclick={() => toggleWebhook(wh.id, wh.active)}>
                {wh.active ? "Pause" : "Enable"}
              </button>
              <button class="btn-sm" onclick={() => testWebhook(wh.id)}>
                {#if testResult?.id === wh.id}
                  {testResult.ok ? "Sent" : "Failed"}
                {:else}
                  Test
                {/if}
              </button>
              <button class="btn-icon danger" onclick={() => deleteWebhook(wh.id)} title="Delete">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3l10 10M13 3L3 13"/></svg>
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </section>
  {/if}

  <!-- GitHub Integration -->
  {#if isAdmin}
    <section class="card">
      <h2>GitHub PR Comments</h2>
      <p class="card-desc">Automatically post test results as PR comments when runs include a commit SHA or branch.</p>

      <div class="row-form">
        <input type="text" bind:value={githubRepo} placeholder="owner/repo" style="max-width: 220px" />
        <input type="password" bind:value={githubToken} placeholder={hasGithubToken ? "Token saved (enter new to replace)" : "GitHub token (PAT or fine-grained)"} />
        <button class="btn-primary" onclick={saveGithub}>
          {githubSaved ? "Saved" : "Save"}
        </button>
        {#if hasGithubToken}
          <button class="btn-sm danger" onclick={removeGithub}>Remove</button>
        {/if}
      </div>
      {#if githubError}<p class="form-error">{githubError}</p>{/if}
      {#if hasGithubToken && githubRepo}
        <p class="muted" style="margin-top: 0.25rem">Connected to <strong>{githubRepo}</strong>. PR comments will be posted on test uploads.</p>
      {:else}
        <p class="muted" style="margin-top: 0.25rem">Create a <a href="https://github.com/settings/tokens" target="_blank" rel="noopener">GitHub token</a> with <code>repo</code> scope (or fine-grained with Issues/PRs read+write).</p>
      {/if}
    </section>
  {/if}

  <!-- Data Retention -->
  {#if isAdmin}
    <section class="card">
      <h2>Data Retention</h2>
      <p class="card-desc">Automatically delete test runs older than a set number of days.</p>
      <div class="row-form">
        <input type="number" bind:value={retentionDays} placeholder="Days (empty = keep forever)" min="1" max="365" />
        <button class="btn-primary" onclick={saveRetention}>
          {retentionSaved ? "Saved" : "Save"}
        </button>
        <span class="muted" style="font-size:0.78rem">{retentionDays ? `Runs older than ${retentionDays} days will be deleted daily` : "Keeping all data forever"}</span>
      </div>
    </section>
  {/if}

  <!-- Audit Log -->
  {#if isAdmin}
    <section class="card">
      <h2>Audit Log</h2>
      <p class="card-desc">Recent activity in this organization.</p>

      {#if auditLoading}
        <p class="muted">Loading...</p>
      {:else if auditLog.length === 0}
        <p class="muted">No activity yet.</p>
      {:else}
        <div class="audit-list">
          {#each auditLog as entry}
            <div class="audit-row">
              <span class="audit-time">{timeAgo(entry.created_at)}</span>
              <span class="audit-user">{entry.user_name || entry.user_email || "System"}</span>
              <span class="audit-action">{formatAction(entry.action)}</span>
              {#if entry.target_id}
                <span class="audit-target">{entry.target_type}: {entry.target_id}</span>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </section>
  {/if}

  <!-- API -->
  <section class="card">
    <h2>API</h2>
    <div class="field-row">
      <label>Endpoint</label>
      <code>{apiUrl}</code>
    </div>
  </section>
</div>

<style>
  .page { max-width: 1100px; padding: 2rem; }

  .card {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1.25rem;
    margin-bottom: 1rem;
  }

  .card h2 { margin: 0 0 0.15rem; font-size: 1rem; }
  .card-desc { margin: 0 0 1rem; font-size: 0.78rem; color: var(--text-muted); }
  .muted { color: var(--text-muted); font-size: 0.85rem; margin: 0; }

  /* Forms */
  .row-form {
    display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.75rem; flex-wrap: wrap;
  }
  .row-form input[type="text"], .row-form input[type="email"], .row-form input[type="url"], .row-form input[type="number"] {
    padding: 0.45rem 0.65rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--text); font-size: 0.825rem; outline: none; flex: 1; min-width: 120px;
  }
  .row-form input:focus { border-color: var(--link); }
  .row-form input::placeholder { color: var(--text-muted); }
  .row-form select {
    padding: 0.45rem 0.5rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--text); font-size: 0.8rem;
  }

  .btn-primary {
    padding: 0.45rem 0.85rem; border: none; border-radius: 6px; background: var(--link);
    color: #fff; font-size: 0.8rem; font-weight: 600; cursor: pointer; white-space: nowrap;
  }
  .btn-primary:hover { opacity: 0.9; }

  .btn-sm {
    padding: 0.25rem 0.5rem; border: 1px solid var(--border); border-radius: 4px;
    background: var(--bg); color: var(--text-secondary); font-size: 0.72rem; cursor: pointer; white-space: nowrap;
  }
  .btn-sm:hover { background: var(--bg-hover); color: var(--text); }
  .btn-sm.danger:hover { color: var(--color-fail); border-color: var(--color-fail); }

  .btn-icon {
    display: flex; align-items: center; justify-content: center; width: 26px; height: 26px;
    border: none; border-radius: 4px; background: transparent; color: var(--text-muted);
    cursor: pointer; flex-shrink: 0;
  }
  .btn-icon.danger:hover { background: var(--error-bg); color: var(--color-fail); }

  .checkbox-label {
    display: flex; align-items: center; gap: 0.3rem; font-size: 0.78rem; color: var(--text-secondary); white-space: nowrap;
  }

  .form-error {
    margin: 0 0 0.75rem; padding: 0.4rem 0.65rem; background: var(--error-bg);
    border: 1px solid var(--error-border); border-radius: 6px; color: var(--error-text); font-size: 0.8rem;
  }

  .success-banner {
    padding: 0.65rem; background: color-mix(in srgb, var(--color-pass) 8%, transparent);
    border: 1px solid var(--color-pass); border-radius: 6px; margin-bottom: 0.75rem; font-size: 0.8rem;
  }
  .success-banner p { margin: 0 0 0.4rem; }
  .success-banner code { font-size: 0.72rem; padding: 0.2rem 0.4rem; background: var(--bg-secondary); border-radius: 3px; word-break: break-all; }

  .invite-link-row {
    display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;
  }
  .invite-link {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    padding: 0.35rem 0.5rem; background: var(--bg-secondary); border-radius: 4px; font-size: 0.72rem;
    user-select: all;
  }

  /* Lists */
  .list { display: flex; flex-direction: column; }
  .list-row {
    display: flex; align-items: center; gap: 0.75rem; padding: 0.6rem 0;
    border-top: 1px solid var(--border-light);
  }
  .list-row.archived { opacity: 0.5; }

  .avatar {
    width: 2rem; height: 2rem; border-radius: 50%; background: var(--bg-hover);
    color: var(--text-secondary); display: flex; align-items: center; justify-content: center;
    font-size: 0.8rem; font-weight: 700; flex-shrink: 0;
  }

  .list-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.1rem; }
  .list-primary { font-size: 0.85rem; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .list-secondary { font-size: 0.75rem; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .list-secondary.mono { font-family: monospace; }
  .list-meta { font-size: 0.72rem; color: var(--text-muted); flex-shrink: 0; }

  .pill {
    padding: 0.2rem 0.6rem; border-radius: 10px; font-size: 0.7rem; font-weight: 600;
    text-transform: capitalize; flex-shrink: 0;
  }
  .pill.owner { background: color-mix(in srgb, var(--link) 12%, transparent); color: var(--link); }
  .pill.admin { background: color-mix(in srgb, var(--color-pass) 12%, transparent); color: var(--color-pass); }
  .pill.viewer { background: var(--bg-hover); color: var(--text-secondary); }
  .pill.archived { background: var(--bg-hover); color: var(--text-muted); font-size: 0.65rem; }
  .pill.event { background: var(--bg-secondary); color: var(--text-secondary); font-size: 0.65rem; font-family: monospace; }
  .pill.platform { background: color-mix(in srgb, var(--link) 10%, transparent); color: var(--link); font-size: 0.65rem; text-transform: capitalize; }

  .inline-select {
    padding: 0.2rem 0.35rem; border: 1px solid var(--border); border-radius: 4px;
    background: var(--bg); color: var(--text); font-size: 0.75rem; flex-shrink: 0;
  }

  .inline-rename {
    display: flex; gap: 0.35rem; align-items: center;
  }
  .inline-rename input {
    padding: 0.3rem 0.5rem; border: 1px solid var(--link); border-radius: 4px;
    background: var(--bg); color: var(--text); font-size: 0.82rem; outline: none; width: 200px;
  }

  .wh-events { display: flex; gap: 0.25rem; flex-shrink: 0; }

  /* Audit */
  .audit-list { display: flex; flex-direction: column; }
  .audit-row {
    display: flex; align-items: baseline; gap: 0.75rem; padding: 0.4rem 0;
    border-top: 1px solid var(--border-light); font-size: 0.8rem;
  }
  .audit-time { color: var(--text-muted); font-size: 0.72rem; min-width: 4.5rem; flex-shrink: 0; }
  .audit-user { color: var(--text-secondary); min-width: 8rem; flex-shrink: 0; }
  .audit-action { font-weight: 500; color: var(--text); }
  .audit-target { color: var(--text-muted); font-family: monospace; font-size: 0.75rem; }

  /* API */
  .field-row { display: flex; gap: 1rem; font-size: 0.875rem; align-items: center; }
  .field-row label { color: var(--text-secondary); min-width: 5rem; }
  .field-row code { padding: 0.25rem 0.5rem; background: var(--bg-hover); border-radius: 4px; font-size: 0.8rem; }
</style>
