<script lang="ts">
  import { onMount } from "svelte";
  import { timeAgo, absoluteDate } from "$lib/utils/format";
  import DOMPurify from "isomorphic-dompurify";
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
  // `compact` is a one-shot layout knob set by the mounting page; the
  // initial-value capture is intentional, so silence the runes warning.
  // svelte-ignore state_referenced_locally
  let expanded = $state(!compact);
  let posting = $state(false);
  let textareaEl = $state<HTMLTextAreaElement | undefined>();

  onMount(load);

  async function load() {
    loading = true;
    try {
      notes = await fetchNotes(targetType, targetKey);
    } catch { /* ignore */ }
    loading = false;
  }

  async function submit() {
    const body = newNote.trim();
    if (!body || posting) return;
    posting = true;
    try {
      const note = await addNote(targetType, targetKey, body);
      notes = [...notes, note];
      newNote = "";
      // Restore focus so users can type a follow-up note immediately.
      queueMicrotask(() => textareaEl?.focus());
    } catch { /* ignore */ }
    posting = false;
  }

  function onKeydown(e: KeyboardEvent) {
    // Cmd/Ctrl+Enter posts — matches the convention used in Slack,
    // GitHub, Linear. Plain Enter inserts a newline (textarea default).
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  }

  function authorLabel(n: Note): string {
    return n.user_name || n.user_email || "Unknown";
  }

  function authorInitial(n: Note): string {
    const label = authorLabel(n);
    return label.trim().charAt(0).toUpperCase() || "?";
  }

  // Deterministic accent color per author so the chips stay readable
  // when many notes share the panel. 6 hues hand-picked to sit
  // alongside the project's status palette without colliding with
  // pass/fail/skip semantics.
  const CHIP_PALETTE = [
    "#5b6cff", "#8b5cf6", "#d946ef", "#0ea5e9", "#14b8a6", "#f59e0b",
  ];
  function chipColor(n: Note): string {
    const key = (n.user_email || n.user_name || "").toLowerCase();
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return CHIP_PALETTE[h % CHIP_PALETTE.length];
  }

  // URL_RE intentionally excludes trailing punctuation so "see https://x.com." doesn't
  // capture the period. Captures common protocols + bare www.
  const URL_RE = /\b(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/g;

  // HTML-escape raw text without touching the DOM, so the same code runs
  // identically under SSR and in the browser (no `document` dependency).
  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Render a note body with autolinked URLs. One code path, no SSR branch:
  //   1. HTML-escape the raw text (string-based — works without a DOM).
  //   2. Replace URL matches with anchor tags.
  //   3. Run the result through DOMPurify so the allow-list (a[href]) is the
  //      unconditional final backstop even if the input ever bypasses our
  //      regex. isomorphic-dompurify supplies a jsdom-backed window under
  //      SSR, so the same sanitizer runs server- and client-side.
  function renderBodySafe(body: string): string {
    const escaped = escapeHtml(body);
    const linked = escaped.replace(URL_RE, (url) => {
      const trimmed = url.replace(/[.,;:!?)]+$/, "");
      const trailing = url.slice(trimmed.length);
      const href = trimmed.startsWith("www.") ? `https://${trimmed}` : trimmed;
      return `<a href="${href}" target="_blank" rel="noopener noreferrer ugc">${trimmed}</a>${trailing}`;
    });
    return DOMPurify.sanitize(linked, {
      ALLOWED_TAGS: ["a", "br"],
      ALLOWED_ATTR: ["href", "target", "rel"],
    });
  }
</script>

