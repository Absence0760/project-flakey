<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { page } from "$app/stores";
  import { fetchRun, type RunDetail, type Spec } from "$lib/api";
  import { getAuth } from "$lib/auth";
  import ErrorModal from "$lib/components/ErrorModal.svelte";
  import NotesPanel from "$lib/components/NotesPanel.svelte";

  const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

  let run = $state<RunDetail | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let modalTestId = $state<number | null>(null);
  let statusFilter = $state<string>("all");
  let searchQuery = $state("");
  let collapsedSpecs = $state<Set<number>>(new Set());

  // Live events
  interface LiveEvent {
    type: string;
    test?: string;
    spec?: string;
    status?: string;
    duration_ms?: number;
    error?: string;
    timestamp?: number;
  }

  let liveEvents = $state<LiveEvent[]>([]);
  let isLive = $state(false);
  let justFinished = $state(false);
  let eventSource: EventSource | null = null;

  function connectLive(runId: number) {
    const token = getAuth().token;
    // EventSource doesn't support headers, so pass token as query param
    eventSource = new EventSource(`${API_URL}/live/${runId}/stream?token=${token}`);

    eventSource.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as LiveEvent;
        if (event.type === "connected") {
          isLive = true;
          return;
        }
        liveEvents = [...liveEvents.slice(-99), event];

        // Auto-refresh full run data when run finishes
        if (event.type === "run.finished") {
          isLive = false;
          justFinished = true;
          eventSource?.close();
          fetchRun(runId).then(r => { run = r; }).catch(() => {});
          // Clear the "just finished" banner after 10 seconds
          setTimeout(() => { justFinished = false; }, 10000);
        }
      } catch { /* ignore */ }
    };

    eventSource.onerror = () => {
      isLive = false;
    };
  }

  async function loadLiveHistory(runId: number) {
    try {
      const token = getAuth().token;
      const res = await fetch(`${API_URL}/live/${runId}/history`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const events = await res.json() as LiveEvent[];
        if (events.length > 0) {
          liveEvents = events;
        }
      }
    } catch { /* ignore */ }
  }

  function setStatusFilter(value: string) {
    statusFilter = value;
    const url = new URL(window.location.href);
    if (value === "all") url.searchParams.delete("status");
    else url.searchParams.set("status", value);
    history.replaceState({}, "", url.toString());
  }

  onMount(async () => {
    const id = Number($page.params.id);

    // Feature 5: read URL filter param
    const urlStatus = $page.url.searchParams.get("status");
    if (urlStatus && ["all", "passed", "failed", "skipped"].includes(urlStatus)) {
      statusFilter = urlStatus;
    }

    try {
      run = await fetchRun(id);
      if (run) {
        // Feature 1: auto-filter to failed (only if no URL param override)
        if (run.failed > 0 && statusFilter === "all") {
          setStatusFilter("failed");
        }

        // Feature 2: collapse passing specs, expand failed ones
        collapsedSpecs = new Set(
          run.specs.filter((s) => s.failed === 0).map((s) => s.id)
        );

        const runAge = Date.now() - new Date(run.created_at).getTime();
        if (runAge < 30 * 60 * 1000) {
          await loadLiveHistory(id);
          connectLive(id);
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load run";
    } finally {
      loading = false;
    }
  });

  onDestroy(() => {
    eventSource?.close();
  });

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60000);
    const secs = ((ms % 60000) / 1000).toFixed(0);
    return `${mins}m ${secs}s`;
  }

  function formatTimestamp(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      month: "short", day: "numeric", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  }

  function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days === 1) return "yesterday";
    return `${days}d ago`;
  }

  function toggleSpec(specId: number) {
    const next = new Set(collapsedSpecs);
    if (next.has(specId)) next.delete(specId);
    else next.add(specId);
    collapsedSpecs = next;
  }

  let copiedSuite = $state(false);
  function copySuite() {
    if (!run) return;
    navigator.clipboard.writeText(run.suite_name);
    copiedSuite = true;
    setTimeout(() => copiedSuite = false, 1500);
  }

  let copiedSpecId = $state<number | null>(null);
  function copySpecName(e: MouseEvent, specId: number, name: string) {
    e.stopPropagation();
    navigator.clipboard.writeText(name);
    copiedSpecId = specId;
    setTimeout(() => copiedSpecId = null, 1500);
  }

  let copiedTestId = $state<number | null>(null);
  function copyTestName(e: MouseEvent, testId: number, name: string) {
    e.stopPropagation();
    navigator.clipboard.writeText(name);
    copiedTestId = testId;
    setTimeout(() => copiedTestId = null, 1500);
  }

  let copiedErrorId = $state<number | null>(null);
  function copyErrorMessage(e: MouseEvent, testId: number, msg: string) {
    e.stopPropagation();
    navigator.clipboard.writeText(msg);
    copiedErrorId = testId;
    setTimeout(() => copiedErrorId = null, 1500);
  }

  let copiedRerunId = $state<number | string | null>(null);
  function buildRerunCommand(specFile: string, testTitle: string): string | null {
    const tpl = run?.rerun_command_template;
    if (!tpl) return null;
    return tpl
      .replace(/\{spec\}/g, specFile)
      .replace(/\{title\}/g, testTitle)
      .replace(/\{suite\}/g, run?.suite_name ?? "");
  }

  function copyRerunCommand(e: MouseEvent, id: number | string, specFile: string, testTitle: string) {
    e.stopPropagation();
    const cmd = buildRerunCommand(specFile, testTitle);
    if (!cmd) return;
    navigator.clipboard.writeText(cmd);
    copiedRerunId = id;
    setTimeout(() => copiedRerunId = null, 1500);
  }

  function copyAllFailedCommands(e: MouseEvent) {
    e.stopPropagation();
    if (!run) return;
    const tpl = run.rerun_command_template;
    if (!tpl) return;

    // Collect unique failed spec paths
    const failedSpecs = new Set<string>();
    for (const spec of run.specs) {
      if (spec.tests.some((t) => t.status === "failed")) {
        failedSpecs.add(spec.file_path || spec.title);
      }
    }
    if (failedSpecs.size === 0) return;

    let result: string;
    if (tpl.includes("{specs}")) {
      // Single command with all specs combined (e.g. Cypress comma-separated)
      result = tpl
        .replace(/\{specs\}/g, [...failedSpecs].join(","))
        .replace(/\{suite\}/g, run.suite_name)
        .replace(/\{spec\}/g, [...failedSpecs][0])
        .replace(/\{title\}/g, "");
    } else {
      // One command per failed spec
      const cmds = [...failedSpecs].map((spec) =>
        tpl
          .replace(/\{spec\}/g, spec)
          .replace(/\{title\}/g, "")
          .replace(/\{suite\}/g, run!.suite_name)
      );
      result = cmds.join("\n");
    }

    navigator.clipboard.writeText(result);
    copiedRerunId = "all";
    setTimeout(() => copiedRerunId = null, 1500);
  }

  let copiedFormat = $state<string | null>(null);

  function buildSummary(format: "jira" | "markdown"): string {
    if (!run) return "";
    const status = run.failed === 0 ? "PASSED" : "FAILED";
    const url = window.location.href.replace(/\?.*/, "");
    const bold = (s: string) => format === "jira" ? `*${s}*` : `**${s}**`;
    const italic = (s: string) => format === "jira" ? `_${s}_` : `*${s}*`;
    const link = (text: string, href: string) => format === "jira" ? `[${text}|${href}]` : `[${text}](${href})`;

    const lines: string[] = [
      bold(`Run #${run.id} — ${status}`),
      `Suite: ${run.suite_name}`,
    ];
    if (run.branch) lines.push(`Branch: ${run.branch}`);
    if (run.commit_sha) lines.push(`Commit: \`${run.commit_sha.slice(0, 7)}\``);
    lines.push(`Duration: ${formatDuration(run.duration_ms)}`);
    lines.push(`Results: ${run.passed} passed, ${run.failed} failed, ${run.skipped} skipped / ${run.total} total (${passRate(run)}%)`);

    const statusIcon = (s: string) => s === "passed" ? "✅" : s === "failed" ? "❌" : "⏭️";
    for (const spec of run.specs) {
      const relevant = spec.tests.filter((t) => t.status !== "pending");
      if (relevant.length === 0) continue;
      lines.push("");
      lines.push(italic(spec.file_path || spec.title));
      for (const test of relevant) {
        const icon = statusIcon(test.status);
        const err = test.status === "failed" && test.error_message ? ` — ${test.error_message.slice(0, 120)}` : "";
        lines.push(`- ${icon} ${test.full_title || test.title}${err}`);
      }
    }

    lines.push("");
    lines.push(link("View run", url));
    return lines.join("\n");
  }

  function copySummary(format: "jira" | "markdown") {
    navigator.clipboard.writeText(buildSummary(format));
    copiedFormat = format;
    setTimeout(() => copiedFormat = null, 2000);
  }

  let copiedFailedNames = $state(false);
  function copyAllFailedNames() {
    if (!run) return;
    const names: string[] = [];
    for (const spec of run.specs) {
      for (const test of spec.tests) {
        if (test.status === "failed") names.push(test.full_title || test.title);
      }
    }
    if (names.length === 0) return;
    navigator.clipboard.writeText(names.join("\n"));
    copiedFailedNames = true;
    setTimeout(() => copiedFailedNames = false, 1500);
  }

  function passRate(r: RunDetail): number {
    if (r.total === 0) return 0;
    return Math.round((r.passed / r.total) * 100);
  }

  let filteredSpecs = $derived.by(() => {
    if (!run) return [];
    const q = searchQuery.toLowerCase();
    return run.specs.map((spec) => {
      const specMatches = q && (
        spec.file_path?.toLowerCase().includes(q) ||
        spec.title?.toLowerCase().includes(q)
      );
      const tests = spec.tests.filter((t) => {
        if (statusFilter !== "all") {
          if (statusFilter === "skipped") {
            if (t.status !== "skipped" && t.status !== "pending") return false;
          } else if (t.status !== statusFilter) return false;
        }
        if (q && !specMatches && !t.title.toLowerCase().includes(q) && !t.full_title?.toLowerCase().includes(q)) return false;
        return true;
      });
      return { ...spec, tests };
    }).filter((spec) => spec.tests.length > 0);
  });

  let allCollapsed = $derived(filteredSpecs.length > 0 && filteredSpecs.every((s) => collapsedSpecs.has(s.id)));

  function toggleAll() {
    if (allCollapsed) {
      collapsedSpecs = new Set();
    } else {
      collapsedSpecs = new Set(filteredSpecs.map((s) => s.id));
    }
  }

  let filterCounts = $derived.by(() => {
    if (!run) return { all: 0, passed: 0, failed: 0, skipped: 0 };
    const all = run.specs.flatMap((s) => s.tests);
    return {
      all: all.length,
      passed: all.filter((t) => t.status === "passed").length,
      failed: all.filter((t) => t.status === "failed").length,
      skipped: all.filter((t) => t.status === "skipped" || t.status === "pending").length,
    };
  });
