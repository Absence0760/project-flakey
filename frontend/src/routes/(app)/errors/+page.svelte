<script lang="ts">
  import { onMount } from "svelte";
  import { fetchErrors, fetchRuns, fetchErrorNotes, addErrorNote, updateErrorStatus, fetchAffectedTests, type ErrorGroup, type ErrorNote, type AffectedTest, type Run } from "$lib/api";
  import ErrorModal from "$lib/components/ErrorModal.svelte";

  let errors = $state<ErrorGroup[]>([]);
  let allRuns = $state<Run[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let modalTestId = $state<number | null>(null);

  let selectedSuite = $state("all");
  let selectedStatus = $state("all");

  let suites = $derived([...new Set(allRuns.map((r) => r.suite_name))].sort());

  // Expanded error detail
  let expandedFingerprint = $state<string | null>(null);
  let notes = $state<ErrorNote[]>([]);
  let affectedTests = $state<AffectedTest[]>([]);
  let notesLoading = $state(false);
  let testsLoading = $state(false);
  let newNote = $state("");

  const statuses = [
    { value: "open", label: "Open", color: "var(--color-fail)" },
    { value: "investigating", label: "Investigating", color: "var(--link)" },
    { value: "known", label: "Known Issue", color: "#dfb317" },
    { value: "fixed", label: "Fixed", color: "var(--color-pass)" },
    { value: "ignored", label: "Ignored", color: "var(--text-muted)" },
  ];

  function statusInfo(s: string) {
    return statuses.find((st) => st.value === s) ?? statuses[0];
  }

  onMount(async () => {
    try {
      const [errs, runs] = await Promise.all([fetchErrors(), fetchRuns()]);
      errors = errs;
      allRuns = runs;
    } catch (e) {
      loadError = e instanceof Error ? e.message : "Failed to load errors";
    } finally {
      loading = false;
    }
  });

  async function applyFilters() {
    loading = true;
    try {
      errors = await fetchErrors({
        suite: selectedSuite !== "all" ? selectedSuite : undefined,
        status: selectedStatus !== "all" ? selectedStatus : undefined,
      });
    } catch (e) {
      loadError = e instanceof Error ? e.message : "Failed to load errors";
    } finally {
      loading = false;
    }
  }

  function onSuiteChange() { applyFilters(); }
  function onStatusChange() { applyFilters(); }

  async function toggleExpand(err: ErrorGroup) {
    if (expandedFingerprint === err.fingerprint) {
      expandedFingerprint = null;
      return;
    }
    expandedFingerprint = err.fingerprint;
    notes = [];
    affectedTests = [];
    newNote = "";
    notesLoading = true;
    testsLoading = true;
    try {
      const [n, t] = await Promise.all([
        fetchErrorNotes(err.fingerprint),
        fetchAffectedTests(err.fingerprint),
      ]);
      notes = n;
      affectedTests = t;
    } catch { /* ignore */ }
    notesLoading = false;
    testsLoading = false;
  }

  async function changeStatus(err: ErrorGroup, status: string) {
    try {
      await updateErrorStatus(err.fingerprint, status);
      err.status = status;
      errors = [...errors];
    } catch { /* ignore */ }
  }

  async function submitNote(fingerprint: string) {
    if (!newNote.trim()) return;
    try {
      const note = await addErrorNote(fingerprint, newNote.trim());
      notes = [...notes, note];
      newNote = "";
      // Update note count
      const err = errors.find((e) => e.fingerprint === fingerprint);
      if (err) { err.note_count++; errors = [...errors]; }
    } catch { /* ignore */ }
  }

  function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    return `${Math.floor(days / 30)}mo ago`;
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
</script>

<div class="page">
  <div class="header">
    <div>
      <p class="description">Recurring test failures tracked with status and notes.</p>
    </div>
    <div class="filters">
      <select bind:value={selectedSuite} onchange={onSuiteChange}>
        <option value="all">All suites</option>
        {#each suites as suite}
          <option value={suite}>{suite}</option>
        {/each}
      </select>
      <select bind:value={selectedStatus} onchange={onStatusChange}>
        <option value="all">All statuses</option>
        {#each statuses as s}
          <option value={s.value}>{s.label}</option>
        {/each}
      </select>
    </div>
  </div>

  {#if loading}
    <p class="status-text">Loading...</p>
  {:else if loadError}
    <p class="status-text error">{loadError}</p>
  {:else if errors.length === 0}
    <div class="empty">
      <p>No errors found.</p>
      <p class="hint">
        {#if selectedSuite !== "all" || selectedStatus !== "all"}
          Try changing the filters.
        {:else}
          Errors appear here when test runs have failures.
        {/if}
      </p>
    </div>
  {:else}
    <div class="error-list">
      {#each errors as err}
        <div class="error-card" class:expanded={expandedFingerprint === err.fingerprint}>
          <button class="error-header" onclick={() => toggleExpand(err)}>
            <div class="error-main">
              <span class="error-count">{err.occurrence_count}x</span>
              <div class="error-info">
                <div class="error-title-row">
                  <span class="error-message-primary">{err.error_message}</span>
                  <span class="status-badge" style="background: {statusInfo(err.status).color}">{statusInfo(err.status).label}</span>
                </div>
                <span class="error-tests-summary">{err.affected_tests} test{err.affected_tests !== 1 ? "s" : ""} affected</span>
              </div>
            </div>
            <div class="error-meta">
              <span class="meta-item" title="Affected runs">{err.affected_runs} run{err.affected_runs !== 1 ? "s" : ""}</span>
              <span class="meta-sep">·</span>
              <span class="meta-item">{err.suite_name}</span>
              <span class="meta-sep">·</span>
              <span class="meta-item" title="First seen {formatDate(err.first_seen)}">first {timeAgo(err.first_seen)}</span>
              <span class="meta-sep">·</span>
              <span class="meta-item" title="Last seen {formatDate(err.last_seen)}">last {timeAgo(err.last_seen)}</span>
              {#if err.note_count > 0}
                <span class="meta-sep">·</span>
                <span class="meta-item notes-count">{err.note_count} note{err.note_count !== 1 ? "s" : ""}</span>
              {/if}
            </div>
          </button>

          {#if expandedFingerprint === err.fingerprint}
            <div class="error-detail">
              <div class="detail-row">
                <div class="detail-section">
                  <h4>Status</h4>
                  <div class="status-controls">
                    {#each statuses as s}
                      <button
                        class="status-btn"
                        class:active={err.status === s.value}
                        style="--status-color: {s.color}"
                        onclick={() => changeStatus(err, s.value)}
                      >{s.label}</button>
                    {/each}
                  </div>
                </div>
                <div class="detail-section">
                  <h4>Details</h4>
                  <div class="detail-facts">
                    <span>Occurrences: <strong>{err.occurrence_count}</strong></span>
                    <span>Affected runs: <strong>{err.affected_runs}</strong></span>
                    <span>First seen: <strong>{formatDate(err.first_seen)}</strong></span>
                    <span>Last seen: <strong>{formatDate(err.last_seen)}</strong></span>
                    <span>Files: <strong>{err.file_paths.join(", ")}</strong></span>
                  </div>
                </div>
                <button class="btn-view" onclick={() => { if (err.latest_test_id) modalTestId = err.latest_test_id; }}>
                  View latest failure
                </button>
              </div>

              <div class="affected-tests-section">
                <h4>Affected Tests ({affectedTests.length})</h4>
                {#if testsLoading}
                  <p class="muted">Loading...</p>
                {:else if affectedTests.length === 0}
                  <p class="muted">No tests found.</p>
                {:else}
                  <div class="affected-tests-list">
                    {#each affectedTests as at}
                      <button class="affected-test" onclick={() => { modalTestId = at.latest_test_id; }}>
                        <span class="at-title">{at.full_title}</span>
                        <span class="at-meta">
                          <span class="at-file">{at.file_path}</span>
                          <span class="at-count">{at.occurrence_count}x</span>
                          <span class="at-time">{timeAgo(at.last_seen)}</span>
                        </span>
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>

              <div class="notes-section">
                <h4>Notes ({notes.length})</h4>
                {#if notesLoading}
                  <p class="muted">Loading...</p>
                {:else if notes.length === 0}
                  <p class="muted">No notes yet. Add one to start a discussion.</p>
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
                <form class="note-form" onsubmit={(e) => { e.preventDefault(); submitNote(err.fingerprint); }}>
                  <input type="text" bind:value={newNote} placeholder="Add a note..." />
                  <button type="submit" class="btn-primary" disabled={!newNote.trim()}>Post</button>
                </form>
              </div>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<ErrorModal testId={modalTestId} onclose={() => modalTestId = null} />

<style>
  .page { max-width: 1100px; padding: 2rem; }

  .header {
    display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1.5rem;
  }
  .description { margin: 0.25rem 0 0; color: var(--text-secondary); font-size: 0.875rem; }

  .filters { display: flex; gap: 0.5rem; flex-shrink: 0; }
  select {
    padding: 0.35rem 0.6rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--text); font-size: 0.85rem;
  }

  .status-text { color: var(--text-secondary); }
  .status-text.error { color: var(--color-fail); }

  .empty { padding: 3rem 0; text-align: center; color: var(--text-secondary); }
  .hint { font-size: 0.875rem; color: var(--text-muted); }

  .error-list { display: flex; flex-direction: column; gap: 0.5rem; }

  .error-card {
    background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
    overflow: hidden; transition: border-color 0.1s;
  }
  .error-card:hover, .error-card.expanded { border-color: color-mix(in srgb, var(--color-fail) 50%, var(--border)); }

  .error-header {
    display: flex; flex-direction: column; gap: 0.4rem; width: 100%; padding: 0.75rem 1rem;
    cursor: pointer; text-align: left; color: var(--text); font: inherit; background: none; border: none;
  }

  .error-main { display: flex; align-items: flex-start; gap: 0.75rem; }
  .error-count {
    font-weight: 700; font-size: 0.85rem; color: var(--color-fail); min-width: 2.5rem;
    padding-top: 0.1rem; text-align: right;
  }
  .error-info { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; flex: 1; }
  .error-title-row { display: flex; align-items: center; gap: 0.5rem; }
  .error-message-primary {
    font-weight: 500; font-size: 0.85rem; color: var(--color-fail);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .error-tests-summary { font-size: 0.78rem; color: var(--text-secondary); }

  .status-badge {
    padding: 0.15rem 0.45rem; border-radius: 8px; font-size: 0.65rem; font-weight: 600;
    color: #fff; flex-shrink: 0; text-transform: uppercase; letter-spacing: 0.02em;
  }

  .error-meta {
    display: flex; gap: 0.35rem; padding-left: 3.25rem;
    font-size: 0.75rem; color: var(--text-muted); flex-wrap: wrap;
  }
  .meta-sep { color: var(--border); }
  .notes-count { color: var(--link); }

  /* Expanded detail */
  .error-detail {
    border-top: 1px solid var(--border); padding: 1rem; background: var(--bg-secondary);
  }
  .detail-row {
    display: flex; gap: 1.5rem; flex-wrap: wrap; align-items: flex-start; margin-bottom: 1rem;
  }
  .detail-section h4 { margin: 0 0 0.4rem; font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }

  .status-controls { display: flex; gap: 0.25rem; flex-wrap: wrap; }
  .status-btn {
    padding: 0.25rem 0.5rem; border: 1px solid var(--border); border-radius: 4px;
    background: var(--bg); color: var(--text-secondary); font-size: 0.72rem; cursor: pointer;
  }
  .status-btn:hover { border-color: var(--status-color); color: var(--status-color); }
  .status-btn.active { background: var(--status-color); color: #fff; border-color: var(--status-color); }

  .detail-facts { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.78rem; color: var(--text-secondary); }
  .detail-facts strong { color: var(--text); }

  .btn-view {
    padding: 0.4rem 0.75rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--link); font-size: 0.78rem; font-weight: 500;
    cursor: pointer; align-self: flex-start; margin-top: 1.1rem;
  }
  .btn-view:hover { background: var(--bg-hover); }

  /* Affected tests */
  .affected-tests-section { border-top: 1px solid var(--border); padding-top: 0.75rem; margin-bottom: 0.75rem; }
  .affected-tests-section h4 { margin: 0 0 0.5rem; font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .affected-tests-list { display: flex; flex-direction: column; gap: 0.25rem; }
  .affected-test {
    display: flex; flex-direction: column; gap: 0.1rem;
    padding: 0.4rem 0.6rem; background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    cursor: pointer; text-align: left; font: inherit; color: var(--text); width: 100%;
  }
  .affected-test:hover { background: var(--bg-hover); border-color: var(--link); }
  .at-title { font-size: 0.82rem; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .at-meta { display: flex; gap: 0.75rem; font-size: 0.72rem; color: var(--text-muted); }
  .at-file { font-family: monospace; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .at-count { font-weight: 600; color: var(--color-fail); }

  /* Notes */
  .notes-section { border-top: 1px solid var(--border); padding-top: 0.75rem; }
  .notes-section h4 { margin: 0 0 0.5rem; font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .muted { color: var(--text-muted); font-size: 0.8rem; margin: 0 0 0.5rem; }

  .notes-list { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 0.75rem; }
  .note {
    padding: 0.5rem 0.65rem; background: var(--bg); border-radius: 6px; border: 1px solid var(--border);
  }
  .note-header { display: flex; justify-content: space-between; margin-bottom: 0.2rem; }
  .note-author { font-size: 0.78rem; font-weight: 600; color: var(--text); }
  .note-time { font-size: 0.7rem; color: var(--text-muted); }
  .note-body { margin: 0; font-size: 0.82rem; color: var(--text-secondary); white-space: pre-wrap; }

  .note-form { display: flex; gap: 0.4rem; }
  .note-form input {
    flex: 1; padding: 0.4rem 0.6rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--text); font-size: 0.82rem; outline: none;
  }
  .note-form input:focus { border-color: var(--link); }
  .note-form input::placeholder { color: var(--text-muted); }
  .btn-primary {
    padding: 0.4rem 0.75rem; border: none; border-radius: 6px; background: var(--link);
    color: #fff; font-size: 0.78rem; font-weight: 600; cursor: pointer;
  }
  .btn-primary:hover { opacity: 0.9; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