<div class="notes-panel" class:compact>
  {#if compact}
    <button class="toggle" onclick={() => expanded = !expanded} aria-expanded={expanded}>
      <span>Notes</span>
      <span class="toggle-count">{notes.length}</span>
      <svg class="chevron" class:open={expanded} width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 3.75L5 6.25L7.5 3.75"/></svg>
    </button>
  {:else}
    <div class="header">
      <h4>Notes</h4>
      <span class="header-count">{notes.length}</span>
    </div>
  {/if}

  {#if expanded}
    {#if loading}
      <p class="state-msg muted">Loading notes…</p>
    {:else if notes.length === 0}
      <div class="empty">
        <div class="empty-icon" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
        </div>
        <div class="empty-text">
          <strong>No notes yet</strong>
          <span class="empty-hint">Drop a quick observation, repro link, or follow-up so the next person isn't starting from scratch.</span>
        </div>
      </div>
    {:else}
      <ul class="notes-list">
        {#each notes as note (note.id)}
          <li class="note">
            <span class="note-chip" style:background-color={chipColor(note)}
                  title={note.user_email || authorLabel(note)} aria-hidden="true">
              {authorInitial(note)}
            </span>
            <div class="note-main">
              <div class="note-header">
                <span class="note-author" title={note.user_email || ""}>{authorLabel(note)}</span>
                <span class="note-time" title={absoluteDate(note.created_at)}>{timeAgo(note.created_at)}</span>
              </div>
              <p class="note-body">{@html renderBodySafe(note.body)}</p>
            </div>
          </li>
        {/each}
      </ul>
    {/if}

    <form class="note-form" onsubmit={(e) => { e.preventDefault(); submit(); }}>
      <textarea
        bind:this={textareaEl}
        bind:value={newNote}
        onkeydown={onKeydown}
        placeholder="Add a note..."
        rows="2"
        disabled={posting}
      ></textarea>
      <div class="note-form-footer">
        <span class="hint">{newNote.trim() ? "⌘/Ctrl + Enter to post" : ""}</span>
        <button type="submit" class="btn-post" disabled={!newNote.trim() || posting}>
          {posting ? "Posting…" : "Post"}
        </button>
      </div>
    </form>
  {/if}
</div>

<style>
  .notes-panel { width: 100%; }
  .notes-panel:not(.compact) { border-top: 1px solid var(--border); padding-top: 0.85rem; }

  .header { display: flex; align-items: center; gap: 0.45rem; margin-bottom: 0.6rem; }
  h4 {
    margin: 0; font-size: 0.7rem; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700;
  }
  .header-count {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 1.25rem; height: 1.05rem; padding: 0 0.4rem;
    border-radius: 999px; background: var(--bg-secondary);
    color: var(--text-secondary);
    font-size: 0.65rem; font-weight: 700;
  }

  .toggle {
    display: inline-flex; align-items: center; gap: 0.4rem;
    background: none; border: none; padding: 0.25rem 0; cursor: pointer;
    font-size: 0.7rem; color: var(--text-muted); font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.06em;
  }
  .toggle:hover { color: var(--text-secondary); }
  .toggle:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; border-radius: 4px; }
  .toggle-count {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 1.2rem; height: 1rem; padding: 0 0.35rem;
    border-radius: 999px; background: var(--bg-secondary);
    color: var(--text-secondary); font-size: 0.62rem; font-weight: 700;
    text-transform: none; letter-spacing: 0;
  }
  .chevron { transition: transform 0.15s; }
  .chevron.open { transform: rotate(180deg); }

  .state-msg { color: var(--text-muted); font-size: 0.8rem; margin: 0 0 0.6rem; }
  .muted { color: var(--text-muted); }

  .empty {
    display: flex; align-items: flex-start; gap: 0.6rem;
    padding: 0.7rem 0.8rem; margin-bottom: 0.7rem;
    background: var(--bg-secondary);
    border: 1px dashed var(--border); border-radius: 8px;
  }
  .empty-icon {
    flex: 0 0 auto; color: var(--text-muted);
    display: flex; align-items: center; justify-content: center;
    width: 1.75rem; height: 1.75rem;
  }
  .empty-text { display: flex; flex-direction: column; gap: 0.15rem; }
  .empty-text strong { font-size: 0.78rem; color: var(--text); font-weight: 600; }
  .empty-hint { font-size: 0.72rem; color: var(--text-muted); line-height: 1.4; }

  .notes-list {
    list-style: none; padding: 0; margin: 0 0 0.7rem;
    display: flex; flex-direction: column; gap: 0.4rem;
  }

  .note {
    display: grid; grid-template-columns: auto 1fr; gap: 0.55rem;
    padding: 0.45rem 0.6rem;
    background: var(--bg);
    border: 1px solid var(--border); border-radius: 6px;
  }
  .note-chip {
    flex: 0 0 auto;
    display: inline-flex; align-items: center; justify-content: center;
    width: 1.5rem; height: 1.5rem; margin-top: 0.05rem;
    border-radius: 999px;
    color: #fff; font-size: 0.7rem; font-weight: 700;
    line-height: 1;
  }
  .note-main { min-width: 0; }
  .note-header {
    display: flex; align-items: baseline; gap: 0.5rem;
    margin-bottom: 0.15rem;
  }
  .note-author {
    font-size: 0.72rem; font-weight: 600; color: var(--text);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .note-time {
    font-size: 0.66rem; color: var(--text-muted);
    margin-left: auto; flex: 0 0 auto;
  }
  .note-body {
    margin: 0; font-size: 0.8rem; color: var(--text-secondary);
    white-space: pre-wrap; word-break: break-word; line-height: 1.45;
  }
  .note-body :global(a) {
    color: var(--link); text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--link) 45%, transparent);
    text-underline-offset: 2px;
  }
  .note-body :global(a:hover) { text-decoration-color: var(--link); }

  .note-form { display: flex; flex-direction: column; gap: 0.35rem; }
  .note-form textarea {
    width: 100%; padding: 0.45rem 0.6rem;
    border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--text);
    font-size: 0.8rem; font-family: inherit; line-height: 1.4;
    outline: none; resize: vertical; min-height: 2.4rem;
  }
  .note-form textarea:focus {
    border-color: var(--link);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--link) 18%, transparent);
  }
  .note-form textarea::placeholder { color: var(--text-muted); }
  .note-form textarea:disabled { opacity: 0.6; cursor: not-allowed; }

  .note-form-footer {
    display: flex; align-items: center; justify-content: flex-end;
    gap: 0.6rem;
  }
  .hint {
    font-size: 0.66rem; color: var(--text-muted);
    margin-right: auto;
  }

  .btn-post {
    padding: 0.35rem 0.85rem; border: none; border-radius: 6px;
    background: var(--link); color: #fff;
    font-size: 0.75rem; font-weight: 600; cursor: pointer;
    transition: opacity 0.15s, background 0.15s;
  }
  .btn-post:hover:not(:disabled) {
    background: color-mix(in srgb, var(--link) 88%, #000);
  }
  .btn-post:disabled { opacity: 0.45; cursor: not-allowed; }
  .btn-post:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
</style>
