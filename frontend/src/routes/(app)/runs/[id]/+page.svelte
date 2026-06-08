<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { timeAgo, absoluteDate, formatDuration } from "$lib/utils/format";
  import { page } from "$app/stores";
  import { replaceState } from "$app/navigation";
  import { fetchRun, type RunDetail, type Spec } from "$lib/api";
  import { getAuth, authFetch } from "$lib/stores/auth";
  import ErrorModal from "$lib/components/overlays/ErrorModal.svelte";
  import NotesPanel from "$lib/components/panels/NotesPanel.svelte";
  import RunExtras from "$lib/components/panels/RunExtras.svelte";
  import PassRateRing from "$lib/components/status/PassRateRing.svelte";
  import { passRate } from "$lib/utils/stats";
  import { API_URL } from "$lib/utils/config";

  let run = $state<RunDetail | null>(null);
  // Previous run (for the "new failures since previous run" band).
  // null while loading; remains null when there is no prev run, or the
  // fetch failed — both cases collapse to an empty band, no UI break.
  let prevRun = $state<RunDetail | null>(null);
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
  const displayedEvents = $derived.by(() => {
    const finishedTests = new Set(
      liveEvents
        .filter(e => e.type === "test.passed" || e.type === "test.failed" || e.type === "test.skipped")
        .map(e => e.test)
    );
    const finishedSpecs = new Set(
      liveEvents.filter(e => e.type === "spec.finished").map(e => e.spec)
    );
    return liveEvents
      .filter(e => {
        if (e.type === "test.started" && e.test && finishedTests.has(e.test)) return false;
        if (e.type === "spec.started" && e.spec && finishedSpecs.has(e.spec)) return false;
        return true;
      })
      .slice()
      .reverse();
  });
  let isLive = $state(false);
  let justFinished = $state(false);
  let runAborted = $state(false);
  let eventSource: EventSource | null = null;
  let livePollTimer: ReturnType<typeof setInterval> | null = null;

  // Ticks every second so the duration field updates in real-time during a
  // live run instead of only refreshing when run data is repolled.
  let now = $state(Date.now());
  let nowTimer: ReturnType<typeof setInterval> | null = null;

  function startLivePoll(runId: number) {
    if (livePollTimer) return;
    livePollTimer = setInterval(() => {
      fetchRun(runId).then(r => { run = r; }).catch(() => {});
    }, 3000);
  }

  function stopLivePoll() {
    if (livePollTimer) { clearInterval(livePollTimer); livePollTimer = null; }
  }

  // Coalesce bursts of live events into a single fetch so the header counters
  // update within ~250ms of a test result, without flooding the backend when
  // many tests finish at once.
  let pendingStatFetch: ReturnType<typeof setTimeout> | null = null;
  function scheduleStatRefresh(runId: number) {
    if (pendingStatFetch) return;
    pendingStatFetch = setTimeout(() => {
      pendingStatFetch = null;
      fetchRun(runId).then(r => { run = r; }).catch(() => {});
    }, 250);
  }
  function cancelStatRefresh() {
    if (pendingStatFetch) { clearTimeout(pendingStatFetch); pendingStatFetch = null; }
  }

  function connectLive(runId: number) {
    const token = getAuth().token;
    // EventSource doesn't support headers, so pass token as query param
    eventSource = new EventSource(`${API_URL}/live/${runId}/stream?token=${token}`);

    eventSource.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as LiveEvent;
        if (event.type === "connected") {
          isLive = true;
          startLivePoll(runId);
          return;
        }
        liveEvents = [...liveEvents.slice(-99), event];

        // Refresh header counters as soon as a test result lands rather than
        // waiting up to 3s for the next poll tick.
        if (
          event.type === "test.passed" ||
          event.type === "test.failed" ||
          event.type === "test.skipped" ||
          event.type === "spec.finished"
        ) {
          scheduleStatRefresh(runId);
        }

        // Auto-refresh full run data when run finishes
        if (event.type === "run.finished") {
          isLive = false;
          justFinished = true;
          eventSource?.close();
          stopLivePoll();
          cancelStatRefresh();
          fetchRun(runId).then(r => { run = r; }).catch(() => {});
          // Clear the "just finished" banner after 10 seconds
          setTimeout(() => { justFinished = false; }, 10000);
        } else if (event.type === "run.aborted") {
          isLive = false;
          runAborted = true;
          eventSource?.close();
          stopLivePoll();
          cancelStatRefresh();
          // Refetch so run.aborted persists as the header pill after the
          // transient banner times out.
          fetchRun(runId).then(r => { run = r; }).catch(() => {});
          setTimeout(() => { runAborted = false; }, 10000);
        }
      } catch { /* ignore */ }
    };

    eventSource.onerror = () => {
      isLive = false;
      stopLivePoll();
      cancelStatRefresh();
      eventSource?.close();
      eventSource = null;
    };
  }

  async function loadLiveHistory(runId: number) {
    try {
      const res = await authFetch(`${API_URL}/live/${runId}/history`);
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
    replaceState(url, {});
  }

  // Mirror the test-search box into the URL (?q=) so it survives reloads
  // and back-nav, same as ?status / ?test. Reactive rather than per-key
  // imperative: a `mounted` gate keeps the initial render (and the
  // onMount read of ?q) from clobbering the URL before the user types.
  function syncSearchToUrl() {
    const url = new URL(window.location.href);
    if (searchQuery) url.searchParams.set("q", searchQuery);
    else url.searchParams.delete("q");
    replaceState(url, {});
  }
  let mounted = $state(false);
  $effect(() => {
    searchQuery;
    if (mounted) syncSearchToUrl();
  });

  // Open/close the test-detail modal AND mirror it into the URL as ?test=<id>
  // so a specific failure is deep-linkable — paste the URL into a PR comment
  // and the reviewer lands on the same open test, not just the run.
  function openTest(id: number) {
    modalTestId = id;
    const url = new URL(window.location.href);
    url.searchParams.set("test", String(id));
    replaceState(url, {});
  }

  function closeTest() {
    modalTestId = null;
    const url = new URL(window.location.href);
    url.searchParams.delete("test");
    replaceState(url, {});
  }

  onMount(async () => {
    const id = Number($page.params.id);

    nowTimer = setInterval(() => { now = Date.now(); }, 1000);

    // Feature 5: read URL filter param
    const urlStatus = $page.url.searchParams.get("status");
    const urlStatusExplicit = !!urlStatus && ["all", "passed", "failed", "skipped"].includes(urlStatus);
    if (urlStatusExplicit) {
      statusFilter = urlStatus!;
    }
    searchQuery = $page.url.searchParams.get("q") ?? "";

    try {
      run = await fetchRun(id);
      if (run) {
        // Feature 1: auto-filter to failed (only when the user hasn't
        // explicitly chosen a filter via the URL — `?status=all` is a
        // deliberate override that must NOT get clobbered).
        if (run.failed > 0 && statusFilter === "all" && !urlStatusExplicit) {
          setStatusFilter("failed");
        }

        // Feature 2: collapse passing specs, expand failed ones
        collapsedSpecs = new Set(
          run.specs.filter((s) => s.failed === 0).map((s) => s.id)
        );

        // Deep link: ?test=<id> opens that test's modal on load, but only if
        // the id actually belongs to this run — a stale id from an old link
        // should leave the modal closed rather than open an empty one.
        const urlTest = Number($page.url.searchParams.get("test"));
        if (Number.isFinite(urlTest) && urlTest > 0
            && run.specs.some((s) => s.tests.some((t) => t.id === urlTest))) {
          modalTestId = urlTest;
        }

        const runAge = Date.now() - new Date(run.created_at).getTime();
        if (runAge < 30 * 60 * 1000) {
          await loadLiveHistory(id);
          // A run with finished_at set is complete — this is the backend's
          // authoritative "not active" signal (activeRunIdsForOrg in
          // backend/src/routes/live.ts uses exactly `finished_at IS NULL`,
          // which is what the runs LIST keys its LIVE badge off). Without
          // this guard a plain batch upload (finished_at set, but zero
          // live_events, so no `run.finished` event in history) would still
          // pass the `terminated` check below, connect to /live/<id>/stream,
          // get the `connected` handshake, and falsely render LIVE here while
          // the list correctly shows it Passed.
          const terminated = run.finished_at != null
            || liveEvents.some(e => e.type === "run.finished" || e.type === "run.aborted");
          if (!terminated) connectLive(id);
        }

        // Fire-and-forget prev-run fetch so we can surface "new
        // failures since previous run" — the most important triage
        // signal on this page. Failures here just leave the band
        // hidden; never block the main render.
        if (run.prev_id) {
          fetchRun(run.prev_id).then(r => { prevRun = r; }).catch(() => {});
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load run";
    } finally {
      loading = false;
      mounted = true;
    }
  });

  onDestroy(() => {
    eventSource?.close();
    stopLivePoll();
    cancelStatRefresh();
    if (nowTimer) { clearInterval(nowTimer); nowTimer = null; }
  });

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
    lines.push(`Duration: ${formatDuration(displayDuration)}`);
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


  // Tests in the previous run that were already failing — used to
  // distinguish "new" failures (regressions) from "still failing"
  // ones. Keyed by full_title (the same field the backend uses to
  // diff between runs for the runs-list `new_failures` count).
  let prevFailedTitles = $derived.by(() => {
    if (!prevRun) return new Set<string>();
    const set = new Set<string>();
    for (const spec of prevRun.specs) {
      for (const t of spec.tests) {
        if (t.status === "failed") set.add(t.full_title || t.title);
      }
    }
    return set;
  });

  // Failures in the current run that were NOT failing in the previous
  // run — the regressions a triager wants to look at first.
  // [{ spec, test }] so the band can link straight to the ErrorModal.
  let newFailures = $derived.by(() => {
    if (!run) return [] as Array<{ spec: Spec; test: Spec["tests"][number] }>;
    // No prev run means every failure is technically "new" — but the
    // band's purpose is to highlight regressions vs the previous run.
    // Skip rendering the band in that case (prevRun stays null).
    if (!prevRun) return [];
    const out: Array<{ spec: Spec; test: Spec["tests"][number] }> = [];
    for (const spec of run.specs) {
      for (const test of spec.tests) {
        if (test.status !== "failed") continue;
        const key = test.full_title || test.title;
        if (!prevFailedTitles.has(key)) out.push({ spec, test });
      }
    }
    return out;
  });

  // Lookup by test id — used to badge "NEW" inline on the test rows
  // without re-running the title-diff for every render.
  let newFailureIds = $derived(new Set(newFailures.map((n) => n.test.id)));

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

  // Wall-clock duration to match what the test runner prints in the terminal.
  // run.duration_ms is the sum of per-test durations server-side, which can
  // diverge from real elapsed time (parallelism, setup overhead, etc.). For
  // live runs we tick from started_at; for completed runs we use the
  // finished_at − started_at delta when both are present.
  let displayDuration = $derived.by(() => {
    if (!run) return 0;
    const startMs = new Date(run.started_at).getTime();
    if (!Number.isFinite(startMs)) return run?.duration_ms ?? 0;
    if (isLive) return Math.max(0, now - startMs);
    if (run.finished_at) {
      const finishMs = new Date(run.finished_at).getTime();
      if (Number.isFinite(finishMs) && finishMs >= startMs) return finishMs - startMs;
    }
    return run.duration_ms;
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
      <a href="/runs">Automated runs</a>
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
            <h2 class="run-suite-title" title={run.suite_name}>{run.suite_name}</h2>
            <button class="copy-btn copy-suite-btn" title="Copy suite name" onclick={copySuite}>
              {#if copiedSuite}
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.5 3.5 6.5-8"/></svg>
              {:else}
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 11V3a1 1 0 011-1h8"/></svg>
              {/if}
            </button>
            {#if !isLive}
              <span class="run-status-badge" class:all-pass={run.failed === 0} class:has-fail={run.failed > 0}>
                {run.failed === 0 ? "Passed" : `${run.failed} Failed`}
              </span>
            {:else}
              <span class="live-badge">LIVE</span>
            {/if}
            {#if justFinished}
              <span class="finished-badge">Run Complete</span>
            {/if}
            {#if runAborted}
              <span class="aborted-badge">Run Aborted</span>
            {:else if run.aborted}
              <span class="aborted-pill" title={run.aborted_reason ?? "Run aborted before completion"}>
                ABORTED
              </span>
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
            <span class="meta-item" title="Run id">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 2h6l2 2v10H4z"/><path d="M10 2v2h2"/></svg>
              #{run.id}
            </span>
            <span class="meta-item" title="Branch">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="5" cy="4" r="1.5"/><circle cx="11" cy="4" r="1.5"/><circle cx="5" cy="12" r="1.5"/><path d="M5 5.5v5M11 5.5c0 3-6 3-6 5"/></svg>
              {run.branch || "—"}
            </span>
            {#if run.environment}
              <a class="meta-item env-chip" href="/runs?env={encodeURIComponent(run.environment)}" title="Environment — click to filter the runs grid">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 8a6 6 0 0112 0M2 8a6 6 0 0012 0M2 8h12M8 2c1.5 1.7 2.3 3.8 2.3 6S9.5 12.3 8 14M8 2C6.5 3.7 5.7 5.8 5.7 8S6.5 12.3 8 14"/></svg>
                {run.environment}
              </a>
            {/if}
            {#if run.commit_sha}
              <span class="meta-item mono" title="Commit">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="3"/><path d="M8 1v4M8 11v4M1 8h4M11 8h4"/></svg>
                {run.commit_sha.slice(0, 7)}
              </span>
            {/if}
            <span class="meta-item" title="Started">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 2"/></svg>
              <span title={absoluteDate(run.started_at)}>{timeAgo(run.started_at)}</span>
            </span>
            <span class="meta-item" title="Duration">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2h4M8 2v3M3.5 6l1-1M12.5 6l-1-1"/><circle cx="8" cy="9.5" r="4.5"/></svg>
              {formatDuration(displayDuration)}
            </span>
          </div>
        </div>

        <!-- Progress ring -->
        <PassRateRing rate={passRate(run)} />
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
          <span class="stat-label">
            Failed
            {#if newFailures.length > 0}
              <span class="stat-delta">+{newFailures.length} new</span>
            {/if}
          </span>
        </div>
        <div class="stat-divider"></div>
        <div class="stat-item">
          <span class="stat-num skip">{filterCounts.skipped}</span>
          <span class="stat-label">Skipped</span>
        </div>
      </div>
    </header>

    <!-- New failures since previous run — the canonical "needs
         attention" signal for a triager. Hidden when prev run hasn't
         loaded yet OR when there are no regressions vs the prev run.
         Each row clicks straight into the ErrorModal, same as the
         per-test error bar. -->
    {#if newFailures.length > 0}
      <section class="at-risk-band">
        <header class="at-risk-header">
          <span class="at-risk-icon" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1l7 13H1z"/><path d="M8 6v4M8 12v0.5"/></svg>
          </span>
          <h3 class="at-risk-title">
            {newFailures.length} new failure{newFailures.length === 1 ? "" : "s"} since
            {#if run.prev_id}
              <a class="at-risk-prev-link" href="/runs/{run.prev_id}">run #{run.prev_id}</a>
            {:else}
              the previous run
            {/if}
          </h3>
          <span class="at-risk-sub">Passed last run, failing now — start triage here.</span>
        </header>
        <ul class="at-risk-list">
          {#each newFailures as { spec, test }}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role: mirrors /manual-tests row click pattern -->
            <li
              class="at-risk-row"
              role="button"
              tabindex="0"
              onclick={() => openTest(test.id)}
              onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openTest(test.id); } }}
            >
              <span class="at-risk-dot"></span>
              <span class="at-risk-test">{test.title}</span>
              <span class="at-risk-spec mono">{spec.file_path || spec.title}</span>
              {#if test.error_message}
                <span class="at-risk-err mono">{test.error_message.slice(0, 140)}</span>
              {/if}
              <span class="at-risk-action">View</span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <!-- Run notes -->
    <div class="run-notes">
      <NotesPanel targetType="run" targetKey={String(run.id)} compact />
    </div>

    <!-- Coverage / a11y / visual extras -->
    <RunExtras runId={run.id} />

    <!-- Live event feed -->
    {#if liveEvents.length > 0}
      <div class="live-feed" class:finished={justFinished && !isLive} class:aborted={runAborted}>
        <h3 class="live-feed-title">
          {#if isLive}
            Live Progress
          {:else if justFinished}
            Run Complete — {run?.failed ? `${run.failed} failed` : 'all passed'}
          {:else if runAborted}
            Run Aborted — test process was killed or terminal closed
          {:else}
            Live Progress (ended)
          {/if}
        </h3>
        <div class="live-events">
          {#each displayedEvents as event}
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
                {:else if event.type === "run.aborted"}
                  Run aborted — {event.error ?? "test process stopped unexpectedly"}
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
            {#if spec.skipped + spec.pending > 0}<span class="spec-badge skip">{spec.skipped + spec.pending}</span>{/if}
            <span class="spec-duration">{formatDuration(spec.duration_ms)}</span>
          </div>
        </div>

        {#if !collapsedSpecs.has(spec.id)}
          <ul class="test-list">
            {#each spec.tests as test}
              <li class="test-row">
                <div class="test-main">
                  <span class="test-status-dot {test.status}"></span>
                  <button class="test-name clickable" onclick={() => openTest(test.id)}>
                    {test.title}
                  </button>
                  {#if newFailureIds.has(test.id)}
                    <span class="new-fail-pill" title="Passed in run #{run?.prev_id} — new failure">NEW</span>
                  {/if}
                  <button class="copy-btn test-copy" title="Copy test name" onclick={(e) => copyTestName(e, test.id, test.full_title || test.title)}>
                    {#if copiedTestId === test.id}
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.5 3.5 6.5-8"/></svg>
                    {:else}
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 11V3a1 1 0 011-1h8"/></svg>
                    {/if}
                  </button>
                  <div class="test-meta">
                    {#if test.video_path}
                      <button class="test-badge video-badge" title="View video" onclick={() => openTest(test.id)}>
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
                  <!--
                    Outer is a div (not button) so the inner copy button
                    can nest without producing invalid HTML
                    (button-in-button). role="button" + tabindex="0" +
                    onkeydown on Enter/Space gives keyboard parity with
                    the previous <button> element.
                  -->
                  <div
                    class="test-error-bar"
                    role="button"
                    tabindex="0"
                    onclick={() => openTest(test.id)}
                    onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openTest(test.id); } }}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 5v3.5M8 10.5v.5"/></svg>
                    <span class="error-text">{test.error_message}</span>
                    <button
                      class="copy-error-btn"
                      type="button"
                      title="Copy error message"
                      onclick={(e) => copyErrorMessage(e, test.id, test.error_message ?? "")}
                    >
                      {#if copiedErrorId === test.id}
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.5 3.5 6.5-8"/></svg>
                      {:else}
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="8" height="8" rx="1"/><path d="M3 11V3a1 1 0 011-1h8"/></svg>
                      {/if}
                    </button>
                    <span class="error-action">View details</span>
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/each}
  {/if}
</div>

<ErrorModal testId={modalTestId} onclose={closeTest} />

<style>
  .page {
    max-width: 1920px;
    margin: 0 auto;
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

  .run-suite-title {
    margin: 0;
    font-size: 1.15rem;
    font-weight: 700;
    color: var(--text);
    max-width: 60ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .copy-suite-btn {
    /* Pull the copy icon tight to the title so the visual unit is
       (title + copy) rather than (title) (gap) (copy). */
    margin-left: -0.25rem;
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

  .meta-item.env-chip {
    background: var(--bg-hover, rgba(128, 128, 128, 0.12));
    border-radius: 999px;
    padding: 0.1rem 0.6rem;
    text-decoration: none;
    color: var(--text-secondary);
    transition: background 0.15s, color 0.15s;
  }
  .meta-item.env-chip:hover {
    background: color-mix(in srgb, var(--link, #4c8bf5) 18%, transparent);
    color: var(--text-primary);
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
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }

  .stat-delta {
    /* The "+N new" delta sits next to the "Failed" label so the
       regression count is visible without leaving the KPI row. Tinted
       so it reads as a warning, not chrome. */
    padding: 0.1rem 0.4rem;
    border-radius: 10px;
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    background: color-mix(in srgb, var(--color-fail) 15%, transparent);
    color: var(--color-fail);
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

  /* At-risk band — mirrors the /releases at-risk pinned band. Tinted
     red, left-edge stripe, hidden when the regression set is empty. */
  .at-risk-band {
    margin-bottom: 1rem;
    border: 1px solid color-mix(in srgb, var(--color-fail) 30%, var(--border));
    border-left: 4px solid var(--color-fail);
    border-radius: 8px;
    background: color-mix(in srgb, var(--color-fail) 6%, var(--bg));
    overflow: hidden;
  }

  .at-risk-header {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    padding: 0.7rem 1rem 0.55rem;
    flex-wrap: wrap;
  }

  .at-risk-icon {
    color: var(--color-fail);
    display: inline-flex;
    align-self: center;
  }

  .at-risk-title {
    margin: 0;
    font-size: 0.88rem;
    font-weight: 700;
    color: var(--color-fail);
  }

  .at-risk-prev-link {
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .at-risk-sub {
    font-size: 0.75rem;
    color: var(--text-secondary);
  }

  .at-risk-list {
    list-style: none;
    margin: 0;
    padding: 0;
    border-top: 1px solid color-mix(in srgb, var(--color-fail) 25%, var(--border));
  }

  .at-risk-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 2fr) auto;
    align-items: center;
    gap: 0.75rem;
    padding: 0.45rem 1rem;
    cursor: pointer;
    border-top: 1px solid color-mix(in srgb, var(--color-fail) 15%, var(--border-light));
    transition: background 0.1s;
  }
  .at-risk-row:first-child { border-top: none; }
  .at-risk-row:hover { background: color-mix(in srgb, var(--color-fail) 10%, transparent); }
  .at-risk-row:focus-visible { outline: 2px solid var(--link); outline-offset: -2px; }

  .at-risk-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--color-fail);
    flex-shrink: 0;
  }

  .at-risk-test {
    font-size: 0.82rem;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .at-risk-spec {
    font-family: monospace;
    font-size: 0.72rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .at-risk-err {
    font-family: monospace;
    font-size: 0.72rem;
    color: var(--color-fail);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .at-risk-action {
    font-size: 0.7rem;
    color: var(--link);
    opacity: 0;
    transition: opacity 0.15s;
    white-space: nowrap;
  }
  .at-risk-row:hover .at-risk-action { opacity: 1; }

  /* Inline NEW pill on test rows that are regressions vs prev run.
     Mirrors the /runs list `new-fail-badge` so the signal is
     consistent across views. */
  .new-fail-pill {
    padding: 0.05rem 0.35rem;
    border-radius: 4px;
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    background: color-mix(in srgb, var(--color-fail) 18%, transparent);
    color: var(--color-fail);
    border: 1px solid color-mix(in srgb, var(--color-fail) 35%, transparent);
    flex-shrink: 0;
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
    align-items: flex-start;
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

  .test-error-bar > svg {
    margin-top: 0.2rem;
  }

  .test-error-bar:hover {
    background: color-mix(in srgb, var(--color-fail) 10%, var(--error-bg));
  }

  .test-error-bar:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: -2px;
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
    white-space: pre-wrap;
    word-break: break-word;
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
    /* Reset native button chrome — element is now <button> so the
       inner copy action can sit inside an outer div without invalid
       button-in-button HTML. */
    border: none; background: transparent; font: inherit;
  }
  .test-error-bar:hover .copy-error-btn { opacity: 0.7; }
  .copy-error-btn:hover { opacity: 1 !important; background: rgba(128,128,128,0.15); }
  .copy-error-btn:focus-visible { opacity: 1; outline: 2px solid var(--link); outline-offset: 1px; }

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
  .live-feed.aborted {
    border-color: var(--color-fail);
    background: color-mix(in srgb, var(--color-fail) 4%, transparent);
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
  .aborted-badge {
    padding: 0.15rem 0.5rem; border-radius: 10px; font-size: 0.65rem; font-weight: 700;
    background: var(--color-fail); color: #fff; letter-spacing: 0.03em;
    animation: fade-in 0.3s ease-in;
  }
  /* Persistent (non-transient) pill shown on any previously-aborted run's
     header so the status is discoverable after the banner times out. */
  .aborted-pill {
    padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.62rem; font-weight: 700;
    letter-spacing: 0.04em;
    background: color-mix(in srgb, var(--color-fail) 15%, transparent);
    color: var(--color-fail);
    border: 1px solid color-mix(in srgb, var(--color-fail) 35%, transparent);
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