</script>

<div class="page">
  {#if loading}
    <p class="status-msg">Loading...</p>
  {:else if error}
    <p class="status-msg error">{error}</p>
  {:else if run}
    <!-- Breadcrumb -->
    <nav class="breadcrumb">
      <a href="/">Runs</a>
      <span class="sep">/</span>
      <span>#{run.id}</span>
      <div class="run-nav">
        {#if run.prev_id}
          <a href="/runs/{run.prev_id}" class="run-nav-btn" title="Previous run (#{run.prev_id})">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 3L5 8l5 5"/></svg>
          </a>
        {:else}
          <span class="run-nav-btn disabled"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 3L5 8l5 5"/></svg></span>
        {/if}
        {#if run.next_id}
          <a href="/runs/{run.next_id}" class="run-nav-btn" title="Next run (#{run.next_id})">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3l5 5-5 5"/></svg>
          </a>
        {:else}
          <span class="run-nav-btn disabled"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3l5 5-5 5"/></svg></span>
        {/if}
      </div>
    </nav>

    <!-- Header card -->
    <header class="run-header">
      <div class="header-top">
        <div class="header-left">
          <div class="title-row">
            <h1>Run #{run.id}</h1>
            <span class="run-status-badge" class:all-pass={run.failed === 0} class:has-fail={run.failed > 0}>
              {run.failed === 0 ? "Passed" : `${run.failed} Failed`}
            </span>
            {#if isLive}
              <span class="live-badge">LIVE</span>
            {/if}
            {#if justFinished}
              <span class="finished-badge">Run Complete</span>
            {/if}
            <button class="copy-summary-btn" title="Copy as Jira markup" onclick={() => copySummary("jira")}>
              {#if copiedFormat === "jira"}
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.5 3.5 6.5-8"/></svg>
                Copied!
              {:else}
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 11V3a1 1 0 011-1h8"/></svg>
                Jira
              {/if}
            </button>
            <button class="copy-summary-btn" title="Copy as Markdown" onclick={() => copySummary("markdown")}>
              {#if copiedFormat === "markdown"}
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.5 3.5 6.5-8"/></svg>
                Copied!
              {:else}
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4h12v8H2z M4 8l2-2v4 M8 10V6l2 2 2-2v4"/></svg>
                Markdown
              {/if}
            </button>
          </div>
          <div class="meta-row">
            <span class="meta-item" title="Suite">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 6h12"/></svg>
              {run.suite_name}
              <button class="copy-btn" title="Copy suite name" onclick={copySuite}>
                {#if copiedSuite}
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.5 3.5 6.5-8"/></svg>
                {:else}
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 11V3a1 1 0 011-1h8"/></svg>
                {/if}
              </button>
            </span>
            <span class="meta-item" title="Branch">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="5" cy="4" r="1.5"/><circle cx="11" cy="4" r="1.5"/><circle cx="5" cy="12" r="1.5"/><path d="M5 5.5v5M11 5.5c0 3-6 3-6 5"/></svg>
              {run.branch || "—"}
            </span>
            {#if run.commit_sha}
              <span class="meta-item mono" title="Commit">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="3"/><path d="M8 1v4M8 11v4M1 8h4M11 8h4"/></svg>
                {run.commit_sha.slice(0, 7)}
              </span>
            {/if}
            <span class="meta-item" title="Started">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 2"/></svg>
              <span title={formatTimestamp(run.started_at)}>{timeAgo(run.started_at)}</span>
            </span>
            <span class="meta-item" title="Duration">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2h4M8 2v3M3.5 6l1-1M12.5 6l-1-1"/><circle cx="8" cy="9.5" r="4.5"/></svg>
              {formatDuration(run.duration_ms)}
            </span>
          </div>
        </div>

        <!-- Progress ring -->
        <div class="progress-ring" title="{passRate(run)}% pass rate">
          <svg viewBox="0 0 36 36" class="ring-svg">
            <path class="ring-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
            <path class="ring-fill" class:good={passRate(run) >= 90} class:warn={passRate(run) >= 50 && passRate(run) < 90} class:bad={passRate(run) < 50}
              stroke-dasharray="{passRate(run)}, 100"
              d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
          </svg>
          <div class="ring-label">
            <span class="ring-pct">{passRate(run)}%</span>
          </div>
        </div>
      </div>

      <!-- Stats bar -->
      <div class="stats-bar">
        <div class="stat-item">
          <span class="stat-num">{run.total}</span>
          <span class="stat-label">Total</span>
        </div>
        <div class="stat-divider"></div>
        <div class="stat-item">
          <span class="stat-num pass">{run.passed}</span>
          <span class="stat-label">Passed</span>
        </div>
        <div class="stat-divider"></div>
        <div class="stat-item">
          <span class="stat-num fail">{run.failed}</span>
          <span class="stat-label">Failed</span>
        </div>
        <div class="stat-divider"></div>
        <div class="stat-item">
          <span class="stat-num skip">{run.skipped}</span>
          <span class="stat-label">Skipped</span>
        </div>
        <div class="stat-divider"></div>
        <div class="stat-item">
          <span class="stat-num">{run.specs.length}</span>
          <span class="stat-label">Specs</span>
        </div>
      </div>
    </header>

    <!-- Run notes -->
    <div class="run-notes">
      <NotesPanel targetType="run" targetKey={String(run.id)} compact />
    </div>

    <!-- Live event feed -->
    {#if liveEvents.length > 0}
      <div class="live-feed" class:finished={justFinished && !isLive}>
        <h3 class="live-feed-title">
          {#if isLive}
            Live Progress
          {:else if justFinished}
            Run Complete — {run?.failed ? `${run.failed} failed` : 'all passed'}
          {:else}
            Live Progress (ended)
          {/if}
        </h3>
        <div class="live-events">
          {#each liveEvents.slice().reverse() as event}
            <div class="live-event" class:passed={event.type === "test.passed"} class:failed={event.type === "test.failed"} class:started={event.type === "test.started"}>
              <span class="live-dot"
                class:dot-pass={event.type === "test.passed"}
                class:dot-fail={event.type === "test.failed"}
                class:dot-run={event.type === "test.started" || event.type === "spec.started"}
                class:dot-skip={event.type === "test.skipped"}
              ></span>
              <span class="live-text">
                {#if event.type === "run.started"}
                  Run started
                {:else if event.type === "run.finished"}
                  Run finished
                {:else if event.type === "spec.started"}
                  {event.spec}
                {:else if event.type === "spec.finished"}
                  Spec finished: {event.spec}
                {:else}
                  {event.test}
                {/if}
              </span>
              {#if event.duration_ms}
                <span class="live-duration">{event.duration_ms}ms</span>
              {/if}
              {#if event.error}
                <span class="live-error">{event.error.slice(0, 80)}</span>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Filter toolbar -->
    <div class="toolbar">
      <div class="filter-tabs">
        <button class="filter-tab" class:active={statusFilter === "all"} onclick={() => setStatusFilter("all")}>
          All <span class="tab-count">{filterCounts.all}</span>
        </button>
        <button class="filter-tab" class:active={statusFilter === "passed"} onclick={() => setStatusFilter("passed")}>
          <span class="dot pass"></span> Passed <span class="tab-count">{filterCounts.passed}</span>
        </button>
        <button class="filter-tab" class:active={statusFilter === "failed"} onclick={() => setStatusFilter("failed")}>
          <span class="dot fail"></span> Failed <span class="tab-count">{filterCounts.failed}</span>
        </button>
        <button class="filter-tab" class:active={statusFilter === "skipped"} onclick={() => setStatusFilter("skipped")}>
          <span class="dot skip"></span> Skipped <span class="tab-count">{filterCounts.skipped}</span>
        </button>
      </div>
      <div class="toolbar-right">
      {#if filterCounts.failed > 0}
        <button class="rerun-all-btn" onclick={copyAllFailedNames} title="Copy all failed test names">
          {#if copiedFailedNames}
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.5 3.5 6.5-8"/></svg>
            Copied!
          {:else}
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 11V3a1 1 0 011-1h8"/></svg>
            Copy failed names
          {/if}
        </button>
      {/if}
      {#if run?.rerun_command_template && filterCounts.failed > 0}
        <button class="rerun-all-btn" onclick={copyAllFailedCommands} title="Copy rerun commands for all failed tests">
          {#if copiedRerunId === "all"}
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.5 3.5 6.5-8"/></svg>
            Copied!
          {:else}
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 2v10l3-2.5L10 12V2z"/></svg>
            Copy all failed reruns
          {/if}
        </button>
      {/if}
      <button class="collapse-all-btn" onclick={toggleAll} title={allCollapsed ? "Expand all" : "Collapse all"}>
        <svg class="chevron-icon" class:collapsed={allCollapsed} width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M3 4.5L6 7.5L9 4.5"/>
        </svg>
        {allCollapsed ? "Expand all" : "Collapse all"}
      </button>
      <div class="search-box">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>
        <input type="text" placeholder="Filter tests..." bind:value={searchQuery} />
      </div>
      </div>
    </div>

    <!-- Specs & Tests -->
    {#if filteredSpecs.length === 0}
      <p class="empty">No tests match the current filter.</p>
    {/if}

    {#each filteredSpecs as spec}
      <section class="spec-section">
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="spec-header" onclick={() => toggleSpec(spec.id)}>
          <svg class="chevron" class:collapsed={collapsedSpecs.has(spec.id)} width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M3 4.5L6 7.5L9 4.5"/>
          </svg>
          <span class="spec-path">{spec.file_path || spec.title}</span>
          <button class="copy-btn" title="Copy feature name" onclick={(e) => copySpecName(e, spec.id, spec.file_path || spec.title)}>
            {#if copiedSpecId === spec.id}
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.5 3.5 6.5-8"/></svg>
            {:else}
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 11V3a1 1 0 011-1h8"/></svg>
            {/if}
          </button>
          <div class="spec-badges">
            {#if spec.passed > 0}<span class="spec-badge pass">{spec.passed}</span>{/if}
            {#if spec.failed > 0}<span class="spec-badge fail">{spec.failed}</span>{/if}
            {#if spec.skipped > 0}<span class="spec-badge skip">{spec.skipped}</span>{/if}
            <span class="spec-duration">{formatDuration(spec.duration_ms)}</span>
          </div>
        </div>

        {#if !collapsedSpecs.has(spec.id)}
          <ul class="test-list">
            {#each spec.tests as test}
              <li class="test-row">
                <div class="test-main">
                  <span class="test-status-dot {test.status}"></span>
                  <button class="test-name clickable" onclick={() => modalTestId = test.id}>
                    {test.title}
                  </button>
                  <button class="copy-btn test-copy" title="Copy test name" onclick={(e) => copyTestName(e, test.id, test.full_title || test.title)}>
                    {#if copiedTestId === test.id}
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.5 3.5 6.5-8"/></svg>
                    {:else}
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 11V3a1 1 0 011-1h8"/></svg>
                    {/if}
                  </button>
                  <div class="test-meta">
                    {#if test.video_path}
                      <button class="test-badge video-badge" title="View video" onclick={() => modalTestId = test.id}>
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="3.5" width="9" height="9" rx="1.5"/><path d="M10.5 6l4-2v8l-4-2"/></svg>
                      </button>
                    {/if}
                    {#if test.screenshot_paths && test.screenshot_paths.length > 0}
                      <span class="test-badge" title="{test.screenshot_paths.length} screenshot(s)">
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1.5" y="3.5" width="13" height="9" rx="1.5"/><circle cx="8" cy="8" r="2.5"/><circle cx="12" cy="5.5" r="0.75" fill="currentColor" stroke="none"/></svg>
                        {test.screenshot_paths.length}
                      </span>
                    {/if}
                    <span class="test-dur">{formatDuration(test.duration_ms)}</span>
                    {#if run?.rerun_command_template && test.status === "failed"}
                      <button class="rerun-btn" title="Copy rerun command" onclick={(e) => copyRerunCommand(e, test.id, spec.file_path || spec.title, test.full_title || test.title)}>
                        {#if copiedRerunId === test.id}
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.5 3.5 6.5-8"/></svg>
                        {:else}
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 8a6 6 0 0111.3-2.8M14 8a6 6 0 01-11.3 2.8"/><path d="M13 2v3.5h-3.5M3 14v-3.5h3.5"/></svg>
                        {/if}
                        Rerun
                      </button>
                    {/if}
                  </div>
                </div>
                {#if test.error_message}
                  <button class="test-error-bar" onclick={() => modalTestId = test.id}>
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 5v3.5M8 10.5v.5"/></svg>
                    <span class="error-text">{test.error_message}</span>
                    <span class="copy-error-btn" role="button" tabindex="-1" title="Copy error message" onclick={(e) => copyErrorMessage(e, test.id, test.error_message ?? "")}>
                      {#if copiedErrorId === test.id}
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.5 3.5 6.5-8"/></svg>
                      {:else}
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 11V3a1 1 0 011-1h8"/></svg>
                      {/if}
                    </span>
                    <span class="error-action">View details</span>
                  </button>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/each}
  {/if}
</div>

<ErrorModal testId={modalTestId} onclose={() => modalTestId = null} />

<style>
  .page {
    max-width: 1100px;
    padding: 1.5rem 2rem 3rem;
  }

  .status-msg { color: var(--text-secondary); }
  .status-msg.error { color: var(--color-fail); }

  /* Breadcrumb */
  .breadcrumb {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
    margin-bottom: 1rem;
  }

  .breadcrumb a {
    color: var(--text-muted);
    text-decoration: none;
  }

  .breadcrumb a:hover {
    color: var(--link);
  }

  .sep {
    color: var(--text-muted);
  }

  .run-nav {
    display: flex; gap: 0.2rem; margin-left: auto;
  }
  .run-nav-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; border-radius: 6px;
    border: 1px solid var(--border); color: var(--text-secondary);
    text-decoration: none; transition: color 0.15s, border-color 0.15s;
  }
  .run-nav-btn:hover:not(.disabled) { color: var(--link); border-color: var(--link); }
  .run-nav-btn.disabled { opacity: 0.3; cursor: default; }

  /* Header */
  .run-header {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.25rem;
    margin-bottom: 1rem;
    background: var(--bg);
  }

  .header-top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1.5rem;
    margin-bottom: 1.25rem;
  }

  .header-left {
    flex: 1;
    min-width: 0;
  }

  .title-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
  }

  h1 {
    margin: 0;
    font-size: 1.35rem;
  }

  .run-status-badge {
    padding: 0.2rem 0.6rem;
    border-radius: 20px;
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .run-status-badge.all-pass {
    background: color-mix(in srgb, var(--color-pass) 15%, transparent);
    color: var(--color-pass);
  }

  .run-status-badge.has-fail {
    background: color-mix(in srgb, var(--color-fail) 15%, transparent);
    color: var(--color-fail);
  }

  .copy-summary-btn {
    display: inline-flex; align-items: center; gap: 0.3rem;
    padding: 0.2rem 0.5rem; border: 1px solid var(--border); border-radius: 6px;
    background: none; color: var(--text-secondary); font-size: 0.72rem; cursor: pointer;
    transition: color 0.15s, border-color 0.15s; margin-left: 0.25rem;
  }
  .copy-summary-btn:hover { color: var(--link); border-color: var(--link); }

  .meta-row {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
  }

  .meta-item {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.8rem;
    color: var(--text-secondary);
  }

  .meta-item.mono {
    font-family: monospace;
  }

  .meta-item svg {
    flex-shrink: 0;
    opacity: 0.6;
  }

  .copy-btn {
    background: none; border: none; padding: 0.15rem; cursor: pointer;
    color: var(--text-muted); border-radius: 4px; display: inline-flex; align-items: center;
    transition: color 0.15s;
  }
  .copy-btn:hover { color: var(--text-primary); background: var(--bg-hover, rgba(128,128,128,0.1)); }

  /* Progress ring */
  .progress-ring {
    position: relative;
    width: 64px;
    height: 64px;
    flex-shrink: 0;
  }

  .ring-svg {
    width: 100%;
    height: 100%;
    transform: rotate(-90deg);
  }

  .ring-bg {
    fill: none;
    stroke: var(--border);
    stroke-width: 3;
  }

  .ring-fill {
    fill: none;
    stroke-width: 3;
    stroke-linecap: round;
    transition: stroke-dasharray 0.6s ease;
  }

  .ring-fill.good { stroke: var(--color-pass); }
  .ring-fill.warn { stroke: var(--link); }
  .ring-fill.bad { stroke: var(--color-fail); }

  .ring-label {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }

  .ring-pct {
    font-size: 0.85rem;
    font-weight: 700;
    color: var(--text);
  }

  /* Stats bar */
  .stats-bar {
    display: flex;
    align-items: center;
    gap: 0;
    padding-top: 1rem;
    border-top: 1px solid var(--border-light);
  }

  .stat-item {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.15rem;
  }

  .stat-num {
    font-size: 1.1rem;
    font-weight: 700;
    color: var(--text);
  }

  .stat-num.pass { color: var(--color-pass); }
  .stat-num.fail { color: var(--color-fail); }
  .stat-num.skip { color: var(--color-skip); }

  .stat-label {
    font-size: 0.7rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .stat-divider {
    width: 1px;
    height: 28px;
    background: var(--border-light);
  }

  .run-notes {
    margin-bottom: 1rem; padding: 0.75rem 1rem;
    border: 1px solid var(--border); border-radius: 8px; background: var(--bg);
  }

  /* Toolbar */
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
    flex-wrap: wrap;
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--bg);
    padding: 0.5rem 0;
  }

  .filter-tabs {
    display: flex;
    gap: 0.2rem;
    background: var(--bg-secondary);
    border-radius: 6px;
    padding: 0.2rem;
  }

  .filter-tab {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.35rem 0.65rem;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 0.78rem;
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
  }

  .filter-tab:hover {
    color: var(--text);
  }

  .filter-tab.active {
    background: var(--bg);
    color: var(--text);
    font-weight: 600;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
  }

  .tab-count {
    font-size: 0.7rem;
    color: var(--text-muted);
    font-weight: 400;
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
  }

  .dot.pass { background: var(--color-pass); }
  .dot.fail { background: var(--color-fail); }
  .dot.skip { background: var(--color-skip); }

  .toolbar-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .collapse-all-btn {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.35rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text-secondary);
    font-size: 0.78rem;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.15s;
  }

  .collapse-all-btn:hover {
    color: var(--text);
    border-color: var(--text-muted);
  }

  .chevron-icon {
    transition: transform 0.15s;
    color: var(--text-muted);
  }

  .chevron-icon.collapsed {
    transform: rotate(-90deg);
  }

  .search-box {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text-muted);
    transition: border-color 0.15s;
  }

  .search-box:focus-within {
    border-color: var(--link);
  }

  .search-box input {
    border: none;
    background: transparent;
    outline: none;
    font-size: 0.8rem;
    color: var(--text);
    width: 160px;
  }

  .search-box input::placeholder {
    color: var(--text-muted);
  }

  .empty {
    text-align: center;
    color: var(--text-muted);
    font-size: 0.875rem;
    padding: 2rem 0;
  }

  /* Spec sections */
  .spec-section {
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 0.5rem;
    overflow: hidden;
  }

  .spec-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.65rem 0.85rem;
    background: var(--bg-secondary);
    color: var(--text);
    font-size: 0.82rem;
    cursor: pointer;
    transition: background 0.1s;
  }

  .spec-header:hover {
    background: var(--bg-hover);
  }

  .chevron {
    flex-shrink: 0;
    transition: transform 0.15s;
    color: var(--text-muted);
  }

  .chevron.collapsed {
    transform: rotate(-90deg);
  }

  .spec-path {
    flex: 1;
    font-family: monospace;
    font-size: 0.78rem;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .spec-badges {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-shrink: 0;
  }

  .spec-badge {
    padding: 0.1rem 0.4rem;
    border-radius: 10px;
    font-size: 0.7rem;
    font-weight: 600;
    min-width: 1.2rem;
    text-align: center;
  }

  .spec-badge.pass {
    background: color-mix(in srgb, var(--color-pass) 15%, transparent);
    color: var(--color-pass);
  }

  .spec-badge.fail {
    background: color-mix(in srgb, var(--color-fail) 15%, transparent);
    color: var(--color-fail);
  }

  .spec-badge.skip {
    background: color-mix(in srgb, var(--color-skip) 15%, transparent);
    color: var(--color-skip);
  }

  .spec-duration {
    font-family: monospace;
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  /* Test list */
  .test-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .test-row {
    border-top: 1px solid var(--border-light);
  }

  .test-main {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 0.85rem 0.5rem 1.6rem;
  }

  .test-status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .test-status-dot.passed { background: var(--color-pass); }
  .test-status-dot.failed { background: var(--color-fail); }
  .test-status-dot.skipped,
  .test-status-dot.pending { background: var(--color-skip); }

  .test-name {
    flex: 1;
    font-size: 0.83rem;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .test-name.clickable {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    font-size: 0.83rem;
    color: var(--link);
    cursor: pointer;
    text-align: left;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .test-name.clickable:hover {
    text-decoration: underline;
  }

  .test-copy { flex-shrink: 0; }

  .test-meta {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-shrink: 0;
  }

  .test-badge {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .test-badge svg {
    opacity: 0.7;
  }

  .video-badge {
    background: none;
    border: none;
    padding: 0.15rem;
    border-radius: 3px;
    cursor: pointer;
    transition: background 0.1s;
  }

  .video-badge:hover {
    background: var(--bg-hover);
  }

  .video-badge:hover svg {
    opacity: 1;
    color: var(--link);
  }

  .test-dur {
    font-family: monospace;
    font-size: 0.75rem;
    color: var(--text-muted);
    min-width: 3.5rem;
    text-align: right;
  }

  .rerun-btn {
    display: inline-flex; align-items: center; gap: 0.25rem;
    padding: 0.15rem 0.4rem; border: 1px solid var(--border); border-radius: 4px;
    background: none; color: var(--text-secondary); font-size: 0.7rem; cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }
  .rerun-btn:hover { color: var(--link); border-color: var(--link); }

  .rerun-all-btn {
    display: inline-flex; align-items: center; gap: 0.3rem;
    padding: 0.3rem 0.6rem; border: 1px solid var(--border); border-radius: 6px;
    background: none; color: var(--text-secondary); font-size: 0.75rem; cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }
  .rerun-all-btn:hover { color: var(--link); border-color: var(--link); }

  /* Error bar */
  .test-error-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 0.85rem 0.5rem 2.8rem;
    border: none;
    background: var(--error-bg);
    border-top: 1px solid var(--error-border);
    cursor: pointer;
    text-align: left;
    transition: background 0.15s;
  }

  .test-error-bar:hover {
    background: color-mix(in srgb, var(--color-fail) 10%, var(--error-bg));
  }

  .test-error-bar svg {
    flex-shrink: 0;
    color: var(--error-text);
    opacity: 0.7;
  }

  .error-text {
    flex: 1;
    font-size: 0.78rem;
    font-family: monospace;
    color: var(--error-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .error-action {
    flex-shrink: 0;
    font-size: 0.72rem;
    color: var(--link);
    opacity: 0;
    transition: opacity 0.15s;
  }

  .test-error-bar:hover .error-action {
    opacity: 1;
  }

  .copy-error-btn {
    flex-shrink: 0; padding: 0.15rem; cursor: pointer; border-radius: 4px;
    display: inline-flex; align-items: center; color: var(--error-text);
    opacity: 0; transition: opacity 0.15s;
  }
  .test-error-bar:hover .copy-error-btn { opacity: 0.7; }
  .copy-error-btn:hover { opacity: 1 !important; background: rgba(128,128,128,0.15); }

  /* Live */
  .live-badge {
    padding: 0.15rem 0.5rem; border-radius: 10px; font-size: 0.65rem; font-weight: 700;
    background: var(--color-fail); color: #fff; letter-spacing: 0.05em;
    animation: live-pulse 2s ease-in-out infinite;
  }
  @keyframes live-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }

  .live-feed {
    margin-bottom: 1rem; border: 1px solid var(--border); border-radius: 8px;
    padding: 0.75rem 1rem; max-height: 250px; overflow-y: auto;
  }
  .live-feed.finished {
    border-color: var(--color-pass);
    background: color-mix(in srgb, var(--color-pass) 4%, transparent);
  }
  .live-feed-title {
    font-size: 0.8rem; font-weight: 600; margin: 0 0 0.5rem;
    color: var(--text-secondary);
  }
  .finished-badge {
    padding: 0.15rem 0.5rem; border-radius: 10px; font-size: 0.65rem; font-weight: 700;
    background: var(--color-pass); color: #fff; letter-spacing: 0.03em;
    animation: fade-in 0.3s ease-in;
  }
  @keyframes fade-in {
    from { opacity: 0; transform: scale(0.9); }
    to { opacity: 1; transform: scale(1); }
  }
  .live-events { display: flex; flex-direction: column; gap: 0.2rem; }
  .live-event {
    display: flex; align-items: center; gap: 0.5rem;
    font-size: 0.75rem; color: var(--text-secondary); padding: 0.15rem 0;
  }
  .live-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .live-dot.dot-pass { background: var(--color-pass); }
  .live-dot.dot-fail { background: var(--color-fail); }
  .live-dot.dot-run { background: var(--link); }
  .live-dot.dot-skip { background: var(--color-skip); }
  .live-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .live-duration { font-size: 0.68rem; color: var(--text-muted); flex-shrink: 0; }
  .live-error { font-size: 0.68rem; color: var(--color-fail); flex-shrink: 0; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
