<script lang="ts">
  // Admin audit-export (SIEM) configuration — Phase 16. Owner/admin only; the
  // mutating controls are gated and viewers see a read-only notice. Backed by
  // GET/POST/PATCH/DELETE /audit/export + /audit/export/:id/test. The feature is
  // off by default behind FLAKEY_AUDIT_EXPORT_ENABLED — when off, the list call
  // 404s and we render an explanatory disabled state (same as the SSO page).
  //
  // Auth tokens are write-only: the API returns auth_token_set (a boolean), never
  // the token, so the form's token field starts blank and a blank value means
  // "leave the stored token untouched". This mirrors settings/sso/+page.svelte.
  import { onMount } from "svelte";
  import { getAuth } from "$lib/stores/auth";
  import { toast, toastError } from "$lib/stores/toast";
  import StatusDot from "$lib/components/status/StatusDot.svelte";
  import {
    listAuditExportConfigs,
    createAuditExportConfig,
    updateAuditExportConfig,
    deleteAuditExportConfig,
    testAuditExportConfig,
    AuditExportDisabledError,
    type AuditExportConfig,
  } from "$lib/api";
  import {
    emptyDraft,
    draftFromConfig,
    validateDraft,
    draftToCreateBody,
    draftToUpdateBody,
    exportHealth,
    exportHealthLabel,
    destinationSummary,
    type ExportDraft,
    type ExportHealth,
  } from "$lib/utils/audit-export";

  const auth = getAuth();
  const isAdmin = auth.user?.orgRole === "owner" || auth.user?.orgRole === "admin";

  let loading = $state(true);
  let disabled = $state(false); // instance kill-switch is off
  let ready = $state(false);
  let configs = $state<AuditExportConfig[]>([]);

  // Editor state. editingId === null means "creating new"; undefined means the
  // editor is closed.
  let editingId = $state<number | null | undefined>(undefined);
  let draft = $state<ExportDraft>(emptyDraft());
  let saving = $state(false);
  let testingId = $state<number | null>(null);

  let draftError = $derived(editingId === undefined ? null : validateDraft(draft));

  // StatusDot only knows a fixed status vocabulary; map our health states onto
  // it (ok→pass, failing→fail, idle→running pulse-ish, disabled→aborted/grey).
  function healthDot(h: ExportHealth): "pass" | "fail" | "running" | "aborted" {
    switch (h) {
      case "ok":
        return "pass";
      case "failing":
        return "fail";
      case "idle":
        return "running";
      case "disabled":
        return "aborted";
    }
  }

  async function load() {
    loading = true;
    try {
      configs = await listAuditExportConfigs();
    } catch (e) {
      if (e instanceof AuditExportDisabledError) {
        disabled = true;
      } else {
        toastError(e instanceof Error ? e.message : "Failed to load audit export config");
      }
    } finally {
      loading = false;
      ready = true;
    }
  }

  function openCreate() {
    editingId = null;
    draft = emptyDraft("http");
  }
  function openEdit(c: AuditExportConfig) {
    editingId = c.id;
    draft = draftFromConfig(c);
  }
  function closeEditor() {
    editingId = undefined;
  }

  async function save() {
    if (draftError) {
      toastError(draftError);
      return;
    }
    saving = true;
    try {
      if (editingId === null) {
        const created = await createAuditExportConfig(draftToCreateBody(draft));
        configs = [...configs, created];
        toast("Export destination created");
      } else if (editingId != null) {
        const updated = await updateAuditExportConfig(editingId, draftToUpdateBody(draft));
        configs = configs.map((c) => (c.id === updated.id ? updated : c));
        toast("Export destination updated");
      }
      closeEditor();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Save failed");
    } finally {
      saving = false;
    }
  }

  async function toggleEnabled(c: AuditExportConfig) {
    try {
      const updated = await updateAuditExportConfig(c.id, { enabled: !c.enabled });
      configs = configs.map((x) => (x.id === updated.id ? updated : x));
      toast(updated.enabled ? "Export enabled" : "Export disabled");
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Failed to update");
    }
  }

  async function remove(c: AuditExportConfig) {
    if (!confirm(`Delete the ${c.destination.toUpperCase()} export destination? Streaming to it stops immediately.`)) {
      return;
    }
    try {
      await deleteAuditExportConfig(c.id);
      configs = configs.filter((x) => x.id !== c.id);
      if (editingId === c.id) closeEditor();
      toast("Export destination deleted");
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Failed to delete");
    }
  }

  async function runTest(c: AuditExportConfig) {
    testingId = c.id;
    try {
      const result = await testAuditExportConfig(c.id);
      if (result.ok) {
        toast("Test delivery succeeded");
      } else {
        toastError(`Test delivery failed: ${result.error ?? "unknown error"}`);
      }
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Test failed");
    } finally {
      testingId = null;
    }
  }

  function fmtDate(iso: string | null): string {
    if (!iso) return "never";
    const d = new Date(iso);
    return isNaN(d.getTime()) ? "—" : d.toLocaleString();
  }

  onMount(load);
