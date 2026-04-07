<script lang="ts">
  import { getAuth, type User } from "$lib/auth";
  import { onMount } from "svelte";

  const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

  let user = $state<User | null>(null);

  interface ApiKey {
    id: number;
    key_prefix: string;
    label: string;
    last_used_at: string | null;
    created_at: string;
  }

  let apiKeys = $state<ApiKey[]>([]);
  let newKeyLabel = $state("");
  let newKeyValue = $state<string | null>(null);
  let keysLoading = $state(true);

  onMount(() => {
    user = getAuth().user;
    loadKeys();
  });

  async function loadKeys() {
    keysLoading = true;
    const token = getAuth().token;
    const res = await fetch(`${API_URL}/auth/api-keys`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) apiKeys = await res.json();
    keysLoading = false;
  }

  async function createKey() {
    const token = getAuth().token;
    const res = await fetch(`${API_URL}/auth/api-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ label: newKeyLabel || "Untitled key" }),
    });
    if (res.ok) {
      const data = await res.json();
      newKeyValue = data.key;
      newKeyLabel = "";
      loadKeys();
    }
  }

  async function deleteKey(id: number) {
    const token = getAuth().token;
    await fetch(`${API_URL}/auth/api-keys/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    loadKeys();
  }

  function timeAgo(iso: string | null): string {
    if (!iso) return "Never";
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }
</script>

<div class="page">
  <p class="description">Your account and API key settings.</p>

  <section class="card">
    <h2>Account</h2>
    <div class="fields">
      <div class="field">
        <span class="field-label">Email</span>
        <span>{user?.email ?? "—"}</span>
      </div>
      <div class="field">
        <span class="field-label">Name</span>
        <span>{user?.name || "—"}</span>
      </div>
      <div class="field">
        <span class="field-label">Role</span>
        <span class="role-badge">{user?.role ?? "—"}</span>
      </div>
    </div>
  </section>

  <section class="card">
    <h2>API Keys</h2>
    <p class="card-desc">Use API keys to authenticate CLI uploads and programmatic access.</p>

    {#if newKeyValue}
      <div class="new-key-banner">
        <p class="new-key-label">Copy this key now — it won't be shown again:</p>
        <code class="new-key-value">{newKeyValue}</code>
        <button class="dismiss-btn" onclick={() => newKeyValue = null}>Dismiss</button>
      </div>
    {/if}

    <div class="create-key">
      <input type="text" bind:value={newKeyLabel} placeholder="Key label (e.g. CI pipeline)" />
      <button class="create-btn" onclick={createKey}>Create key</button>
    </div>

    {#if keysLoading}
      <p class="placeholder">Loading...</p>
    {:else if apiKeys.length === 0}
      <p class="placeholder">No API keys yet.</p>
    {:else}
      <div class="keys-list">
        {#each apiKeys as key}
          <div class="key-row">
            <div class="key-info">
              <span class="key-label">{key.label}</span>
              <span class="key-meta">
                <code>{key.key_prefix}...</code> · Last used {timeAgo(key.last_used_at)} · Created {timeAgo(key.created_at)}
              </span>
            </div>
            <button class="delete-btn" onclick={() => deleteKey(key.id)}>Delete</button>
          </div>
        {/each}
      </div>
    {/if}
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

  .card h2 {
    margin: 0 0 0.25rem;
    font-size: 1rem;
  }

  .card-desc {
    margin: 0 0 1rem;
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  .fields {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .field {
    display: flex;
    gap: 1rem;
    font-size: 0.875rem;
  }

  .field-label {
    color: var(--text-secondary);
    min-width: 4rem;
  }

  .role-badge {
    padding: 0.1rem 0.5rem;
    border-radius: 10px;
    font-size: 0.75rem;
    font-weight: 500;
    background: color-mix(in srgb, var(--link) 12%, transparent);
    color: var(--link);
  }

  .new-key-banner {
    padding: 0.85rem;
    background: color-mix(in srgb, var(--color-pass) 8%, transparent);
    border: 1px solid var(--color-pass);
    border-radius: 6px;
    margin-bottom: 1rem;
  }

  .new-key-label {
    margin: 0 0 0.4rem;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--text);
  }

  .new-key-value {
    display: block;
    padding: 0.5rem;
    background: var(--bg-secondary);
    border-radius: 4px;
    font-size: 0.78rem;
    word-break: break-all;
    margin-bottom: 0.5rem;
  }

  .dismiss-btn {
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg);
    color: var(--text-secondary);
    font-size: 0.75rem;
    cursor: pointer;
  }

  .create-key {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .create-key input {
    flex: 1;
    padding: 0.45rem 0.65rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font-size: 0.825rem;
    outline: none;
  }

  .create-key input:focus {
    border-color: var(--link);
  }

  .create-key input::placeholder {
    color: var(--text-muted);
  }

  .create-btn {
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

  .create-btn:hover {
    opacity: 0.9;
  }

  .keys-list {
    display: flex;
    flex-direction: column;
  }

  .key-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.65rem 0;
    border-top: 1px solid var(--border-light);
  }

  .key-info {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
  }

  .key-label {
    font-size: 0.85rem;
    font-weight: 500;
  }

  .key-meta {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .key-meta code {
    font-size: 0.72rem;
    padding: 0.1rem 0.3rem;
    background: var(--bg-secondary);
    border-radius: 3px;
  }

  .delete-btn {
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: transparent;
    color: var(--text-muted);
    font-size: 0.75rem;
    cursor: pointer;
    flex-shrink: 0;
  }

  .delete-btn:hover {
    color: var(--color-fail);
    border-color: var(--color-fail);
  }

  .placeholder {
    color: var(--text-muted);
    font-size: 0.85rem;
    margin: 0;
  }
</style>
