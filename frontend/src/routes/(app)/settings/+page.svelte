<script lang="ts">
  import { onMount } from "svelte";
  import { getAuth, subscribe } from "$lib/stores/auth";
  import { authFetch } from "$lib/stores/auth";
  import { toast, toastError } from "$lib/stores/toast";
  import { API_URL as apiUrl } from "$lib/utils/config";

  // Reactive auth state — re-reads after refresh or org switch so that
  // orgId, isOwner, and isAdmin never go stale.
  let authState = $state(getAuth());
  subscribe(() => { authState = getAuth(); });
  let orgId = $derived(authState.user?.orgId);

  // --- Connectivity tests ---
  interface TestResult { ok: boolean; [key: string]: unknown }
  let dbTest = $state<TestResult | null>(null);
  let dbTesting = $state(false);
  let emailTest = $state<TestResult | null>(null);
  let emailTesting = $state(false);
  let gitTest = $state<TestResult | null>(null);
  let gitTesting = $state(false);
  let aiTest = $state<TestResult | null>(null);
  let aiTesting = $state(false);
  let aiStatus = $state<{ enabled: boolean } | null>(null);

  async function testDB() {
    dbTesting = true; dbTest = null;
    try { const r = await authFetch(`${apiUrl}/connectivity/database`, { method: "POST" }); dbTest = await r.json(); } catch { dbTest = { ok: false, error: "Request failed" }; }
    dbTesting = false;
  }
  async function testEmail() {
    emailTesting = true; emailTest = null;
    try { const r = await authFetch(`${apiUrl}/connectivity/email`, { method: "POST" }); emailTest = await r.json(); } catch { emailTest = { ok: false, error: "Request failed" }; }
    emailTesting = false;
  }
  async function testGit() {
    gitTesting = true; gitTest = null;
    try { const r = await authFetch(`${apiUrl}/connectivity/git`, { method: "POST" }); gitTest = await r.json(); } catch { gitTest = { ok: false, error: "Request failed" }; }
    gitTesting = false;
  }
  async function testAI() {
    aiTesting = true; aiTest = null;
    try { const r = await authFetch(`${apiUrl}/analyze/test-connection`, { method: "POST" }); aiTest = await r.json(); } catch { aiTest = { ok: false, error: "Request failed" }; }
    aiTesting = false;
  }
  async function loadAIStatus() {
    const res = await authFetch(`${apiUrl}/analyze/status`);
    if (res.ok) aiStatus = await res.json();
  }

  // --- API Keys ---
  interface ApiKey { id: number; key_prefix: string; label: string; last_used_at: string | null; created_at: string; }
  let apiKeys = $state<ApiKey[]>([]);
  let newKeyLabel = $state("");
  let newKeyValue = $state<string | null>(null);
  let keysLoading = $state(true);
  let saving = $state(false);

  async function loadKeys() {
    keysLoading = true;
    const res = await authFetch(`${apiUrl}/auth/api-keys`);
    if (res.ok) apiKeys = await res.json();
    keysLoading = false;
  }
  async function createKey() {
    saving = true;
    const res = await authFetch(`${apiUrl}/auth/api-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: newKeyLabel || "Untitled key" }),
    });
    if (res.ok) {
      const data = await res.json();
      newKeyValue = data.key;
      newKeyLabel = "";
      loadKeys();
      toast("API key created");
    } else {
      toastError("Failed to create API key");
    }
    saving = false;
  }
  async function deleteKey(id: number, label: string) {
    const ok = await openConfirm({
      title: 'Revoke API key?',
      message: `Revoke "${label}"? Any client using this key will start getting 401s immediately.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    const res = await authFetch(`${apiUrl}/auth/api-keys/${id}`, { method: "DELETE" });
    if (res.ok) { toast("API key deleted"); loadKeys(); }
    else toastError("Failed to delete API key");
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

  function inviteUrl(token: string): string { return `${window.location.origin}/invite/${token}`; }
  async function copyInviteLink() {
    if (!inviteResult) return;
    await navigator.clipboard.writeText(inviteUrl(inviteResult.invite_token));
    copied = true; setTimeout(() => copied = false, 2000);
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
    const res = await authFetch(`${apiUrl}/orgs/${orgId}/invites`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: inviteEmail, role: inviteRole }) });
    if (res.ok) { inviteResult = await res.json(); inviteEmail = ""; toast("Invite created"); }
    else { const b = await res.json().catch(() => ({})); inviteError = (b as any).error ?? "Failed"; toastError(inviteError!); }
  }
  async function changeRole(userId: number, role: string) {
    const res = await authFetch(`${apiUrl}/orgs/${orgId}/members/${userId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role }) });
    if (res.ok) { toast("Role updated"); loadMembers(); }
    else toastError("Failed to update role");
  }
  async function removeMember(userId: number, name: string) {
    const ok = await openConfirm({
      title: 'Remove member?',
      message: `Remove ${name} from this organization? They'll lose access immediately.`,
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (!ok) return;
    await authFetch(`${apiUrl}/orgs/${orgId}/members/${userId}`, { method: "DELETE" });
    loadMembers();
  }

  // --- Suites ---
  interface Suite { suite_name: string; run_count: number; last_run: string; archived: boolean; rerun_command_template: string | null; }
  let suites = $state<Suite[]>([]);
  let suitesLoading = $state(true);
  let renamingId = $state<string | null>(null);
  let renameValue = $state("");
  let editingTemplateId = $state<string | null>(null);
  let templateValue = $state("");

  // Client-side pagination for Suites — keep the section responsive
  // when an org has dozens of suites accumulated over time. Page size
  // 25 matches the Audit log default below.
  const SUITES_PAGE_SIZE = 25;
  let suitesVisible = $state(SUITES_PAGE_SIZE);
  const visibleSuites = $derived(suites.slice(0, suitesVisible));
  const hasMoreSuites = $derived(visibleSuites.length < suites.length);
  function loadMoreSuites() {
    suitesVisible = Math.min(suitesVisible + SUITES_PAGE_SIZE, suites.length);
  }

  async function loadSuites() {
    suitesLoading = true;
    const res = await authFetch(`${apiUrl}/suites`);
    if (res.ok) suites = await res.json();
    suitesLoading = false;
  }
  async function renameSuite(oldName: string) {
    if (!renameValue || renameValue === oldName) { renamingId = null; return; }
    const res = await authFetch(`${apiUrl}/suites/${encodeURIComponent(oldName)}/rename`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ new_name: renameValue }) });
    renamingId = null;
    if (res.ok) { toast("Suite renamed"); loadSuites(); }
    else toastError("Failed to rename suite");
  }
  async function toggleArchive(name: string, archived: boolean) {
    const res = await authFetch(`${apiUrl}/suites/${encodeURIComponent(name)}/archive`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ archived: !archived }) });
    if (res.ok) { toast(archived ? "Suite unarchived" : "Suite archived"); loadSuites(); }
    else toastError("Failed to update suite");
  }
  async function deleteSuite(name: string) {
    const ok = await openConfirm({
      title: 'Delete suite?',
      message: `Delete suite "${name}" and all its runs? This cannot be undone.`,
      confirmLabel: 'Delete suite',
      tone: 'danger',
    });
    if (!ok) return;
    const res = await authFetch(`${apiUrl}/suites/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (res.ok) { toast("Suite deleted"); loadSuites(); }
    else toastError("Failed to delete suite");
  }
  async function saveRerunTemplate(suiteName: string) {
    const res = await authFetch(`${apiUrl}/suites/${encodeURIComponent(suiteName)}/rerun-template`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ template: templateValue }),
    });
    editingTemplateId = null;
    if (res.ok) { toast("Rerun template saved"); loadSuites(); }
    else toastError("Failed to save rerun template");
  }

  // --- Webhooks ---
  interface Webhook { id: number; name: string; url: string; events: string[]; active: boolean; platform: string; }
  let webhooks = $state<Webhook[]>([]);
  let webhooksLoading = $state(true);
  let newWhName = $state("");
  let newWhUrl = $state("");
  let newWhEvents = $state<string[]>(["run.failed"]);
  let newWhPlatform = $state("generic");
  let whTestResult = $state<{ id: number; ok: boolean } | null>(null);

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
    saving = true;
    const res = await authFetch(`${apiUrl}/webhooks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: newWhName, url: newWhUrl, events: newWhEvents, platform: newWhPlatform }) });
    if (res.ok) { toast("Webhook created"); newWhName = ""; newWhUrl = ""; newWhEvents = ["run.failed"]; newWhPlatform = "generic"; loadWebhooks(); }
    else toastError("Failed to create webhook");
    saving = false;
  }
  async function toggleWebhook(id: number, active: boolean) {
    const res = await authFetch(`${apiUrl}/webhooks/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active: !active }) });
    if (res.ok) { toast(active ? "Webhook disabled" : "Webhook enabled"); loadWebhooks(); }
    else toastError("Failed to update webhook");
  }
  async function deleteWebhook(id: number) {
    const res = await authFetch(`${apiUrl}/webhooks/${id}`, { method: "DELETE" });
    if (res.ok) { toast("Webhook deleted"); loadWebhooks(); }
    else toastError("Failed to delete webhook");
  }
  async function testWebhook(id: number) {
    whTestResult = null;
    const res = await authFetch(`${apiUrl}/webhooks/${id}/test`, { method: "POST" });
    const data = await res.json();
    whTestResult = { id, ok: data.ok };
    setTimeout(() => { if (whTestResult?.id === id) whTestResult = null; }, 3000);
  }

  // --- Git Integration ---
  let gitProvider = $state("");
  let gitRepo = $state("");
  let gitToken = $state("");
  let gitBaseUrl = $state("");
  let hasGitToken = $state(false);
  let gitSaved = $state(false);
  let gitError = $state<string | null>(null);

  const gitPlatforms = [
    { value: "github", label: "GitHub", repoPlaceholder: "owner/repo", tokenLabel: "GitHub token (PAT or fine-grained)", tokenUrl: "https://github.com/settings/tokens", scope: "repo scope" },
    { value: "gitlab", label: "GitLab", repoPlaceholder: "group/project", tokenLabel: "GitLab personal access token", tokenUrl: "https://gitlab.com/-/user_settings/personal_access_tokens", scope: "api scope" },
    { value: "bitbucket", label: "Bitbucket", repoPlaceholder: "workspace/repo", tokenLabel: "Bitbucket app password", tokenUrl: "https://bitbucket.org/account/settings/app-passwords/", scope: "Pull requests: read+write" },
  ];
  let activePlatform = $derived(gitPlatforms.find(p => p.value === gitProvider) ?? gitPlatforms[0]);

  async function loadGitProvider() {
    const res = await authFetch(`${apiUrl}/orgs/${orgId}/settings`);
    if (res.ok) {
      const data = await res.json();
      gitProvider = data.git_provider ?? ""; gitRepo = data.git_repo ?? "";
      gitBaseUrl = data.git_base_url ?? ""; hasGitToken = data.has_git_token ?? false;
    }
  }
  async function saveGitProvider() {
    gitError = null;
    if (!gitProvider) { gitError = "Select a platform"; return; }
    if (gitRepo && gitProvider !== "gitlab" && !/^[^/]+\/[^/]+$/.test(gitRepo)) { gitError = "Format: owner/repo"; return; }
    const body: Record<string, string | null> = { git_provider: gitProvider, git_repo: gitRepo || null, git_base_url: gitBaseUrl || null };
    if (gitToken) body.git_token = gitToken;
    const res = await authFetch(`${apiUrl}/orgs/${orgId}/settings`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) { toast("Git integration saved"); gitSaved = true; gitToken = ""; hasGitToken = !!body.git_token || hasGitToken; setTimeout(() => gitSaved = false, 2000); }
    else toastError("Failed to save git integration");
  }
  async function removeGitProvider() {
    const res = await authFetch(`${apiUrl}/orgs/${orgId}/settings`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ git_provider: null, git_token: null, git_repo: null, git_base_url: null }) });
    if (res.ok) { toast("Git integration removed"); gitProvider = ""; gitRepo = ""; gitToken = ""; gitBaseUrl = ""; hasGitToken = false; }
    else toastError("Failed to remove git integration");
  }

  // --- Retention ---
  let retentionDays = $state<string>("");
  let retentionSaved = $state(false);

  async function loadRetention() {
    const res = await authFetch(`${apiUrl}/orgs/${orgId}/settings`);
    if (res.ok) { const data = await res.json(); retentionDays = data.retention_days != null ? String(data.retention_days) : ""; }
  }
  async function saveRetention() {
    const value = retentionDays === "" ? null : Number(retentionDays);
    const res = await authFetch(`${apiUrl}/orgs/${orgId}/settings`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ retention_days: value }) });
    if (res.ok) { toast("Retention settings saved"); retentionSaved = true; setTimeout(() => retentionSaved = false, 2000); }
    else toastError("Failed to save retention settings");
  }

  // --- Audit ---
  interface AuditEntry { id: number; action: string; target_type: string; target_id: string; detail: any; created_at: string; user_email: string; user_name: string; }
  let auditLog = $state<AuditEntry[]>([]);
  let auditLoading = $state(true);

  async function loadAudit() {
    auditLoading = true;
    // Pull up to 200 entries; the section paginates 25 at a time
    // client-side so a huge audit log doesn't slow the page.
    const res = await authFetch(`${apiUrl}/audit?limit=200`);
    if (res.ok) auditLog = await res.json();
    auditLoading = false;
  }

  const AUDIT_PAGE_SIZE = 25;
  let auditVisible = $state(AUDIT_PAGE_SIZE);
  const visibleAudit = $derived(auditLog.slice(0, auditVisible));
  const hasMoreAudit = $derived(visibleAudit.length < auditLog.length);
  function loadMoreAudit() {
    auditVisible = Math.min(auditVisible + AUDIT_PAGE_SIZE, auditLog.length);
  }

  // --- Confirm modal (replaces window.confirm) ---
  interface ConfirmState {
    title: string;
    message: string;
    confirmLabel: string;
    tone: 'default' | 'danger';
    resolve: (result: boolean) => void;
  }
  let confirmState = $state<ConfirmState | null>(null);

  function openConfirm(opts: {
    title: string;
    message: string;
    confirmLabel?: string;
    tone?: 'default' | 'danger';
  }): Promise<boolean> {
    return new Promise((resolve) => {
      confirmState = {
        title: opts.title,
        message: opts.message,
        confirmLabel: opts.confirmLabel ?? 'Confirm',
        tone: opts.tone ?? 'default',
        resolve,
      };
    });
  }

  function resolveConfirm(result: boolean) {
    if (!confirmState) return;
    const { resolve } = confirmState;
    confirmState = null;
    resolve(result);
  }

  function handleEsc(e: KeyboardEvent) {
    if (e.key === "Escape" && confirmState) resolveConfirm(false);
  }

  // --- Helpers ---
  let isOwner = $derived(authState.user?.orgRole === "owner");
  let isAdmin = $derived(authState.user?.orgRole === "admin" || isOwner);

  function timeAgo(iso: string): string {
    if (!iso) return "never";
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }
  function absoluteDate(iso: string): string {
    if (!iso) return "";
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }
  function formatAction(a: string): string {
    return a.replace(".", " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // --- Sub-nav state ---
  // Section anchors. The same list drives both the sidebar links and
  // the scroll-spy that highlights the active section. Admin-only
  // sections are filtered out for non-admins.
  interface NavItem { id: string; label: string; adminOnly?: boolean; }
  const navItems: NavItem[] = [
    { id: 'connections', label: 'Connections' },
    { id: 'team', label: 'Team' },
    { id: 'suites', label: 'Suites', adminOnly: true },
    { id: 'notifications', label: 'Notifications', adminOnly: true },
    { id: 'pr-comments', label: 'PR comments', adminOnly: true },
    { id: 'retention', label: 'Data retention', adminOnly: true },
    { id: 'api-keys', label: 'API keys' },
    { id: 'api-endpoint', label: 'API endpoint' },
    { id: 'audit-log', label: 'Audit log', adminOnly: true },
  ];
  let visibleNav = $derived(navItems.filter(n => !n.adminOnly || isAdmin));

  let activeSection = $state('connections');

  function jumpTo(id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    activeSection = id;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Scroll-spy: pick the section closest to the viewport top.
  function updateActiveSection() {
    const headerOffset = 120;
    let best: string = visibleNav[0]?.id ?? 'connections';
    let bestDist = Infinity;
    for (const n of visibleNav) {
      const el = document.getElementById(n.id);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const dist = Math.abs(rect.top - headerOffset);
      if (rect.top - headerOffset <= 0 && dist < bestDist) {
        best = n.id; bestDist = dist;
      }
    }
    activeSection = best;
  }

  onMount(() => {
    loadMembers(); loadSuites(); loadKeys(); loadRetention(); loadAIStatus();
    if (isAdmin) { loadWebhooks(); loadGitProvider(); loadAudit(); }

    const onScroll = () => updateActiveSection();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  });

  // Preserve Suites + Audit pagination depth, the active sub-nav
  // section, and scroll position across back/forward navigation.
  export const snapshot = {
    capture: () => ({
      suitesVisible,
      auditVisible,
      activeSection,
      scrollY: typeof window !== "undefined" ? window.scrollY : 0,
    }),
    restore: (s: { suitesVisible: number; auditVisible: number; activeSection: string; scrollY: number }) => {
      suitesVisible = s.suitesVisible;
      auditVisible = s.auditVisible;
      activeSection = s.activeSection;
      queueMicrotask(() => window.scrollTo({ top: s.scrollY, behavior: "instant" as ScrollBehavior }));
    },
  };
</script>

<svelte:window onkeydown={handleEsc} />

<div class="page">
  <h1 class="page-title sr-only">Settings</h1>

  <div class="settings-layout">
    <!-- Sub-nav sidebar — sticky on desktop, scroll-spy highlights the active section. -->
    <aside class="subnav" aria-label="Settings sections">
      <nav>
        {#each visibleNav as item}
          <a
            href={`#${item.id}`}
            class="subnav-link"
            class:active={activeSection === item.id}
            onclick={(e) => { e.preventDefault(); jumpTo(item.id); }}
          >{item.label}</a>
        {/each}
        <a class="subnav-link external" href="/settings/integrations">
          Integrations &amp; automation
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 3h7v7M13 3L4 12"/></svg>
        </a>
      </nav>
    </aside>

    <div class="settings-content">
      <!-- ═══ Connections ═══ -->
      <section id="connections" class="settings-section">
        <header class="section-header">
          <div>
            <h2 class="section-title">Connections</h2>
            <p class="section-subtitle">External services Flakey relies on. Run a test to verify each is reachable.</p>
          </div>
        </header>

        <div class="conn-grid">
          <!-- Database -->
          <div class="conn-card">
            <div class="conn-header">
              <span class="conn-dot ok"></span>
              <h3>Database</h3>
            </div>
            <p class="conn-desc">PostgreSQL connection for storing test results.</p>
            <button class="btn-test" onclick={testDB} disabled={dbTesting}>
              {dbTesting ? "Testing..." : "Test connection"}
            </button>
            {#if dbTest}
              <div class="conn-result" class:ok={dbTest.ok} class:fail={!dbTest.ok}>
                {#if dbTest.ok}
                  {dbTest.version} &middot; {dbTest.database} &middot; {dbTest.size_mb}MB &middot; {dbTest.latency_ms}ms
                {:else}
                  {dbTest.error}
                {/if}
              </div>
            {/if}
          </div>

          <!-- Git Provider -->
          <div class="conn-card">
            <div class="conn-header">
              <span class="conn-dot" class:ok={hasGitToken} class:off={!hasGitToken}></span>
              <h3>Git Provider</h3>
            </div>
            <p class="conn-desc">{hasGitToken && gitRepo ? `${activePlatform.label}: ${gitRepo}` : "PR comments and status checks."}</p>
            {#if hasGitToken}
              <button class="btn-test" onclick={testGit} disabled={gitTesting}>
                {gitTesting ? "Testing..." : "Test connection"}
              </button>
            {:else}
              <span class="conn-unconfigured">Not configured</span>
            {/if}
            {#if gitTest}
              <div class="conn-result" class:ok={gitTest.ok} class:fail={!gitTest.ok}>
                {#if gitTest.ok}
                  {gitTest.platform}: {gitTest.repo} &middot; {gitTest.latency_ms}ms
                {:else}
                  {gitTest.error}
                {/if}
              </div>
            {/if}
          </div>

          <!-- Email / SMTP -->
          <div class="conn-card">
            <div class="conn-header">
              <span class="conn-dot off"></span>
              <h3>Email</h3>
            </div>
            <p class="conn-desc">SMTP for verification and password reset emails.</p>
            <button class="btn-test" onclick={testEmail} disabled={emailTesting}>
              {emailTesting ? "Sending..." : "Send test email"}
            </button>
            {#if emailTest}
              <div class="conn-result" class:ok={emailTest.ok} class:fail={!emailTest.ok}>
                {#if emailTest.ok}
                  Sent to {emailTest.sent_to}
                {:else}
                  {emailTest.error}
                {/if}
              </div>
            {/if}
          </div>

          <!-- AI -->
          <div class="conn-card">
            <div class="conn-header">
              <span class="conn-dot" class:ok={aiStatus?.enabled} class:off={!aiStatus?.enabled}></span>
              <h3>AI Analysis</h3>
            </div>
            <p class="conn-desc">{aiStatus?.enabled ? "Error classification and flaky test analysis." : "Set AI_PROVIDER env var to enable."}</p>
            {#if aiStatus?.enabled}
              <button class="btn-test" onclick={testAI} disabled={aiTesting}>
                {aiTesting ? "Testing..." : "Test connection"}
              </button>
            {:else}
              <span class="conn-unconfigured">Not configured</span>
            {/if}
            {#if aiTest}
              <div class="conn-result" class:ok={aiTest.ok} class:fail={!aiTest.ok}>
                {#if aiTest.ok}
                  {aiTest.provider}: {aiTest.model}
                {:else}
                  {aiTest.error}
                {/if}
              </div>
            {/if}
          </div>
        </div>
      </section>

      <!-- ═══ Team ═══ -->
      <section id="team" class="settings-section">
        <header class="section-header">
          <div>
            <h2 class="section-title">Team</h2>
            <p class="section-subtitle">{members.length} {members.length === 1 ? 'member' : 'members'} in this organization.</p>
          </div>
        </header>

        <div class="card">
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
                <p>Invite created. Share this link:</p>
                <div class="link-row">
                  <code class="link-value">{inviteUrl(inviteResult.invite_token)}</code>
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
                  <span class="list-meta" title={absoluteDate(m.joined_at)}>Joined {timeAgo(m.joined_at)}</span>
                  {#if m.role === "owner"}
                    <span class="pill owner">Owner</span>
                  {:else if isOwner && m.id !== authState.user?.id}
                    <select class="inline-select" value={m.role} onchange={(e) => changeRole(m.id, (e.target as HTMLSelectElement).value)}>
                      <option value="admin">Admin</option>
                      <option value="viewer">Viewer</option>
                    </select>
                    <button class="btn-icon danger" onclick={() => removeMember(m.id, m.name || m.email)} title="Remove">
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3l10 10M13 3L3 13"/></svg>
                    </button>
                  {:else}
                    <span class="pill {m.role}">{m.role}</span>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </section>

      {#if isAdmin}
        <!-- ═══ Suites ═══ -->
        <section id="suites" class="settings-section">
          <header class="section-header">
            <div>
              <h2 class="section-title">Suites</h2>
              <p class="section-subtitle">Rename, archive, or delete test suites. Configure rerun commands per suite.</p>
            </div>
          </header>

          <div class="card">
            {#if suitesLoading}
              <p class="muted">Loading...</p>
            {:else if suites.length === 0}
              <p class="muted">No suites yet — upload a run to populate this list.</p>
            {:else}
              <div class="list">
                {#each visibleSuites as s}
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
                        <span class="list-secondary" title={absoluteDate(s.last_run)}>{s.run_count} run{s.run_count !== 1 ? "s" : ""} &middot; last {timeAgo(s.last_run)}</span>
                      {/if}
                    </div>
                    {#if s.archived}<span class="pill archived">Archived</span>{:else}<span class="pill active">Active</span>{/if}
                    <button class="btn-sm" onclick={() => { renamingId = s.suite_name; renameValue = s.suite_name; }}>Rename</button>
                    <button class="btn-sm" onclick={() => { editingTemplateId = editingTemplateId === s.suite_name ? null : s.suite_name; templateValue = s.rerun_command_template ?? ""; }}>Rerun Cmd</button>
                    <button class="btn-sm" onclick={() => toggleArchive(s.suite_name, s.archived)}>{s.archived ? "Unarchive" : "Archive"}</button>
                    {#if isOwner}<button class="btn-sm danger" onclick={() => deleteSuite(s.suite_name)}>Delete</button>{/if}
                  </div>
                  {#if editingTemplateId === s.suite_name}
                    <div class="rerun-template-edit">
                      <label class="template-label" for="rerun-template-input">Rerun command template</label>
                      <p class="template-hint">Placeholders: <code>{"{spec}"}</code> (file path), <code>{"{specs}"}</code> (all failed specs, comma-separated), <code>{"{title}"}</code> (test name), <code>{"{suite}"}</code> (suite name)</p>
                      <form class="template-form" onsubmit={(e) => { e.preventDefault(); saveRerunTemplate(s.suite_name); }}>
                        <input id="rerun-template-input" type="text" class="template-input" bind:value={templateValue} placeholder="npx cypress run --spec '{"{spec}"}' --env &quot;env=test&quot;" />
                        <button type="submit" class="btn-sm">Save</button>
                        <button type="button" class="btn-sm" onclick={() => editingTemplateId = null}>Cancel</button>
                      </form>
                    </div>
                  {/if}
                {/each}
              </div>
              {#if hasMoreSuites}
                <div class="load-more">
                  <button class="load-more-btn" onclick={loadMoreSuites}>
                    Load more ({suites.length - visibleSuites.length} more)
                  </button>
                </div>
              {/if}
            {/if}
          </div>
        </section>

        <!-- ═══ Webhooks ═══ -->
        <section id="notifications" class="settings-section">
          <header class="section-header">
            <div>
              <h2 class="section-title">Notifications</h2>
              <p class="section-subtitle">Webhooks for Slack, Teams, Discord, or any generic JSON receiver.</p>
            </div>
          </header>

          <div class="card">
            <div class="row-form">
              <input type="text" bind:value={newWhName} placeholder="Name (optional)" />
              <input type="url" bind:value={newWhUrl} placeholder="Webhook URL" oninput={() => { newWhPlatform = detectPlatform(newWhUrl); }} />
              <select bind:value={newWhPlatform}>
                <option value="generic">Generic JSON</option>
                <option value="slack">Slack</option>
                <option value="teams">Teams</option>
                <option value="discord">Discord</option>
              </select>
              <label class="checkbox-label"><input type="checkbox" checked={newWhEvents.includes("run.failed")} onchange={() => { newWhEvents = newWhEvents.includes("run.failed") ? newWhEvents.filter(e => e !== "run.failed") : [...newWhEvents, "run.failed"]; }} /> Run failed</label>
              <label class="checkbox-label"><input type="checkbox" checked={newWhEvents.includes("flaky.detected")} onchange={() => { newWhEvents = newWhEvents.includes("flaky.detected") ? newWhEvents.filter(e => e !== "flaky.detected") : [...newWhEvents, "flaky.detected"]; }} /> Flaky detected</label>
              <button class="btn-primary" onclick={createWebhook} disabled={saving}>{saving ? "Adding..." : "Add"}</button>
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
                      <span class="list-secondary mono">{wh.url.replace(/^https?:\/\//, "").slice(0, 60)}{wh.url.length > 60 ? '…' : ''}</span>
                    </div>
                    <span class="pill {wh.active ? 'active' : 'paused'}">{wh.active ? 'Active' : 'Paused'}</span>
                    {#if wh.platform && wh.platform !== "generic"}<span class="pill platform">{wh.platform}</span>{/if}
                    <div class="wh-events">{#each wh.events as ev}<span class="pill event">{ev}</span>{/each}</div>
                    <button class="btn-sm" onclick={() => toggleWebhook(wh.id, wh.active)}>{wh.active ? "Pause" : "Enable"}</button>
                    <button class="btn-sm" onclick={() => testWebhook(wh.id)}>
                      {#if whTestResult?.id === wh.id}{whTestResult.ok ? "Sent" : "Failed"}{:else}Test{/if}
                    </button>
                    <button class="btn-icon danger" onclick={() => deleteWebhook(wh.id)} title="Delete">
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 3l10 10M13 3L3 13"/></svg>
                    </button>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        </section>

        <!-- ═══ PR Comments ═══ -->
        <section id="pr-comments" class="settings-section">
          <header class="section-header">
            <div>
              <h2 class="section-title">PR comments</h2>
              <p class="section-subtitle">Post test results as PR/MR comments and commit status checks.</p>
            </div>
          </header>

          <div class="card">
            <div class="row-form">
              <select bind:value={gitProvider} style="min-width: 110px">
                <option value="">Select platform</option>
                {#each gitPlatforms as p}<option value={p.value}>{p.label}</option>{/each}
              </select>
              <input type="text" bind:value={gitRepo} placeholder={activePlatform.repoPlaceholder} style="max-width: 220px" />
              <input type="password" bind:value={gitToken} placeholder={hasGitToken ? "Token saved (enter new to replace)" : activePlatform.tokenLabel} />
              <button class="btn-primary" onclick={saveGitProvider}>{gitSaved ? "Saved" : "Save"}</button>
              {#if hasGitToken}<button class="btn-sm danger" onclick={removeGitProvider}>Remove</button>{/if}
            </div>
            {#if gitProvider === "gitlab" || gitProvider === "bitbucket"}
              <div class="row-form" style="margin-top: 0">
                <input type="url" bind:value={gitBaseUrl} placeholder="Base URL (leave empty for {gitProvider === 'gitlab' ? 'gitlab.com' : 'bitbucket.org'})" style="flex: 1" />
              </div>
            {/if}
            {#if gitError}<p class="form-error">{gitError}</p>{/if}
            {#if hasGitToken && gitRepo}
              <p class="muted" style="margin-top: 0.25rem">Connected to <strong>{gitRepo}</strong> via {activePlatform.label}.</p>
            {:else if gitProvider}
              <p class="muted" style="margin-top: 0.25rem">Create a <a href={activePlatform.tokenUrl} target="_blank" rel="noopener">{activePlatform.label} token</a> with <code>{activePlatform.scope}</code>.</p>
            {:else}
              <p class="muted" style="margin-top: 0.25rem">Select a platform to configure PR comments.</p>
            {/if}
          </div>
        </section>

        <!-- ═══ Data Retention ═══ -->
        <section id="retention" class="settings-section">
          <header class="section-header">
            <div>
              <h2 class="section-title">Data retention</h2>
              <p class="section-subtitle">Automatically delete test runs older than a set number of days.</p>
            </div>
          </header>

          <div class="card">
            <div class="row-form">
              <input type="number" bind:value={retentionDays} placeholder="Days (empty = keep forever)" min="1" max="365" />
              <button class="btn-primary" onclick={saveRetention}>{retentionSaved ? "Saved" : "Save"}</button>
              <span class="muted" style="font-size:0.78rem">{retentionDays ? `Runs older than ${retentionDays} days will be deleted daily` : "Keeping all data forever"}</span>
            </div>
          </div>
        </section>
      {/if}

      <!-- ═══ API Keys ═══ -->
      <section id="api-keys" class="settings-section">
        <header class="section-header">
          <div>
            <h2 class="section-title">API keys</h2>
            <p class="section-subtitle">Authenticate CLI uploads and programmatic access. Keys are shown once at creation — copy them immediately.</p>
          </div>
        </header>

        <div class="card">
          {#if newKeyValue}
            <div class="success-banner">
              <p>Copy this key now — it won't be shown again:</p>
              <div class="link-row">
                <code class="link-value">{newKeyValue}</code>
                <button class="btn-sm" onclick={() => newKeyValue = null}>Dismiss</button>
              </div>
            </div>
          {/if}

          <div class="row-form">
            <input type="text" bind:value={newKeyLabel} placeholder="Key label (e.g. CI pipeline)" />
            <button class="btn-primary" onclick={createKey} disabled={saving}>{saving ? "Creating..." : "Create key"}</button>
          </div>

          {#if keysLoading}
            <p class="muted">Loading...</p>
          {:else if apiKeys.length === 0}
            <p class="muted">No API keys yet.</p>
          {:else}
            <div class="list">
              {#each apiKeys as key}
                <div class="list-row">
                  <div class="list-info">
                    <span class="list-primary">{key.label}</span>
                    <span class="list-secondary mono">
                      <span title={absoluteDate(key.created_at)}>{key.key_prefix}…</span>
                      &middot; Last used <span title={key.last_used_at ? absoluteDate(key.last_used_at) : 'Never used'}>{timeAgo(key.last_used_at ?? "")}</span>
                      &middot; Created <span title={absoluteDate(key.created_at)}>{timeAgo(key.created_at)}</span>
                    </span>
                  </div>
                  <span class="pill active">Active</span>
                  <button class="btn-sm danger" onclick={() => deleteKey(key.id, key.label)}>Delete</button>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </section>

      <!-- ═══ API Endpoint ═══ -->
      <section id="api-endpoint" class="settings-section">
        <header class="section-header">
          <div>
            <h2 class="section-title">API endpoint</h2>
            <p class="section-subtitle">Base URL the dashboard talks to. Configured at deploy time via <code>VITE_API_URL</code>.</p>
          </div>
        </header>

        <div class="card">
          <div class="field-row">
            <span class="field-label">URL</span>
            <code>{apiUrl}</code>
          </div>
        </div>
      </section>

      <!-- ═══ Audit Log ═══ -->
      {#if isAdmin}
        <section id="audit-log" class="settings-section">
          <header class="section-header">
            <div>
              <h2 class="section-title">Audit log</h2>
              <p class="section-subtitle">Recent activity in this organization. Up to 200 events, paginated 25 at a time.</p>
            </div>
          </header>

          <div class="card">
            {#if auditLoading}
              <p class="muted">Loading...</p>
            {:else if auditLog.length === 0}
              <p class="muted">No activity yet.</p>
            {:else}
              <div class="audit-list">
                {#each visibleAudit as entry}
                  <div class="audit-row">
                    <span class="audit-time" title={absoluteDate(entry.created_at)}>{timeAgo(entry.created_at)}</span>
                    <span class="audit-user">{entry.user_name || entry.user_email || "System"}</span>
                    <span class="audit-action">{formatAction(entry.action)}</span>
                    {#if entry.target_id}<span class="audit-target">{entry.target_type}: {entry.target_id}</span>{/if}
                  </div>
                {/each}
              </div>
              {#if hasMoreAudit}
                <div class="load-more">
                  <button class="load-more-btn" onclick={loadMoreAudit}>
                    Load more ({auditLog.length - visibleAudit.length} more)
                  </button>
                </div>
              {/if}
            {/if}
          </div>
        </section>
      {/if}
    </div>
  </div>
</div>

{#if confirmState}
  <div class="modal-overlay">
    <button
      type="button"
      class="modal-backdrop"
      aria-label="Dismiss confirmation"
      onclick={() => resolveConfirm(false)}
    ></button>
    <div class="modal-box" role="dialog" aria-modal="true" tabindex="-1">
      <h2 class="modal-title">{confirmState.title}</h2>
      <p class="modal-message">{confirmState.message}</p>
      <div class="modal-actions">
        <button class="btn-sm" onclick={() => resolveConfirm(false)}>Cancel</button>
        <button class="btn-sm {confirmState.tone === 'danger' ? 'danger' : ''}" onclick={() => resolveConfirm(true)}>
          {confirmState.confirmLabel}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .page { max-width: 1920px; margin: 0 auto; padding: 1.5rem 2rem; }

  /* .page-title is kept as an sr-only sentinel for e2e specs that
     assert .page-title text === "Settings". The sidebar nav already
     labels the page visually. */
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
  }
  .page-title { font-size: 1px; }

  /* Two-column layout: sticky sub-nav + scrollable content */
  .settings-layout {
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr);
    gap: 2rem;
    align-items: start;
  }

  .subnav {
    position: sticky;
    top: 1rem;
    align-self: start;
    padding: 0.25rem 0;
  }
  .subnav nav { display: flex; flex-direction: column; gap: 0.1rem; }
  .subnav-link {
    display: flex; align-items: center; gap: 0.4rem;
    padding: 0.4rem 0.65rem; border-radius: 6px;
    font-size: 0.82rem; color: var(--text-secondary); text-decoration: none;
    border-left: 2px solid transparent; cursor: pointer;
  }
  .subnav-link:hover { background: var(--bg-hover); color: var(--text); }
  .subnav-link.active {
    background: color-mix(in srgb, var(--link) 10%, transparent);
    border-left-color: var(--link);
    color: var(--link);
    font-weight: 600;
  }
  .subnav-link.external {
    margin-top: 0.5rem;
    padding-top: 0.55rem;
    border-top: 1px solid var(--border);
    border-radius: 0 6px 6px 0;
    color: var(--text-muted);
  }
  .subnav-link.external:hover { color: var(--link); background: transparent; }

  .settings-content { display: flex; flex-direction: column; gap: 2rem; min-width: 0; }

  /* Section header — title + subtitle */
  .settings-section { scroll-margin-top: 1rem; }
  .section-header {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 1rem; margin-bottom: 0.75rem;
  }
  .section-title {
    font-size: 1.05rem; font-weight: 700; margin: 0 0 0.15rem;
    color: var(--text);
  }
  .section-subtitle {
    margin: 0; font-size: 0.8rem; color: var(--text-muted); max-width: 60ch;
  }

  .card {
    border: 1px solid var(--border); border-radius: 8px;
    padding: 1.1rem 1.25rem;
    background: var(--bg);
  }
  .muted { color: var(--text-muted); font-size: 0.85rem; margin: 0; }

  /* Connection grid */
  .conn-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
    gap: 0.75rem;
  }
  .conn-card {
    border: 1px solid var(--border); border-radius: 8px; padding: 1rem;
    display: flex; flex-direction: column; gap: 0.4rem;
    background: var(--bg);
  }
  .conn-header { display: flex; align-items: center; gap: 0.5rem; }
  .conn-header h3 { margin: 0; font-size: 0.88rem; }
  .conn-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .conn-dot.ok { background: var(--color-pass); }
  .conn-dot.off { background: var(--text-muted); }
  .conn-desc { font-size: 0.75rem; color: var(--text-muted); margin: 0; flex: 1; }
  .conn-unconfigured { font-size: 0.72rem; color: var(--text-muted); font-style: italic; }

  .btn-test {
    padding: 0.3rem 0.6rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--text-secondary); font-size: 0.75rem;
    cursor: pointer; align-self: flex-start; white-space: nowrap;
  }
  .btn-test:hover { background: var(--bg-hover); color: var(--text); }
  .btn-test:disabled { opacity: 0.5; cursor: wait; }

  .conn-result {
    padding: 0.35rem 0.55rem; border-radius: 5px; font-size: 0.72rem;
  }
  .conn-result.ok {
    background: color-mix(in srgb, var(--color-pass) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-pass) 30%, transparent);
    color: var(--text);
  }
  .conn-result.fail {
    background: var(--error-bg); border: 1px solid var(--error-border); color: var(--error-text);
  }

  /* Forms */
  .row-form {
    display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.75rem; flex-wrap: wrap;
  }
  .row-form:last-child { margin-bottom: 0; }
  .row-form input[type="text"], .row-form input[type="email"], .row-form input[type="url"], .row-form input[type="number"], .row-form input[type="password"] {
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
  .btn-primary:disabled { opacity: 0.5; cursor: wait; }

  .btn-sm {
    padding: 0.25rem 0.5rem; border: 1px solid var(--border); border-radius: 4px;
    background: var(--bg); color: var(--text-secondary); font-size: 0.72rem; cursor: pointer; white-space: nowrap;
  }
  .btn-sm:hover { background: var(--bg-hover); color: var(--text); }
  .btn-sm.danger { color: var(--color-fail); border-color: color-mix(in srgb, var(--color-fail) 35%, var(--border)); }
  .btn-sm.danger:hover { background: color-mix(in srgb, var(--color-fail) 8%, transparent); border-color: var(--color-fail); }

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

  .link-row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  .link-value {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    padding: 0.35rem 0.5rem; background: var(--bg-secondary); border-radius: 4px; font-size: 0.72rem; user-select: all;
  }

  /* Lists */
  .list { display: flex; flex-direction: column; }
  .list-row {
    display: flex; align-items: center; gap: 0.75rem; padding: 0.6rem 0;
    border-top: 1px solid var(--border-light);
  }
  .list-row:first-child { border-top: none; padding-top: 0.25rem; }
  .list-row.archived { opacity: 0.55; }

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
    padding: 0.18rem 0.55rem; border-radius: 10px;
    font-size: 0.65rem; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.04em;
    flex-shrink: 0; line-height: 1.4;
  }
  .pill.owner { background: color-mix(in srgb, var(--link) 12%, transparent); color: var(--link); }
  .pill.admin { background: color-mix(in srgb, var(--color-pass) 12%, transparent); color: var(--color-pass); }
  .pill.viewer { background: var(--bg-hover); color: var(--text-secondary); }
  .pill.active { background: color-mix(in srgb, var(--color-pass) 12%, transparent); color: var(--color-pass); }
  .pill.paused { background: var(--bg-hover); color: var(--text-muted); }
  .pill.archived { background: var(--bg-hover); color: var(--text-muted); }
  .pill.event { background: var(--bg-secondary); color: var(--text-secondary); font-family: monospace; text-transform: none; letter-spacing: 0; font-weight: 500; }
  .pill.platform { background: color-mix(in srgb, var(--link) 10%, transparent); color: var(--link); text-transform: capitalize; letter-spacing: 0; }

  .inline-select {
    padding: 0.2rem 0.35rem; border: 1px solid var(--border); border-radius: 4px;
    background: var(--bg); color: var(--text); font-size: 0.75rem; flex-shrink: 0;
  }

  .inline-rename { display: flex; gap: 0.35rem; align-items: center; }
  .inline-rename input {
    padding: 0.3rem 0.5rem; border: 1px solid var(--link); border-radius: 4px;
    background: var(--bg); color: var(--text); font-size: 0.82rem; outline: none; width: 200px;
  }

  .rerun-template-edit {
    padding: 0.5rem 0.85rem 0.65rem; background: var(--bg-secondary); border-top: 1px solid var(--border-light);
    border-radius: 4px; margin: 0.25rem 0;
  }
  .template-label { display: block; font-size: 0.78rem; font-weight: 600; margin-bottom: 0.15rem; }
  .template-hint { font-size: 0.72rem; color: var(--text-muted); margin: 0 0 0.4rem; }
  .template-hint code { font-size: 0.72rem; background: var(--bg); padding: 0.1rem 0.25rem; border-radius: 3px; }
  .template-form { display: flex; gap: 0.35rem; align-items: center; }
  .template-input {
    flex: 1; padding: 0.3rem 0.5rem; border: 1px solid var(--border); border-radius: 4px;
    background: var(--bg); color: var(--text); font-size: 0.78rem; font-family: monospace; outline: none;
  }
  .template-input:focus { border-color: var(--link); }

  .wh-events { display: flex; gap: 0.25rem; flex-shrink: 0; flex-wrap: wrap; max-width: 240px; }

  /* Audit */
  .audit-list { display: flex; flex-direction: column; max-height: 360px; overflow-y: auto; }
  .audit-row {
    display: flex; align-items: baseline; gap: 0.75rem; padding: 0.4rem 0;
    border-top: 1px solid var(--border-light); font-size: 0.8rem;
  }
  .audit-row:first-child { border-top: none; }
  .audit-time { color: var(--text-muted); font-size: 0.72rem; min-width: 4.5rem; flex-shrink: 0; }
  .audit-user { color: var(--text-secondary); min-width: 8rem; flex-shrink: 0; }
  .audit-action { font-weight: 500; color: var(--text); }
  .audit-target { color: var(--text-muted); font-family: monospace; font-size: 0.75rem; }

  /* API endpoint */
  .field-row { display: flex; gap: 1rem; font-size: 0.875rem; align-items: center; }
  .field-row .field-label { color: var(--text-secondary); min-width: 3rem; }
  .field-row code { padding: 0.25rem 0.5rem; background: var(--bg-hover); border-radius: 4px; font-size: 0.8rem; }

  /* Confirm modal */
  .modal-overlay {
    position: fixed; inset: 0; z-index: 1000;
    display: flex; align-items: center; justify-content: center;
  }
  .modal-backdrop {
    position: absolute; inset: 0; background: rgba(0,0,0,0.45);
    border: none; padding: 0; cursor: pointer;
  }
  .modal-box {
    position: relative;
    background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
    padding: 1.5rem; max-width: 420px; width: 90%; box-shadow: 0 8px 32px rgba(0,0,0,0.18);
  }
  .modal-title { margin: 0 0 0.5rem; font-size: 1rem; font-weight: 700; }
  .modal-message { margin: 0 0 1.25rem; font-size: 0.875rem; color: var(--text-secondary); }
  .modal-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }

  /* Collapse the sidebar on narrow viewports — sub-nav becomes a
     horizontal strip across the top so the page still works on a
     phone or split-screen window. */
  @media (max-width: 900px) {
    .settings-layout { grid-template-columns: 1fr; gap: 1rem; }
    .subnav { position: static; }
    .subnav nav {
      flex-direction: row; flex-wrap: wrap; gap: 0.25rem;
      padding-bottom: 0.5rem; border-bottom: 1px solid var(--border);
    }
    .subnav-link { border-left: none; border-bottom: 2px solid transparent; }
    .subnav-link.active { border-left: none; border-bottom-color: var(--link); }
    .subnav-link.external { margin-top: 0; padding-top: 0.4rem; border-top: none; }
  }
</style>