</script>

<div class="audit-export" data-ready={ready}>
  <h1>Audit export (SIEM streaming)</h1>

  {#if loading}
    <p class="muted">Loading…</p>
  {:else if disabled}
    <p class="muted">
      Audit export is not enabled on this Flakey instance. An operator must set
      <code>FLAKEY_AUDIT_EXPORT_ENABLED=true</code> on the backend. This is a
      GovRAMP-scoped logging control — enabling it in a regulated environment
      needs CISO / Security Analyst sign-off.
    </p>
  {:else if !isAdmin}
    <p class="muted">Only organization owners and admins can manage audit export.</p>
  {:else}
    <p class="muted">
      Stream this organization's audit events to your SIEM (HTTP — Splunk HEC,
      Datadog, Sumo, …) or an S3 archive, as gap-free NDJSON. Each event carries
      its tamper-evidence hash so the receiver can independently verify the
      chain. Delivery is durable: a receiver outage stalls the cursor and resumes
      on recovery — nothing is dropped.
    </p>

    <section class="destinations">
      {#if configs.length === 0}
        <p class="muted empty">No export destinations configured yet.</p>
      {:else}
        <ul class="dest-list">
          {#each configs as c (c.id)}
            {@const health = exportHealth(c)}
            <li class="dest-row">
              <div class="dest-main">
                <span class="dest-status" title={exportHealthLabel(health)}>
                  <StatusDot status={healthDot(health)} />
                </span>
                <div class="dest-info">
                  <div class="dest-line">
                    <span class="dest-kind">{c.destination === "http" ? "HTTP" : "S3"}</span>
                    <code class="dest-target">{destinationSummary(c)}</code>
                  </div>
                  <div class="dest-meta">
                    <span>{exportHealthLabel(health)}</span>
                    <span>· last success {fmtDate(c.last_success_at)}</span>
                    {#if c.consecutive_failures > 0}
                      <span class="meta-fail">· {c.consecutive_failures} consecutive failure{c.consecutive_failures === 1 ? "" : "s"}</span>
                    {/if}
                    {#if c.last_error}
                      <span class="meta-fail" title="Sanitized — never the upstream body, URL, or token">· {c.last_error}</span>
                    {/if}
                    {#if c.destination === "http" && c.auth_token_set}
                      <span>· auth token set</span>
                    {/if}
                  </div>
                </div>
              </div>
              <div class="dest-actions">
                <button class="link-btn" onclick={() => runTest(c)} disabled={testingId === c.id}>
                  {testingId === c.id ? "Testing…" : "Test"}
                </button>
                <button class="link-btn" onclick={() => toggleEnabled(c)}>
                  {c.enabled ? "Disable" : "Enable"}
                </button>
                <button class="link-btn" onclick={() => openEdit(c)}>Edit</button>
                <button class="link-btn danger" onclick={() => remove(c)}>Delete</button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}

      {#if editingId === undefined}
        <button class="submit-btn" onclick={openCreate}>Add export destination</button>
      {/if}
    </section>

    {#if editingId !== undefined}
      <section class="editor">
        <h2>{editingId === null ? "New export destination" : "Edit export destination"}</h2>
        <form onsubmit={(e) => { e.preventDefault(); save(); }}>
          <label class="field">
            <span>Destination type{#if editingId !== null}<em> (type can't be changed — delete &amp; recreate)</em>{/if}</span>
            <select bind:value={draft.destination} disabled={editingId !== null}>
              <option value="http">HTTP (customer SIEM)</option>
              <option value="s3">S3 (archive)</option>
            </select>
          </label>

          {#if draft.destination === "http"}
            <label class="field">
              <span>Endpoint URL</span>
              <input
                type="url"
                bind:value={draft.endpointUrl}
                placeholder="https://http-inputs.example.splunkcloud.com/services/collector/raw"
              />
            </label>
            <label class="field">
              <span>Auth header name — optional</span>
              <input type="text" bind:value={draft.authHeaderName} placeholder="Authorization" />
            </label>
            <label class="field">
              <span>
                Auth token — optional
                {#if editingId !== null}<em>(stored — leave blank to keep)</em>{/if}
              </span>
              <input
                type="password"
                bind:value={draft.authToken}
                placeholder={editingId !== null ? "••••••••" : "Splunk <hec-token>"}
                autocomplete="new-password"
              />
            </label>
          {:else}
            <label class="field">
              <span>S3 bucket</span>
              <input type="text" bind:value={draft.s3Bucket} placeholder="acme-audit-archive" />
            </label>
            <label class="field">
              <span>S3 prefix — optional</span>
              <input type="text" bind:value={draft.s3Prefix} placeholder="flakey/audit" />
            </label>
            <p class="muted small">
              S3 uses the instance's configured S3 client (region/endpoint + the
              standard AWS credential chain) — the same config as the artifact store.
            </p>
          {/if}

          <label class="check">
            <input type="checkbox" bind:checked={draft.enabled} /> Enabled (start streaming)
          </label>

          {#if editingId === null}
            <label class="check" title="By default a new destination starts from the current point so a large existing audit log isn't dumped in one go.">
              <input type="checkbox" bind:checked={draft.fromBeginning} /> Stream full history from the beginning
            </label>
          {/if}

          {#if draftError}
            <p class="field-error" role="alert">{draftError}</p>
          {/if}

          <div class="editor-actions">
            <button type="submit" class="submit-btn" disabled={saving || !!draftError}>
              {saving ? "Saving…" : editingId === null ? "Create destination" : "Save changes"}
            </button>
            <button type="button" class="link-btn" onclick={closeEditor}>Cancel</button>
          </div>
        </form>
      </section>
    {/if}
  {/if}
</div>

<style>
  .audit-export { max-width: 720px; padding: 1.5rem; }
  h1 { font-size: 1.35rem; margin: 0 0 0.5rem; }
  h2 { font-size: 1.1rem; margin: 0 0 0.75rem; }
  .muted { color: var(--text-muted); font-size: 0.9rem; line-height: 1.5; }
  .muted.small { font-size: 0.8rem; }
  .empty { margin: 1rem 0; }
  .destinations { margin-top: 1.5rem; }
  .dest-list { list-style: none; margin: 0 0 1rem; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .dest-row {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem;
    padding: 0.75rem 0.9rem; border: 1px solid var(--border); border-radius: 8px; background: var(--bg);
  }
  .dest-main { display: flex; gap: 0.6rem; align-items: flex-start; min-width: 0; }
  .dest-status { padding-top: 0.2rem; }
  .dest-info { min-width: 0; }
  .dest-line { display: flex; align-items: baseline; gap: 0.5rem; }
  .dest-kind {
    font-size: 0.7rem; font-weight: 700; letter-spacing: 0.04em; color: var(--text-secondary);
    background: var(--bg-secondary); padding: 0.1rem 0.4rem; border-radius: 4px;
  }
  .dest-target { font-size: 0.85rem; word-break: break-all; color: var(--text); }
  .dest-meta { font-size: 0.78rem; color: var(--text-muted); margin-top: 0.25rem; display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .meta-fail { color: var(--error-text); }
  .dest-actions { display: flex; gap: 0.75rem; flex-shrink: 0; }
  .editor { margin-top: 1.5rem; padding-top: 1.5rem; border-top: 1px solid var(--border); }
  form { display: flex; flex-direction: column; gap: 1rem; }
  .field { display: flex; flex-direction: column; gap: 0.3rem; }
  .field span { font-size: 0.8rem; font-weight: 500; color: var(--text-secondary); }
  .field em { color: var(--text-muted); font-weight: 400; font-style: italic; }
  .field input, .field select {
    padding: 0.5rem 0.7rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--text); font-size: 0.875rem; font-family: inherit;
  }
  .field input:disabled, .field select:disabled { opacity: 0.6; cursor: not-allowed; }
  .field-error { color: var(--error-text); font-size: 0.82rem; margin: 0; }
  .check { display: flex; align-items: center; gap: 0.5rem; font-size: 0.875rem; color: var(--text); }
  .editor-actions { display: flex; align-items: center; gap: 1rem; }
  .submit-btn {
    align-self: flex-start; padding: 0.55rem 1rem; border: none; border-radius: 6px;
    background: var(--link); color: #fff; font-weight: 600; cursor: pointer; font-size: 0.875rem;
  }
  .submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .link-btn { background: none; border: none; color: var(--link); cursor: pointer; font-size: 0.85rem; padding: 0; }
  .link-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .link-btn.danger { color: var(--error-text); }
</style>
