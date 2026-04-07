<script lang="ts">
  import { onMount } from "svelte";
  import { fetchNotes, addNote, type Note } from "$lib/api";

  interface Props {
    targetType: string;
    targetKey: string;
    compact?: boolean;
  }

  let { targetType, targetKey, compact = false }: Props = $props();

  let notes = $state<Note[]>([]);
  let loading = $state(true);
  let newNote = $state("");
  let expanded = $state(!compact);

  onMount(load);

  async function load() {
    loading = true;
    try {
      notes = await fetchNotes(targetType, targetKey);
    } catch { /* ignore */ }
    loading = false;
  }

  async function submit() {
    if (!newNote.trim()) return;
    try {
      const note = await addNote(targetType, targetKey, newNote.trim());
      notes = [...notes, note];
      newNote = "";
    } catch { /* ignore */ }
  }

  function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }
</script>

<div class="notes-panel" class:compact>
  {#if compact}
    <button class="toggle" onclick={() => expanded = !expanded}>
      Notes ({notes.length})
      <svg class="chevron" class:open={expanded} width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 3.75L5 6.25L7.5 3.75"/></svg>
    </button>
  {:else}
    <h4>Notes ({notes.length})</h4>
  {/if}

  {#if expanded}
    {#if loading}
      <p class="muted">Loading...</p>
    {:else if notes.length === 0}
      <p class="muted">No notes yet.</p>
    {:else}
      <div class="notes-list">
        {#each notes as note}
          <div class="note">
            <div class="note-header">
              <span class="note-author">{note.user_name || note.user_email}</span>
              <span class="note-time">{timeAgo(note.created_at)}</span>
            </div>
            <p class="note-body">{note.body}</p>
          </div>
        {/each}
      </div>
    {/if}

    <form class="note-form" onsubmit={(e) => { e.preventDefault(); submit(); }}>
      <input type="text" bind:value={newNote} placeholder="Add a note..." />
      <button type="submit" class="btn-post" disabled={!newNote.trim()}>Post</button>
    </form>
  {/if}
</div>

<style>
  .notes-panel { width: 100%; }
  .notes-panel:not(.compact) { border-top: 1px solid var(--border); padding-top: 0.75rem; }

  h4 {
    margin: 0 0 0.5rem; font-size: 0.75rem; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.05em;
  }

  .toggle {
    display: flex; align-items: center; gap: 0.3rem;
    background: none; border: none; padding: 0.25rem 0; cursor: pointer;
    font-size: 0.75rem; color: var(--text-muted); font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.05em;
  }
  .toggle:hover { color: var(--text-secondary); }
  .chevron { transition: transform 0.15s; }
  .chevron.open { transform: rotate(180deg); }

  .muted { color: var(--text-muted); font-size: 0.8rem; margin: 0 0 0.5rem; }

  .notes-list { display: flex; flex-direction: column; gap: 0.4rem; margin-bottom: 0.6rem; }

  .note {
    padding: 0.4rem 0.6rem; background: var(--bg); border-radius: 6px;
    border: 1px solid var(--border);
  }
  .note-header { display: flex; justify-content: space-between; margin-bottom: 0.15rem; }
  .note-author { font-size: 0.75rem; font-weight: 600; color: var(--text); }
  .note-time { font-size: 0.68rem; color: var(--text-muted); }
  .note-body { margin: 0; font-size: 0.8rem; color: var(--text-secondary); white-space: pre-wrap; }

  .note-form { display: flex; gap: 0.35rem; }
  .note-form input {
    flex: 1; padding: 0.35rem 0.55rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--text); font-size: 0.8rem; outline: none;
  }
  .note-form input:focus { border-color: var(--link); }
  .note-form input::placeholder { color: var(--text-muted); }

  .btn-post {
    padding: 0.35rem 0.65rem; border: none; border-radius: 6px; background: var(--link);
    color: #fff; font-size: 0.75rem; font-weight: 600; cursor: pointer;
  }
  .btn-post:hover { opacity: 0.9; }
  .btn-post:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
