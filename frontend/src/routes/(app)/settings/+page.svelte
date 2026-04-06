<script lang="ts">
  import { onMount } from "svelte";
  import { getAuth } from "$lib/auth";

  const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

  interface Member {
    id: number;
    email: string;
    name: string;
    role: string;
    joined_at: string;
  }

  let members = $state<Member[]>([]);
  let loading = $state(true);
  let inviteEmail = $state("");
  let inviteRole = $state<"admin" | "viewer">("viewer");
  let inviteResult = $state<{ token: string; org_name: string } | null>(null);
  let inviteError = $state<string | null>(null);
  let currentUser = $state(getAuth());

  function headers() {
    return { "Content-Type": "application/json", Authorization: `Bearer ${currentUser.token}` };
  }

  async function loadMembers() {
    loading = true;
    const orgId = currentUser.user?.orgId;
    const res = await fetch(`${apiUrl}/orgs/${orgId}/members`, { headers: { Authorization: `Bearer ${currentUser.token}` } });
    if (res.ok) members = await res.json();
    loading = false;
  }

  async function invite() {
    inviteError = null;
    inviteResult = null;
    if (!inviteEmail) { inviteError = "Email is required"; return; }
    const orgId = currentUser.user?.orgId;
    const res = await fetch(`${apiUrl}/orgs/${orgId}/invites`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
    });
    if (res.ok) {
      const data = await res.json();
      inviteResult = data;
      inviteEmail = "";
    } else {
      const body = await res.json().catch(() => ({}));
      inviteError = (body as { error?: string }).error ?? "Failed to invite";
    }
  }

  async function changeRole(userId: number, role: string) {
    const orgId = currentUser.user?.orgId;
    await fetch(`${apiUrl}/orgs/${orgId}/members/${userId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ role }),
    });
    loadMembers();
  }

  async function removeMember(userId: number, name: string) {
    const orgId = currentUser.user?.orgId;
    await fetch(`${apiUrl}/orgs/${orgId}/members/${userId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${currentUser.token}` },
    });
    loadMembers();
  }

  function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const days = Math.floor(diff / 86400000);
    if (days === 0) return "today";
    if (days === 1) return "yesterday";
    return `${days}d ago`;
  }

  let isOwner = $derived(currentUser.user?.orgRole === "owner");
  let isAdmin = $derived(currentUser.user?.orgRole === "admin" || isOwner);

  onMount(() => loadMembers());
</script>

<div class="page">
  <p class="description">Organization and project settings.</p>

  <!-- Team members -->
  <section class="card">
    <div class="card-header">
      <div>
        <h2>Team</h2>
        <p class="card-desc">{members.length} member{members.length !== 1 ? "s" : ""}</p>
      </div>
    </div>

    {#if isAdmin}
      <div class="invite-form">
        <input type="email" bind:value={inviteEmail} placeholder="Email address" />
        <select bind:value={inviteRole}>
          <option value="viewer">Viewer</option>
          <option value="admin">Admin</option>
        </select>
        <button class="invite-btn" onclick={invite}>Invite</button>
      </div>

      {#if inviteError}
        <p class="invite-error">{inviteError}</p>
      {/if}

      {#if inviteResult}
        <div class="invite-success">
          <p>Invite created for <strong>{inviteEmail || "user"}</strong>. Share this link:</p>
          <code class="invite-link">{apiUrl.replace(':3000', ':7777')}/login?invite={inviteResult.token}</code>
          <button class="dismiss-btn" onclick={() => inviteResult = null}>Dismiss</button>
        </div>
      {/if}
    {/if}

    {#if loading}
      <p class="placeholder">Loading...</p>
    {:else}
      <div class="members-list">
        {#each members as member}
          <div class="member-row">
            <div class="member-avatar">{member.name?.charAt(0)?.toUpperCase() || member.email.charAt(0).toUpperCase()}</div>
            <div class="member-info">
              <span class="member-name">{member.name || member.email}</span>
              <span class="member-email">{member.email}</span>
            </div>
            <span class="member-joined">Joined {timeAgo(member.joined_at)}</span>
            {#if member.role === "owner"}
              <span class="role-badge owner">Owner</span>
            {:else if isOwner && member.id !== currentUser.user?.id}
              <select class="role-select" value={member.role} onchange={(e) => changeRole(member.id, (e.target as HTMLSelectElement).value)}>
                <option value="admin">Admin</option>
                <option value="viewer">Viewer</option>
              </select>
              <button class="remove-btn" onclick={() => removeMember(member.id, member.name)} title="Remove member">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3l10 10M13 3L3 13"/></svg>
              </button>
            {:else}
              <span class="role-badge {member.role}">{member.role}</span>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <section class="card">
    <h2>Notifications</h2>
    <p class="placeholder">Webhook and Slack notification settings coming soon.</p>
  </section>

  <section class="card">
    <h2>Data Retention</h2>
    <p class="placeholder">Configure how long test run data is retained.</p>
  </section>

  <section class="card">
    <h2>API</h2>
    <div class="field">
      <label>Endpoint</label>
      <code>{apiUrl}</code>
    </div>
  </section>
</div>

<style>
  .page {
    max-width: 1100px;
    padding: 2rem 2rem;
  }

  .description {
    margin: 0.25rem 0 2rem;
    color: var(--text-secondary);
    font-size: 0.875rem;
  }

  .card {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1.25rem;
    margin-bottom: 1rem;
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }

  .card h2 {
    margin: 0 0 0.15rem;
    font-size: 1rem;
  }

  .card-desc {
    margin: 0 0 1rem;
    font-size: 0.78rem;
    color: var(--text-muted);
  }

  /* Invite form */
  .invite-form {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .invite-form input {
    flex: 1;
    padding: 0.45rem 0.65rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font-size: 0.825rem;
    outline: none;
  }

  .invite-form input:focus {
    border-color: var(--link);
  }

  .invite-form input::placeholder {
    color: var(--text-muted);
  }

  .invite-form select {
    padding: 0.45rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font-size: 0.8rem;
  }

  .invite-btn {
    padding: 0.45rem 0.85rem;
    border: none;
    border-radius: 6px;
    background: var(--link);
    color: #fff;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }

  .invite-btn:hover { opacity: 0.9; }

  .invite-error {
    margin: 0 0 0.75rem;
    padding: 0.4rem 0.65rem;
    background: var(--error-bg);
    border: 1px solid var(--error-border);
    border-radius: 6px;
    color: var(--error-text);
    font-size: 0.8rem;
  }

  .invite-success {
    padding: 0.75rem;
    background: color-mix(in srgb, var(--color-pass) 8%, transparent);
    border: 1px solid var(--color-pass);
    border-radius: 6px;
    margin-bottom: 0.75rem;
  }

  .invite-success p {
    margin: 0 0 0.4rem;
    font-size: 0.8rem;
  }

  .invite-link {
    display: block;
    padding: 0.4rem 0.5rem;
    background: var(--bg-secondary);
    border-radius: 4px;
    font-size: 0.75rem;
    word-break: break-all;
    margin-bottom: 0.5rem;
  }

  .dismiss-btn {
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg);
    color: var(--text-secondary);
    font-size: 0.72rem;
    cursor: pointer;
  }

  /* Members list */
  .members-list {
    display: flex;
    flex-direction: column;
  }

  .member-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.65rem 0;
    border-top: 1px solid var(--border-light);
  }

  .member-avatar {
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    background: var(--bg-hover);
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.8rem;
    font-weight: 700;
    flex-shrink: 0;
  }

  .member-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .member-name {
    font-size: 0.85rem;
    font-weight: 500;
  }

  .member-email {
    font-size: 0.75rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .member-joined {
    font-size: 0.72rem;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .role-badge {
    padding: 0.2rem 0.6rem;
    border-radius: 10px;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: capitalize;
    flex-shrink: 0;
  }

  .role-badge.owner {
    background: color-mix(in srgb, var(--link) 12%, transparent);
    color: var(--link);
  }

  .role-badge.admin {
    background: color-mix(in srgb, var(--color-pass) 12%, transparent);
    color: var(--color-pass);
  }

  .role-badge.viewer {
    background: var(--bg-hover);
    color: var(--text-secondary);
  }

  .role-select {
    padding: 0.25rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg);
    color: var(--text);
    font-size: 0.75rem;
    flex-shrink: 0;
  }

  .remove-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    flex-shrink: 0;
    transition: color 0.1s, background 0.1s;
  }

  .remove-btn:hover {
    background: var(--error-bg);
    color: var(--color-fail);
  }

  .field {
    display: flex;
    gap: 1rem;
    font-size: 0.875rem;
    align-items: center;
  }

  .field label {
    color: var(--text-secondary);
    min-width: 5rem;
  }

  .field code {
    padding: 0.25rem 0.5rem;
    background: var(--bg-hover);
    border-radius: 4px;
    font-size: 0.8rem;
  }

  .placeholder {
    color: var(--text-muted);
    font-size: 0.875rem;
    margin: 0;
  }
</style>
