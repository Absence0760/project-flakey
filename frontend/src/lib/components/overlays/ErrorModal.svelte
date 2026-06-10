<script lang="ts">
  import { untrack } from "svelte";
  import { fetchTest, fetchTestHistory, checkAIEnabled, UPLOADS_URL, artifactSrc, type TestDetail, type TestHistoryEntry } from "$lib/api";
  import { timeAgo, absoluteDate, formatDuration } from "$lib/utils/format";
  import { authFetch } from "$lib/stores/auth";
  import { toast as toastSuccess, toastInfo } from "$lib/stores/toast";
  import {
    snapshotIdxForCommandGroup as snapshotIdxForCommandGroupPure,
    snapshotIdxForCommandChild as snapshotIdxForCommandChildPure,
    stepDiagnostics,
    type CommandGroup as PureCommandGroup,
    type ConsoleEntryLite,
    type NetworkEntryLite,
  } from "$lib/utils/snapshot-match";
  import Lightbox from "../media/Lightbox.svelte";
  import SnapshotViewer from "../media/SnapshotViewer.svelte";
  import NotesPanel from "../panels/NotesPanel.svelte";
  import AIAnalysisCard from "../panels/AIAnalysisCard.svelte";

  interface Props {
    testId: number | null;
    onclose: () => void;
  }

  let { testId, onclose }: Props = $props();

  let test = $state<TestDetail | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  // Backdrop element bound from the template — focused on open so
  // keyboard users land inside the dialog instead of staying on the
  // page underneath. Required by WCAG focus-management for modals.
  let backdropEl = $state<HTMLDivElement | null>(null);

  // AI is configured instance-wide, so fetch the flag once on mount (this
  // effect reads no reactive state, so it does not re-run). Gates the
  // AI-analysis comment in the Notes panel.
  let aiEnabled = $state(false);
  $effect(() => {
    checkAIEnabled().then((v) => { aiEnabled = v; }).catch(() => {});
  });

  $effect(() => {
    if (testId && backdropEl) backdropEl.focus();
  });

  // Keyboard activation helper for elements that have onclick but
  // aren't <button>/<a>. Re-dispatches the synthetic click on Enter
  // or Space so the existing onclick handler runs unchanged — keeps
  // the markup DRY (one keydown call per row instead of duplicating
  // each click handler's body). Used by the gherkin command-log
  // <li> rows below.
  function onActivate(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      (e.currentTarget as HTMLElement).click();
    }
  }

  interface SnapshotStep {
    index: number;
    commandName: string;
    commandMessage: string;
    console?: ConsoleEntryLite[];
    network?: NetworkEntryLite[];
  }
  let snapshotSteps = $state<SnapshotStep[]>([]);
  let collapsedGroups = $state<Set<number>>(new Set());

  interface SnapshotGroup {
    headerIdx: number | null;      // snapshotSteps index of the gherkin marker, or null for synthetic pre-first-gherkin "Setup"
    headerLabel: string;            // e.g. "Given I do X" or "Setup"
    headerKeyword: string;          // e.g. "GHERKIN" or "SETUP"
    childIdxs: number[];            // snapshotSteps indexes of non-gherkin children
  }
  let snapshotGroups = $derived.by<SnapshotGroup[]>(() => {
    const groups: SnapshotGroup[] = [];
    let current: SnapshotGroup | null = null;
    snapshotSteps.forEach((s, i) => {
      if (s.commandName === "gherkin") {
        current = { headerIdx: i, headerLabel: s.commandMessage, headerKeyword: "GHERKIN", childIdxs: [] };
        groups.push(current);
      } else {
        if (!current) {
          current = { headerIdx: null, headerLabel: "Setup (before hooks)", headerKeyword: "SETUP", childIdxs: [] };
          groups.push(current);
        }
        current.childIdxs.push(i);
      }
    });
    return groups;
  });

  // Group the raw command_log by Gherkin keywords when present. Each
  // Given/When/Then/And/But/Before entry becomes a collapsible section
  // header; preceding cypress primitives (get/click/assert/...) roll up
  // into a synthetic "Setup" group. Non-Cucumber projects have no Gherkin
  // keywords, so `hasCommandGherkinGroups` stays false and the flat list
  // renders unchanged.
  const GHERKIN_RE = /^(Given|When|Then|And|But)\s*$/;
  interface CommandGroup {
    headerIdx: number | null;
    headerLabel: string;
    headerKeyword: string;
    childIdxs: number[];
  }
  let commandGroups = $derived.by<CommandGroup[]>(() => {
    const log = test?.command_log ?? [];
    const groups: CommandGroup[] = [];
    let current: CommandGroup | null = null;
    log.forEach((cmd, i) => {
      const name = (cmd as { name?: string }).name ?? "";
      const message = (cmd as { message?: string }).message ?? "";
      if (GHERKIN_RE.test(name)) {
        current = { headerIdx: i, headerLabel: message, headerKeyword: name.trim().toUpperCase(), childIdxs: [] };
        groups.push(current);
      } else if (name === "BeforeStep" || name === "AfterStep") {
        // Noise — cucumber-preprocessor lifecycle markers. Swallow: the
        // following Given/When/Then entry carries the real label.
      } else {
        if (!current) {
          current = { headerIdx: null, headerLabel: "Setup", headerKeyword: "SETUP", childIdxs: [] };
          groups.push(current);
        }
        current.childIdxs.push(i);
      }
    });
    return groups;
  });
  let hasCommandGherkinGroups = $derived(commandGroups.some((g) => g.headerKeyword !== "SETUP"));

  // Pure mapping logic lives in $lib/utils/snapshot-match (unit-tested via
  // snapshot-match.test.ts). These wrappers bind the current
  // commandGroups + snapshotSteps so the template stays terse.
  function snapshotIdxForCommandGroup(gIdx: number): number | null {
    return snapshotIdxForCommandGroupPure(commandGroups as PureCommandGroup[], snapshotSteps, gIdx);
  }
  function snapshotIdxForCommandChild(gIdx: number, childPos: number): number | null {
    return snapshotIdxForCommandChildPure(commandGroups as PureCommandGroup[], snapshotSteps, gIdx, childPos);
  }

  function toggleGroup(g: number) {
    const next = new Set(collapsedGroups);
    if (next.has(g)) next.delete(g); else next.add(g);
    collapsedGroups = next;
  }

  // All groups are considered collapsed once the collapsed set covers every
  // group index in the active list (command groups or snapshot groups).
  function allGroupsCollapsed(count: number): boolean {
    return count > 0 && collapsedGroups.size >= count;
  }

  function toggleAllGroups(count: number) {
    collapsedGroups = allGroupsCollapsed(count)
      ? new Set()
      : new Set(Array.from({ length: count }, (_, i) => i));
  }

  // Left panel state
  let leftTab = $state<"screenshot" | "video" | "snapshot">("screenshot");
  let currentScreenshot = $state(0);
  let lightboxOpen = $state(false);
  let lightboxIndex = $state(0);

  // Right panel state
  let rightTab = $state<"info" | "commands" | "code" | "details" | "history" | "notes">("info");
  let history = $state<TestHistoryEntry[]>([]);
  let historyLoaded = $state(false);
  let stackExpanded = $state(false);

  // React ONLY to testId. loadTest reads historyLoaded/history synchronously
  // before its first await, so without untrack those become effect deps —
  // and the first History-tab click (which sets historyLoaded) would re-run
  // loadTest and reset the whole modal. untrack keeps testId the sole trigger.
  $effect(() => {
    const id = testId;
    if (id) {
      untrack(() => {
        originalTestId = null;
        loadTest(id);
      });
    }
  });

  async function loadTest(id: number) {
    const preserveHistory = historyLoaded && history.length > 0;
    loading = true;
    error = null;
    currentScreenshot = 0;
    stackExpanded = false;
    leftPct = 50;
    snapshotStep = 0;
    lockedStep = null;
    hoverStep = null;
    collapsedGroups = new Set();
    if (!preserveHistory) {
      history = [];
      historyLoaded = false;
    }
    try {
      test = await fetchTest(id);
      snapshotSteps = [];
      if (test.snapshot_path) {
        leftTab = "snapshot";
        loadSnapshotSteps(test.snapshot_path);
      }
      else if (test.screenshot_paths?.length) leftTab = "screenshot";
      else if (test.video_path) leftTab = "video";
      else leftTab = "screenshot";

      if (!preserveHistory) {
        if (test.snapshot_path) rightTab = "commands";
        else if (test.error_message) rightTab = "info";
        else if (test.metadata && Object.keys(test.metadata).length > 0) rightTab = "details";
        else if (test.command_log?.length) rightTab = "commands";
        else if (test.test_code) rightTab = "code";
        else rightTab = "info";
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load test";
    } finally {
      loading = false;
    }
  }

  async function loadSnapshotSteps(path: string) {
    try {
      const res = await authFetch(`${UPLOADS_URL}/${path}`);
      if (!res.ok) return;
      const ds = new DecompressionStream("gzip");
      const decompressed = res.body!.pipeThrough(ds);
      const blob = await new Response(decompressed).blob();
      const bundle = JSON.parse(await blob.text());
      if (Array.isArray(bundle?.steps)) snapshotSteps = bundle.steps;
    } catch { /* ignore — viewer will surface errors */ }
  }

  function navigate(id: number | null) {
    if (id) loadTest(id);
  }

  let originalTestId = $state<number | null>(null);

  async function loadHistory() {
    if (historyLoaded || !test) return;
    try {
      const data = await fetchTestHistory(test.id);
      history = data.history;
    } catch {
      history = [];
    }
    historyLoaded = true;
  }

  function selectHistoryTab() {
    rightTab = "history";
    loadHistory();
  }

  function viewHistoryEntry(entryTestId: number) {
    if (!originalTestId) originalTestId = test?.id ?? null;
    loadTest(entryTestId).then(() => {
      // Preserve the history tab and data when navigating between history entries
      rightTab = "history";
    });
  }

  function backToOriginal() {
    if (originalTestId) {
      const id = originalTestId;
      originalTestId = null;
      loadTest(id);
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (lightboxOpen) return;
    if (!testId) return;
    if (e.key === "Escape") onclose();
    if (e.key === "ArrowLeft" && test?.prev_failed_id) navigate(test.prev_failed_id);
    if (e.key === "ArrowRight" && test?.next_failed_id) navigate(test.next_failed_id);
  }

  // Build a best-effort rerun command for the failed test. We don't
  // know the test runner up-front, so prefer Playwright (--grep) when
  // metadata.error_type or file extension hints at it; fall back to
  // a generic `<runner> "<title>" <file>` line. Users edit one token.
  function rerunCommand(t: TestDetail): string {
    const file = t.file_path ?? "";
    const title = t.full_title ?? t.title ?? "";
    if (/\.feature$/.test(file)) return `cypress run --spec ${file}`;
    if (/\.cy\.[jt]sx?$/.test(file)) return `cypress run --spec ${file}`;
    if (/\.spec\.[jt]sx?$/.test(file)) return `npx playwright test ${file} -g ${JSON.stringify(title)}`;
    if (/\.test\.[jt]sx?$/.test(file)) return `npx vitest run ${file} -t ${JSON.stringify(title)}`;
    if (/\.py$/.test(file)) return `pytest ${file} -k ${JSON.stringify(title)}`;
    if (/\.java$/.test(file)) return `mvn test -Dtest=${title.replace(/\s+/g, "")}`;
    if (/\.rb$/.test(file)) return `rspec ${file} -e ${JSON.stringify(title)}`;
    if (/\.go$/.test(file)) return `go test ./... -run ${JSON.stringify(title.replace(/\s+/g, "_"))}`;
    return `# rerun ${file} :: ${title}`;
  }

  // Recently-copied marker: short-lived $state per button so the
  // copy-btn check icon flashes only on the just-clicked button. Map
  // key is a short tag ("error", "stack", "rerun", "md").
  let copiedKey = $state<string | null>(null);
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;
  function flashCopied(key: string) {
    copiedKey = key;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copiedKey = null; copiedTimer = null; }, 1400);
  }
  async function copyText(text: string, key: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      flashCopied(key);
      toastSuccess(`${label} copied`);
    } catch {
      toastInfo("Clipboard unavailable");
    }
  }
  function copyError() {
    if (!test?.error_message) return;
    copyText(test.error_message, "error", "Error message");
  }
  function copyStack() {
    if (!test?.error_stack) return;
    copyText(test.error_stack, "stack", "Stack trace");
  }
  function copyRerun() {
    if (!test) return;
    copyText(rerunCommand(test), "rerun", "Rerun command");
  }
  function copyMarkdown() {
    if (!test) return;
    // Deep link straight back to this test (the run page reads ?test=<id>) so
    // a reviewer reading the pasted report can click through to the evidence
    // instead of hunting through the run for the failure.
    const runUrl = `${window.location.origin}/runs/${test.run_id}?test=${test.id}`;
    const lines = [
      `### ${test.full_title}`,
      ``,
      `- **Status:** ${test.status}`,
      `- **Spec:** \`${test.file_path}\``,
      `- **Duration:** ${formatDuration(test.duration_ms)}`,
      `- **Run:** [#${test.run_id}](${runUrl})`,
      ``,
    ];
    if (test.error_message) {
      lines.push("**Error:**", "```", test.error_message, "```", "");
    }
    if (test.error_stack) {
      lines.push("**Stack:**", "```", test.error_stack, "```", "");
    }
    lines.push("**Rerun:**", "```sh", rerunCommand(test), "```");
    copyText(lines.join("\n"), "md", "Markdown report");
  }

  let screenshotUrls = $derived(
    (test?.screenshot_paths ?? []).map((p) =>
      // artifactSrc encodes the path and appends ?token= so the new
      // auth+ownership check on /uploads/* lets <img> render.
      artifactSrc(p.split("/").map(encodeURIComponent).join("/"))
    )
  );

  let hasScreenshots = $derived(screenshotUrls.length > 0);
  let hasVideo = $derived(!!test?.video_path);
  let hasCode = $derived(!!test?.test_code);
  let hasCommands = $derived((test?.command_log?.length ?? 0) > 0);
  let hasSnapshotSteps = $derived(snapshotSteps.length > 0);
  let hasSnapshot = $derived(!!test?.snapshot_path);
  let snapshotStep = $state(0);
  let lockedStep = $state<number | null>(null);
  let hoverStep = $state<number | null>(null);
  let activeSnapshotStep = $derived(hoverStep ?? lockedStep ?? snapshotStep);
  let meta = $derived(test?.metadata);
  let hasMetadata = $derived(!!meta && (
    (meta.retries?.length ?? 0) > 0 ||
    (meta.annotations?.length ?? 0) > 0 ||
    (meta.tags?.length ?? 0) > 0 ||
    (meta.stdout?.length ?? 0) > 0 ||
    (meta.stderr?.length ?? 0) > 0 ||
    !!meta.location ||
    !!meta.classname ||
    !!meta.error_type ||
    !!meta.properties ||
    !!meta.hostname ||
    !!meta.skip_message
  ));

  // Cypress failure-context (Phase 13): browser console, network failures,
  // uncaught errors, and the per-attempt retry trail. Captured by
  // @flakeytesting/cypress-reporter and stored on tests.failure_context, but
  // until now rendered nowhere — surfaced here in the Details tab alongside the
  // Playwright metadata genre (retries/stdout/stderr) it mirrors.
  let fc = $derived(test?.failure_context);
  let hasFailureContext = $derived(!!fc && (
    (fc.browser_console?.length ?? 0) > 0 ||
    (fc.network_failures?.length ?? 0) > 0 ||
    (fc.uncaught_errors?.length ?? 0) > 0 ||
    (fc.retry_errors?.length ?? 0) > 0
  ));

  // Resizable split pane
  let splitRef = $state<HTMLDivElement | null>(null);
  let leftPct = $state(50);
  let dragging = $state(false);

  function onDragStart(e: MouseEvent) {
    e.preventDefault();
    dragging = true;

    function onMove(e: MouseEvent) {
      if (!splitRef) return;
      const rect = splitRef.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      leftPct = Math.max(20, Math.min(80, pct));
    }

    function onUp() {
      dragging = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if testId}
  <!--
    Click anywhere on the backdrop closes the modal — checked via
    `e.target === e.currentTarget` so clicks on the inner debugger
    don't bubble up and trigger close. This replaces the previous
    `onclick={(e) => e.stopPropagation()}` on the inner div, which
    Svelte's a11y lint correctly flagged as a non-interactive
    element with a click handler.

    tabindex="-1" + the bind:this/focus() in $effect makes the
    dialog focusable so keyboard users get focus moved into the
    modal on open; Tab then traps within (no formal focus trap yet
    — that's a follow-up).

    The Escape key closes via the <svelte:window onkeydown> handler
    above, which is the canonical kbd alternative to clicking the
    backdrop.
  -->
  <div
    bind:this={backdropEl}
    class="backdrop"
    onclick={(e) => { if (e.target === e.currentTarget) onclose(); }}
    onkeydown={(e) => { if (e.key === "Escape") onclose(); }}
    role="dialog"
    aria-modal="true"
    tabindex="-1"
  >
    <div class="debugger">
      {#if loading}
        <div class="debugger-loading">Loading...</div>
      {:else if error}
        <div class="debugger-error">{error}</div>
      {:else if test}
        <!-- Top bar -->
        <header class="topbar status-{test.status}">
          <div class="topbar-left">
            <span class="badge {test.status}">{test.status.toUpperCase()}</span>
            <h2 class="topbar-title" title={test.full_title}>{test.title}</h2>
          </div>
          <div class="topbar-right">
            {#if test.failed_total > 0}
              <div class="nav-group" title="Use ← / → to step through failures">
                <button
                  class="nav-arrow"
                  disabled={!test.prev_failed_id}
                  onclick={() => navigate(test?.prev_failed_id ?? null)}
                  title="Previous failure (←)"
                  aria-label="Previous failure"
                >&#8249;</button>
                <span class="nav-label">{test.failed_index}/{test.failed_total}</span>
                <button
                  class="nav-arrow"
                  disabled={!test.next_failed_id}
                  onclick={() => navigate(test?.next_failed_id ?? null)}
                  title="Next failure (→)"
                  aria-label="Next failure"
                >&#8250;</button>
              </div>
            {/if}
            <button class="close-btn" onclick={onclose} title="Close (Esc)" aria-label="Close">&#10005;</button>
          </div>
        </header>

        <!-- Info strip: file:line, duration, run link, tags, annotations -->
        <div class="info-strip">
          <span class="info-chip mono" title={test.file_path}>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 2h6l4 4v8H3z"/><path d="M9 2v4h4"/></svg>
            {test.file_path}{#if meta?.location}:{meta.location.line}{/if}
          </span>
          <span class="info-chip" title="Duration">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="8" cy="9" r="5"/><path d="M8 6v3l2 1"/><path d="M6 1h4"/></svg>
            {formatDuration(test.duration_ms)}
          </span>
          <a href="/runs/{test.run_id}" class="info-chip info-chip-link" onclick={onclose} title="Open run #{test.run_id}">
            Run #{test.run_id}
          </a>
          {#if meta?.tags?.length}
            {#each meta.tags as tag}
              <span class="tag-pill">{tag}</span>
            {/each}
          {/if}
          {#if meta?.annotations?.length}
            {#each meta.annotations as ann}
              <span class="annotation-pill {ann.type}" title={ann.description ?? ""}>{ann.type}</span>
            {/each}
          {/if}
          <div class="info-strip-actions">
            <button class="copy-btn" onclick={copyRerun} title="Copy rerun command for this test">
              {#if copiedKey === "rerun"}
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 8l3 3 7-7"/></svg>
                Copied
              {:else}
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><polyline points="4,4 4,1 12,1 12,9 9,9"/><rect x="1" y="4" width="9" height="11"/></svg>
                Rerun
              {/if}
            </button>
            <button class="copy-btn" onclick={copyMarkdown} title="Copy a Markdown summary of this failure">
              {#if copiedKey === "md"}
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 8l3 3 7-7"/></svg>
                Copied
              {:else}
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><polyline points="4,4 4,1 12,1 12,9 9,9"/><rect x="1" y="4" width="9" height="11"/></svg>
                Markdown
              {/if}
            </button>
          </div>
        </div>

        <!-- Split panes -->
        <div class="split" class:dragging bind:this={splitRef}>
          <!-- LEFT: Visual evidence -->
          <div class="pane pane-left" style:width="calc({leftPct}% - 3px)">
            <div class="pane-tabs">
              {#if hasScreenshots}
                <button class="pane-tab" class:active={leftTab === "screenshot"} onclick={() => leftTab = "screenshot"}>
                  Screenshots ({screenshotUrls.length})
                </button>
              {/if}
              {#if hasVideo}
                <button class="pane-tab" class:active={leftTab === "video"} onclick={() => leftTab = "video"}>
                  Video
                </button>
              {/if}
              {#if hasSnapshot}
                <button class="pane-tab" class:active={leftTab === "snapshot"} onclick={() => leftTab = "snapshot"}>
                  Snapshot
                </button>
              {/if}
              {#if !hasScreenshots && !hasVideo && !hasSnapshot}
                <span class="pane-tab active">Visual</span>
              {/if}
            </div>

            <div class="pane-content">
              {#if leftTab === "screenshot" && hasScreenshots}
                <div class="screenshot-viewer">
                  <button class="screenshot-main" onclick={() => { lightboxIndex = currentScreenshot; lightboxOpen = true; }}>
                    <img src={screenshotUrls[currentScreenshot]} alt="Screenshot {currentScreenshot + 1}" />
                    <span class="zoom-hint">Click to zoom</span>
                  </button>
                  {#if screenshotUrls.length > 1}
                    <div class="screenshot-strip">
                      {#each screenshotUrls as url, i}
                        <button
                          class="strip-thumb"
                          class:active={currentScreenshot === i}
                          onclick={() => currentScreenshot = i}
                        >
                          <img src={url} alt="Thumb {i + 1}" />
                        </button>
                      {/each}
                    </div>
                  {/if}
                </div>

              {:else if leftTab === "video" && hasVideo}
                <div class="video-viewer">
                  <video controls src={artifactSrc(test.video_path)}>
                    <track kind="captions" />
                  </video>
                </div>

              {:else if leftTab === "snapshot" && hasSnapshot}
                <SnapshotViewer snapshotPath={test.snapshot_path!} selectedStep={activeSnapshotStep} />

              {:else}
                <div class="empty-visual">
                  <div class="empty-icon">&#128247;</div>
                  <p>No visual evidence captured.</p>
                  <p class="empty-hint">Screenshots are captured on failure by default.<br/>Enable video recording in your test config.</p>
                </div>
              {/if}
            </div>
          </div>

          <!-- Drag handle -->
          <!--
            Window-splitter pattern from WAI-ARIA APG: role="separator"
            with aria-orientation + aria-valuenow + tabindex + arrow
            keys (5%-per-keypress) is the explicit interactive-separator
            pattern. Svelte's lint flags any non-button element with
            tabindex/onkeydown as "non-interactive", but APG sanctions
            this exact shape: https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/
            Without the kbd handler keyboard users had no way to resize.
          -->
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <div
            class="drag-handle"
            role="separator"
            aria-orientation="vertical"
            aria-valuenow={Math.round(leftPct)}
            aria-valuemin="20"
            aria-valuemax="80"
            tabindex="0"
            onmousedown={onDragStart}
            onkeydown={(e) => {
              if (e.key === "ArrowLeft") { e.preventDefault(); leftPct = Math.max(20, leftPct - 5); }
              else if (e.key === "ArrowRight") { e.preventDefault(); leftPct = Math.min(80, leftPct + 5); }
            }}
          >
            <div class="drag-line"></div>
          </div>

          <!-- RIGHT: Debug tools -->
          <div class="pane pane-right" style:width="calc({100 - leftPct}% - 3px)">
            {#if test.error_message}
              <!--
                Persistent error block. The error message is THE answer
                this modal exists to show — it should never be hidden
                behind a tab. Lives above .pane-tabs so it's visible
                regardless of which tab is selected. The Info tab below
                still shows test metadata, just no longer duplicates the
                error block. e2e selector contract: `.error-msg` lives
                under `.error-block` (was `.info-panel .error-msg`).
              -->
              <div class="error-block">
                <div class="error-block-head">
                  <span class="error-label">Error</span>
                  <div class="error-block-actions">
                    <button class="copy-btn" onclick={copyError} title="Copy error message">
                      {#if copiedKey === "error"}
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 8l3 3 7-7"/></svg>
                        Copied
                      {:else}
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><polyline points="4,4 4,1 12,1 12,9 9,9"/><rect x="1" y="4" width="9" height="11"/></svg>
                        Copy
                      {/if}
                    </button>
                  </div>
                </div>
                <pre class="error-msg">{test.error_message}</pre>
                {#if test.error_stack}
                  <div class="error-block-stack">
                    <button class="stack-toggle" onclick={() => stackExpanded = !stackExpanded} aria-expanded={stackExpanded}>
                      <span class="toggle-icon" aria-hidden="true">{stackExpanded ? "▾" : "▸"}</span>
                      Stack trace
                    </button>
                    {#if stackExpanded}
                      <button class="copy-btn copy-btn-inline" onclick={copyStack} title="Copy stack trace">
                        {#if copiedKey === "stack"}
                          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 8l3 3 7-7"/></svg>
                          Copied
                        {:else}
                          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><polyline points="4,4 4,1 12,1 12,9 9,9"/><rect x="1" y="4" width="9" height="11"/></svg>
                          Copy stack
                        {/if}
                      </button>
                    {/if}
                  </div>
                  {#if stackExpanded}
                    <pre class="stack-trace">{test.error_stack}</pre>
                  {/if}
                {/if}
                {#if meta?.error_snippet}
                  <div class="error-label error-label-snippet">Code snippet</div>
                  <pre class="code-snippet">{meta.error_snippet}</pre>
                {/if}
              </div>

              <!-- AI failure analysis sits directly beneath the error it
                   describes (the Amazon "Customers say" inline-summary
                   pattern) — a glanceable, badged insight, not a comment in
                   the human notes thread. Only for failed tests. -->
              {#if test.status === "failed"}
                {#key test.id}
                  <AIAnalysisCard testId={test.id} enabled={aiEnabled} />
                {/key}
              {/if}
            {/if}

            <div class="pane-tabs">
              <button class="pane-tab" class:active={rightTab === "info"} onclick={() => rightTab = "info"}>
                Info
              </button>
              <button class="pane-tab" class:active={rightTab === "commands"} onclick={() => rightTab = "commands"}>
                Commands {hasCommands ? `(${test.command_log?.length})` : hasSnapshotSteps ? `(${snapshotSteps.length})` : ""}
              </button>
              {#if hasCode}
                <button class="pane-tab" class:active={rightTab === "code"} onclick={() => rightTab = "code"}>
                  Source
                </button>
              {/if}
              {#if hasMetadata || hasFailureContext}
                <button class="pane-tab" class:active={rightTab === "details"} onclick={() => rightTab = "details"}>
                  Details
                </button>
              {/if}
              <button class="pane-tab" class:active={rightTab === "history"} onclick={selectHistoryTab}>
                History
              </button>
              <button class="pane-tab" class:active={rightTab === "notes"} onclick={() => rightTab = "notes"}>
                Notes
              </button>
            </div>

            <div class="pane-content">
              {#if rightTab === "info"}
                <div class="info-panel">
                  <div class="info-details">
                    <div class="detail-row">
                      <span class="detail-key">Test</span>
                      <span class="detail-val">{test.full_title}</span>
                    </div>
                    <div class="detail-row">
                      <span class="detail-key">Spec</span>
                      <span class="detail-val mono">{test.file_path}</span>
                    </div>
                    <div class="detail-row">
                      <span class="detail-key">Status</span>
                      <span class="detail-val"><span class="info-status {test.status}">{test.status}</span></span>
                    </div>
                    <div class="detail-row">
                      <span class="detail-key">Duration</span>
                      <span class="detail-val mono">{formatDuration(test.duration_ms)}</span>
                    </div>
                    <div class="detail-row">
                      <span class="detail-key">Run</span>
                      <a href="/runs/{test.run_id}" class="detail-link" onclick={onclose}>#{test.run_id}</a>
                    </div>
                  </div>

                  <div class="info-rerun">
                    <div class="info-rerun-head">
                      <span class="error-label">Rerun this test</span>
                      <button class="copy-btn copy-btn-inline" onclick={copyRerun} title="Copy rerun command">
                        {#if copiedKey === "rerun"}
                          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 8l3 3 7-7"/></svg>
                          Copied
                        {:else}
                          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><polyline points="4,4 4,1 12,1 12,9 9,9"/><rect x="1" y="4" width="9" height="11"/></svg>
                          Copy
                        {/if}
                      </button>
                    </div>
                    <pre class="rerun-cmd">{rerunCommand(test)}</pre>
                  </div>
                </div>

              {:else if rightTab === "commands"}
                {#if hasCommands && hasCommandGherkinGroups}
                  <div class="commands-panel">
                    <div class="commands-header">
                      <span class="commands-title">Command Log</span>
                      <div class="commands-meta">
                        <span class="commands-count">{test.command_log?.length} steps</span>
                        <button type="button" class="collapse-toggle"
                          onclick={() => toggleAllGroups(commandGroups.length)}
                          title={allGroupsCollapsed(commandGroups.length) ? "Expand all steps" : "Collapse all steps"}>
                          {allGroupsCollapsed(commandGroups.length) ? "Expand all" : "Collapse all"}
                        </button>
                      </div>
                    </div>
                    <ol class="command-list" onmouseleave={() => hoverStep = null}>
                      {#each commandGroups as group, g}
                        {@const isOpen = !collapsedGroups.has(g)}
                        {@const cmdLog = test?.command_log ?? []}
                        {@const headerCmd = group.headerIdx !== null ? cmdLog[group.headerIdx] : null}
                        {@const groupFailed = (headerCmd?.state === "failed") || group.childIdxs.some((i) => cmdLog[i]?.state === "failed")}
                        {@const groupSnapIdx = snapshotIdxForCommandGroup(g)}
                        {@const groupHasSnap = hasSnapshot && groupSnapIdx !== null}
                        {#if group.headerIdx !== null}
                          <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role: each row in command-list is a button in a list, modelled as <li role="button"> per WAI-ARIA role override; native <button> would either drop list semantics or require a refactor of all .cmd CSS selectors. The onActivate keydown + tabindex=0 provide real keyboard activation. -->
                          <li role="button" tabindex="0" onkeydown={onActivate}
                            class="cmd cmd-clickable cmd-gherkin"
                            class:cmd-failed={groupFailed}
                            class:cmd-no-snap={hasSnapshot && groupSnapIdx === null}
                            class:cmd-active={groupHasSnap && activeSnapshotStep === groupSnapIdx}
                            class:cmd-locked={groupHasSnap && lockedStep === groupSnapIdx}
                            onmouseenter={() => { if (groupHasSnap) { hoverStep = groupSnapIdx; leftTab = "snapshot"; } }}
                            onclick={() => {
                              toggleGroup(g);
                              if (!hasSnapshot) return;
                              if (groupSnapIdx === null) {
                                toastInfo("No snapshot captured for this step");
                                return;
                              }
                              lockedStep = groupSnapIdx;
                              snapshotStep = groupSnapIdx;
                              leftTab = "snapshot";
                            }}
                          >
                            <span class="cmd-num">{(group.headerIdx ?? 0) + 1}</span>
                            <span class="cmd-body">
                              <span class="cmd-chevron">{isOpen ? "▾" : "▸"}</span>
                              <span class="cmd-name">{group.headerKeyword}</span>
                              <span class="cmd-arg">{group.headerLabel}</span>
                            </span>
                            <span class="cmd-group-count">{group.childIdxs.length}</span>
                          </li>
                        {:else}
                          <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role: each row in command-list is a button in a list, modelled as <li role="button"> per WAI-ARIA role override; native <button> would either drop list semantics or require a refactor of all .cmd CSS selectors. The onActivate keydown + tabindex=0 provide real keyboard activation. -->
                          <li role="button" tabindex="0" onkeydown={onActivate}
                            class="cmd cmd-clickable cmd-setup"
                            class:cmd-failed={groupFailed}
                            class:cmd-no-snap={hasSnapshot && groupSnapIdx === null}
                            class:cmd-active={groupHasSnap && activeSnapshotStep === groupSnapIdx}
                            class:cmd-locked={groupHasSnap && lockedStep === groupSnapIdx}
                            onmouseenter={() => { if (groupHasSnap) { hoverStep = groupSnapIdx; leftTab = "snapshot"; } }}
                            onclick={() => {
                              toggleGroup(g);
                              if (!hasSnapshot) return;
                              if (groupSnapIdx === null) {
                                toastInfo("No snapshot captured for this step");
                                return;
                              }
                              lockedStep = groupSnapIdx;
                              snapshotStep = groupSnapIdx;
                              leftTab = "snapshot";
                            }}
                          >
                            <span class="cmd-num"></span>
                            <span class="cmd-body">
                              <span class="cmd-chevron">{isOpen ? "▾" : "▸"}</span>
                              <span class="cmd-name">{group.headerKeyword}</span>
                              <span class="cmd-arg">{group.headerLabel}</span>
                            </span>
                            <span class="cmd-group-count">{group.childIdxs.length}</span>
                          </li>
                        {/if}
                        {#if isOpen}
                          {#each group.childIdxs as i, childPos}
                            {@const cmd = cmdLog[i]}
                            {@const childSnapIdx = snapshotIdxForCommandChild(g, childPos)}
                            {@const childHasSnap = hasSnapshot && childSnapIdx !== null}
                            {@const childDiag = childHasSnap ? stepDiagnostics(snapshotSteps[childSnapIdx!]) : null}
                            {#if cmd}
                              <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role: each row in command-list is a button in a list, modelled as <li role="button"> per WAI-ARIA role override; native <button> would either drop list semantics or require a refactor of all .cmd CSS selectors. The onActivate keydown + tabindex=0 provide real keyboard activation. -->
                          <li role="button" tabindex="0" onkeydown={onActivate}
                                class="cmd cmd-child"
                                class:cmd-failed={cmd.state === "failed"}
                                class:cmd-no-snap={hasSnapshot && childSnapIdx === null}
                                class:cmd-active={childHasSnap && activeSnapshotStep === childSnapIdx}
                                class:cmd-locked={childHasSnap && lockedStep === childSnapIdx}
                                class:cmd-clickable={hasSnapshot}
                                onmouseenter={() => { if (childHasSnap) { hoverStep = childSnapIdx; leftTab = "snapshot"; } }}
                                onclick={() => {
                                  if (!hasSnapshot) return;
                                  if (childSnapIdx === null) {
                                    toastInfo("No snapshot captured for this step");
                                    return;
                                  }
                                  lockedStep = lockedStep === childSnapIdx ? null : childSnapIdx;
                                  snapshotStep = childSnapIdx;
                                  leftTab = "snapshot";
                                }}
                              >
                                <span class="cmd-num">{i + 1}</span>
                                <span class="cmd-icon">{cmd.state === "failed" ? "\u2717" : "\u2713"}</span>
                                <span class="cmd-body">
                                  <span class="cmd-name">{cmd.name}</span>
                                  {#if cmd.message}<span class="cmd-arg">{cmd.message}</span>{/if}
                                </span>
                                {#if childDiag && childDiag.errorCount > 0}
                                  <span class="cmd-diag-badge has-error" title={`${childDiag.errorCount} console error(s) / failed request(s) on this step`}>{childDiag.errorCount}</span>
                                {:else if childDiag && childDiag.consoleCount + childDiag.networkCount > 0}
                                  <span class="cmd-diag-badge" title={`${childDiag.consoleCount} console · ${childDiag.networkCount} network`}>{childDiag.consoleCount + childDiag.networkCount}</span>
                                {/if}
                              </li>
                            {/if}
                          {/each}
                        {/if}
                      {/each}
                    </ol>
                  </div>
                {:else if hasCommands}
                  <div class="commands-panel">
                    <div class="commands-header">
                      <span class="commands-title">Command Log</span>
                      <span class="commands-count">{test.command_log?.length} steps</span>
                    </div>
                    <ol class="command-list" onmouseleave={() => hoverStep = null}>
                      {#each test.command_log ?? [] as cmd, i}
                        <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role: each row in command-list is a button in a list, modelled as <li role="button"> per WAI-ARIA role override; native <button> would either drop list semantics or require a refactor of all .cmd CSS selectors. The onActivate keydown + tabindex=0 provide real keyboard activation. -->
                          <li role="button" tabindex="0" onkeydown={onActivate}
                          class="cmd"
                          class:cmd-failed={cmd.state === "failed"}
                          class:cmd-active={hasSnapshot && activeSnapshotStep === i}
                          class:cmd-locked={hasSnapshot && lockedStep === i}
                          class:cmd-clickable={hasSnapshot}
                          onmouseenter={() => { if (hasSnapshot) { hoverStep = i; leftTab = "snapshot"; } }}
                          onclick={() => { if (hasSnapshot) { lockedStep = lockedStep === i ? null : i; snapshotStep = i; leftTab = "snapshot"; } }}
                        >
                          <span class="cmd-num">{i + 1}</span>
                          <span class="cmd-icon">{cmd.state === "failed" ? "\u2717" : "\u2713"}</span>
                          <span class="cmd-body">
                            <span class="cmd-name">{cmd.name}</span>
                            {#if cmd.message}<span class="cmd-arg">{cmd.message}</span>{/if}
                          </span>
                        </li>
                      {/each}
                    </ol>
                  </div>
                {:else if hasSnapshotSteps}
                  <div class="commands-panel">
                    <div class="commands-header">
                      <span class="commands-title">Snapshot Steps</span>
                      <div class="commands-meta">
                        <span class="commands-count">{snapshotSteps.length} steps</span>
                        <button type="button" class="collapse-toggle"
                          onclick={() => toggleAllGroups(snapshotGroups.length)}
                          title={allGroupsCollapsed(snapshotGroups.length) ? "Expand all steps" : "Collapse all steps"}>
                          {allGroupsCollapsed(snapshotGroups.length) ? "Expand all" : "Collapse all"}
                        </button>
                      </div>
                    </div>
                    <ol class="command-list" onmouseleave={() => hoverStep = null}>
                      {#each snapshotGroups as group, g}
                        {@const isOpen = !collapsedGroups.has(g)}
                        {#if group.headerIdx !== null}
                          <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role: each row in command-list is a button in a list, modelled as <li role="button"> per WAI-ARIA role override; native <button> would either drop list semantics or require a refactor of all .cmd CSS selectors. The onActivate keydown + tabindex=0 provide real keyboard activation. -->
                          <li role="button" tabindex="0" onkeydown={onActivate}
                            class="cmd cmd-clickable cmd-gherkin"
                            class:cmd-active={activeSnapshotStep === group.headerIdx}
                            class:cmd-locked={lockedStep === group.headerIdx}
                            onmouseenter={() => { hoverStep = group.headerIdx; leftTab = "snapshot"; }}
                            onclick={() => {
                              toggleGroup(g);
                              lockedStep = group.headerIdx;
                              snapshotStep = group.headerIdx!;
                              leftTab = "snapshot";
                            }}
                          >
                            <span class="cmd-num">{(group.headerIdx ?? 0) + 1}</span>
                            <span class="cmd-body">
                              <span class="cmd-chevron">{isOpen ? "▾" : "▸"}</span>
                              <span class="cmd-name">{group.headerKeyword}</span>
                              <span class="cmd-arg">{group.headerLabel}</span>
                            </span>
                            <span class="cmd-group-count">{group.childIdxs.length}</span>
                          </li>
                        {:else}
                          <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role: each row in command-list is a button in a list, modelled as <li role="button"> per WAI-ARIA role override; native <button> would either drop list semantics or require a refactor of all .cmd CSS selectors. The onActivate keydown + tabindex=0 provide real keyboard activation. -->
                          <li role="button" tabindex="0" onkeydown={onActivate}
                            class="cmd cmd-clickable cmd-setup"
                            onclick={() => toggleGroup(g)}
                          >
                            <span class="cmd-num"></span>
                            <span class="cmd-body">
                              <span class="cmd-chevron">{isOpen ? "▾" : "▸"}</span>
                              <span class="cmd-name">{group.headerKeyword}</span>
                              <span class="cmd-arg">{group.headerLabel}</span>
                            </span>
                            <span class="cmd-group-count">{group.childIdxs.length}</span>
                          </li>
                        {/if}
                        {#if isOpen}
                          {#each group.childIdxs as i}
                            {@const diag = stepDiagnostics(snapshotSteps[i])}
                            <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role: each row in command-list is a button in a list, modelled as <li role="button"> per WAI-ARIA role override; native <button> would either drop list semantics or require a refactor of all .cmd CSS selectors. The onActivate keydown + tabindex=0 provide real keyboard activation. -->
                          <li role="button" tabindex="0" onkeydown={onActivate}
                              class="cmd cmd-clickable cmd-child"
                              class:cmd-active={activeSnapshotStep === i}
                              class:cmd-locked={lockedStep === i}
                              onmouseenter={() => { hoverStep = i; leftTab = "snapshot"; }}
                              onclick={() => { lockedStep = lockedStep === i ? null : i; snapshotStep = i; leftTab = "snapshot"; }}
                            >
                              <span class="cmd-num">{i + 1}</span>
                              <span class="cmd-body">
                                <span class="cmd-name">{snapshotSteps[i].commandName}</span>
                                {#if snapshotSteps[i].commandMessage}<span class="cmd-arg">{snapshotSteps[i].commandMessage}</span>{/if}
                              </span>
                              {#if diag.errorCount > 0}
                                <span class="cmd-diag-badge has-error" title={`${diag.errorCount} console error(s) / failed request(s) on this step`}>{diag.errorCount}</span>
                              {:else if diag.consoleCount + diag.networkCount > 0}
                                <span class="cmd-diag-badge" title={`${diag.consoleCount} console · ${diag.networkCount} network`}>{diag.consoleCount + diag.networkCount}</span>
                              {/if}
                            </li>
                          {/each}
                        {/if}
                      {/each}
                    </ol>
                  </div>
                {:else}
                  <div class="empty-panel">
                    <p>No command log available.</p>
                    <p class="empty-hint">No command log was captured for this test.</p>
                  </div>
                {/if}

              {:else if rightTab === "code"}
                <div class="code-panel">
                  <div class="code-header">
                    <span class="code-title">Test Source</span>
                    <span class="code-lang">JavaScript</span>
                  </div>
                  <pre class="code-block"><code>{test.test_code}</code></pre>
                </div>

              {:else if rightTab === "details"}
                <div class="details-panel">
                  {#if meta}
                  {#if meta.retries && meta.retries.length > 0}
                    <div class="details-section">
                      <div class="details-heading">Retry History</div>
                      <div class="retry-timeline">
                        {#each meta.retries as attempt}
                          <div class="retry-row" class:retry-fail={attempt.status === "failed" || attempt.status === "timedOut"}>
                            <span class="retry-attempt">Attempt {attempt.attempt}</span>
                            <span class="retry-status {attempt.status}">{attempt.status}</span>
                            <span class="retry-dur">{formatDuration(attempt.duration)}</span>
                            {#if attempt.error}
                              <span class="retry-error">{attempt.error.message}</span>
                            {/if}
                          </div>
                        {/each}
                      </div>
                    </div>
                  {/if}

                  {#if meta.annotations && meta.annotations.length > 0}
                    <div class="details-section">
                      <div class="details-heading">Annotations</div>
                      <div class="annotation-list">
                        {#each meta.annotations as ann}
                          <div class="annotation-row">
                            <span class="annotation-type {ann.type}">{ann.type}</span>
                            {#if ann.description}
                              <span class="annotation-desc">{ann.description}</span>
                            {/if}
                          </div>
                        {/each}
                      </div>
                    </div>
                  {/if}

                  {#if meta.location}
                    <div class="details-section">
                      <div class="details-heading">Source Location</div>
                      <code class="location-value">{meta.location.file}:{meta.location.line}:{meta.location.column}</code>
                    </div>
                  {/if}

                  {#if meta.stdout && meta.stdout.length > 0}
                    <div class="details-section">
                      <div class="details-heading">stdout</div>
                      <pre class="console-output">{meta.stdout.join("\n")}</pre>
                    </div>
                  {/if}

                  {#if meta.stderr && meta.stderr.length > 0}
                    <div class="details-section">
                      <div class="details-heading">stderr</div>
                      <pre class="console-output stderr">{meta.stderr.join("\n")}</pre>
                    </div>
                  {/if}

                  {#if meta.error_type || meta.classname || meta.hostname || meta.skip_message}
                    <div class="details-section">
                      <div class="details-heading">Test Info</div>
                      <div class="info-grid">
                        {#if meta.error_type}
                          <span class="info-key">Exception</span>
                          <code class="info-val">{meta.error_type}</code>
                        {/if}
                        {#if meta.classname}
                          <span class="info-key">Class</span>
                          <code class="info-val">{meta.classname}</code>
                        {/if}
                        {#if meta.hostname}
                          <span class="info-key">Host</span>
                          <span class="info-val">{meta.hostname}</span>
                        {/if}
                        {#if meta.skip_message}
                          <span class="info-key">Skip reason</span>
                          <span class="info-val">{meta.skip_message}</span>
                        {/if}
                      </div>
                    </div>
                  {/if}

                  {#if meta.properties && Object.keys(meta.properties).length > 0}
                    <div class="details-section">
                      <div class="details-heading">Properties</div>
                      <div class="props-table">
                        {#each Object.entries(meta.properties) as [key, value]}
                          <div class="prop-row">
                            <span class="prop-key">{key}</span>
                            <span class="prop-val">{value}</span>
                          </div>
                        {/each}
                      </div>
                    </div>
                  {/if}
                  {/if}

                  <!--
                    Cypress failure-context (Phase 13). Captured browser-side by
                    @flakeytesting/cypress-reporter; the runtime diagnostics a
                    red actually needs. Each block renders only when present.
                  -->
                  {#if fc?.uncaught_errors && fc.uncaught_errors.length > 0}
                    <div class="details-section">
                      <div class="details-heading">Uncaught Errors</div>
                      <pre class="console-output stderr">{fc.uncaught_errors.join("\n\n")}</pre>
                    </div>
                  {/if}

                  {#if fc?.browser_console && fc.browser_console.length > 0}
                    <div class="details-section">
                      <div class="details-heading">Browser Console</div>
                      <pre class="console-output">{#each fc.browser_console as line}<span class="console-line" class:console-err={line.startsWith("error:")} class:console-warn={line.startsWith("warn:")}>{line}</span>{"\n"}{/each}</pre>
                    </div>
                  {/if}

                  {#if fc?.network_failures && fc.network_failures.length > 0}
                    <div class="details-section">
                      <div class="details-heading">Network Failures</div>
                      <ul class="diag-list">
                        {#each fc.network_failures as line}
                          <li class="diag-net">{line}</li>
                        {/each}
                      </ul>
                    </div>
                  {/if}

                  {#if fc?.retry_errors && fc.retry_errors.length > 0}
                    <div class="details-section">
                      <div class="details-heading">Retry Errors</div>
                      <div class="retry-timeline">
                        {#each fc.retry_errors as attempt}
                          <div class="retry-row retry-fail">
                            <span class="retry-attempt">Attempt {attempt.attempt + 1}</span>
                            <span class="retry-error">{attempt.message}</span>
                          </div>
                        {/each}
                      </div>
                    </div>
                  {/if}
                </div>

              {:else if rightTab === "history"}
                <div class="history-panel">
                  {#if originalTestId}
                    <button class="history-back" onclick={backToOriginal}>
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 3L5 8l5 5"/></svg>
                      Back to current run
                    </button>
                  {/if}
                  {#if !historyLoaded}
                    <p class="history-loading">Loading history...</p>
                  {:else if history.length === 0}
                    <p class="history-empty">No history found for this test.</p>
                  {:else}
                    <div class="history-timeline">
                      {#each history as entry}
                        <button class="history-entry" class:active={entry.test_id === test?.id} onclick={() => viewHistoryEntry(entry.test_id)}>
                          <div class="history-dot {entry.status}"></div>
                          <div class="history-content">
                            <div class="history-top">
                              <span class="history-status {entry.status}">{entry.status}</span>
                              <span class="history-dur">{formatDuration(entry.duration_ms)}</span>
                              <span class="history-time" title={absoluteDate(entry.created_at)}>{timeAgo(entry.created_at)}</span>
                            </div>
                            <div class="history-bottom">
                              <span class="history-run">Run #{entry.run_id}</span>
                              <span class="history-branch">{entry.branch || "—"}</span>
                              {#if entry.error_message}
                                <span class="history-error">{entry.error_message}</span>
                              {/if}
                            </div>
                          </div>
                        </button>
                      {/each}
                    </div>
                  {/if}
                </div>

              {:else if rightTab === "notes"}
                <div class="notes-tab">
                  {#key test.id}
                    <NotesPanel targetType="test" targetKey={test.full_title + '|' + test.file_path} />
                  {/key}
                </div>
              {/if}
            </div>
          </div>
        </div>
      {/if}
    </div>
  </div>

  <Lightbox
    images={screenshotUrls}
    paths={test?.screenshot_paths ?? []}
    bind:index={lightboxIndex}
    open={lightboxOpen}
    onclose={() => lightboxOpen = false}
  />
{/if}

<style>
  /* Backdrop & container */
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
  }

  .debugger {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    width: 100%;
    /* Was 1200px — left ~1300 px of dead space inside the backdrop
       on a 2K monitor when the snapshot + command panes both need
       width. 1800 px matches the .page cap pattern and gives each
       pane ~900 px before the splitter eats some. */
    max-width: 1800px;
    height: 85vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 25px 60px rgba(0, 0, 0, 0.3);
  }

  .debugger-loading, .debugger-error {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    color: var(--text-secondary);
    font-size: 0.9rem;
  }

  .debugger-error {
    color: var(--color-fail);
  }

  /* Top bar */
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1.25rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-secondary);
    flex-shrink: 0;
    position: relative;
  }

  /* Status accent stripe — 4px left edge tinted by run status. Mirrors
     the .releases status-accent pattern so the modal's identity at a
     glance matches the rest of the app. */
  .topbar::before {
    content: "";
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 4px;
    background: var(--color-skip);
  }
  .topbar.status-failed::before { background: var(--color-fail); }
  .topbar.status-passed::before { background: var(--color-pass); }
  .topbar.status-skipped::before { background: var(--color-skip); }
  .topbar.status-pending::before { background: var(--color-pending); }

  .topbar-title {
    margin: 0;
    font-size: 0.95rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .topbar-left {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    min-width: 0;
  }

  .topbar-left h2 {
    margin: 0;
    font-size: 0.95rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .topbar-right {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-shrink: 0;
  }

  .badge {
    color: white;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    flex-shrink: 0;
  }

  .badge.failed { background: var(--color-fail); }
  .badge.passed { background: var(--color-pass); }
  .badge.skipped { background: var(--color-skip); }
  .badge.pending { background: var(--color-pending); }

  .nav-group {
    display: flex;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }

  .nav-arrow {
    background: none;
    border: none;
    padding: 0.3rem 0.6rem;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 1.1rem;
    line-height: 1;
    transition: background 0.1s;
  }

  .nav-arrow:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text);
  }

  .nav-arrow:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .nav-label {
    padding: 0 0.4rem;
    font-size: 0.75rem;
    color: var(--text-muted);
    border-left: 1px solid var(--border);
    border-right: 1px solid var(--border);
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 1.2rem;
    cursor: pointer;
    padding: 0.2rem;
    line-height: 1;
    transition: color 0.1s;
  }

  .close-btn:hover {
    color: var(--text);
  }

  /* Info strip — wraps chips with subtle borders so each fact is its
     own scannable unit; copy actions live at the right edge. */
  .info-strip {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.5rem 1.25rem;
    border-bottom: 1px solid var(--border);
    font-size: 0.75rem;
    color: var(--text-muted);
    background: var(--bg);
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  .info-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-secondary);
    color: var(--text-secondary);
    font-size: 0.72rem;
    max-width: 60ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .info-chip svg { flex-shrink: 0; opacity: 0.7; }
  .info-chip-link {
    color: var(--link);
    text-decoration: none;
    border-color: color-mix(in srgb, var(--link) 35%, var(--border));
    background: color-mix(in srgb, var(--link) 8%, var(--bg-secondary));
  }
  .info-chip-link:hover { background: color-mix(in srgb, var(--link) 14%, var(--bg-secondary)); }

  .info-strip-actions {
    margin-left: auto;
    display: flex;
    gap: 0.4rem;
    flex-shrink: 0;
  }

  .copy-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.22rem 0.55rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg);
    color: var(--text-secondary);
    font-size: 0.72rem;
    font-family: inherit;
    cursor: pointer;
    transition: background 0.1s, color 0.1s, border-color 0.1s;
  }
  .copy-btn:hover {
    background: var(--bg-hover);
    color: var(--text);
    border-color: var(--link);
  }
  .copy-btn-inline {
    padding: 0.15rem 0.45rem;
    font-size: 0.68rem;
  }

  .mono { font-family: monospace; }

  /* Split layout */
  .split {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .split.dragging {
    cursor: col-resize;
    user-select: none;
  }

  .pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }

  .pane-left {
    flex: none;
  }

  .pane-right {
    flex: none;
  }

  .drag-handle {
    width: 6px;
    flex-shrink: 0;
    cursor: col-resize;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg);
    border-left: 1px solid var(--border);
    border-right: 1px solid var(--border);
    transition: background 0.1s;
  }

  .drag-handle:hover,
  .split.dragging .drag-handle {
    background: var(--bg-hover);
  }

  .drag-line {
    width: 2px;
    height: 24px;
    border-radius: 1px;
    background: var(--border);
    transition: background 0.1s;
  }

  .drag-handle:hover .drag-line,
  .split.dragging .drag-line {
    background: var(--link);
  }

  .pane-tabs {
    display: flex;
    padding: 0 0.75rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-secondary);
    flex-shrink: 0;
  }

  .pane-tab {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 0.5rem 0.75rem;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.8rem;
    transition: color 0.1s;
    white-space: nowrap;
  }

  .pane-tab:hover { color: var(--text); }

  .pane-tab.active {
    color: var(--text);
    border-bottom-color: var(--link);
    font-weight: 600;
  }

  .pane-content {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  /* LEFT: Screenshot viewer */
  .screenshot-viewer {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .screenshot-main {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-secondary);
    cursor: zoom-in;
    border: none;
    padding: 1rem;
    position: relative;
    min-height: 0;
  }

  .screenshot-main img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border-radius: 4px;
    border: 1px solid var(--border);
  }

  .zoom-hint {
    position: absolute;
    bottom: 0.75rem;
    right: 0.75rem;
    background: rgba(0, 0, 0, 0.6);
    color: white;
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    font-size: 0.7rem;
    opacity: 0;
    transition: opacity 0.15s;
  }

  .screenshot-main:hover .zoom-hint {
    opacity: 1;
  }

  .screenshot-strip {
    display: flex;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-top: 1px solid var(--border);
    overflow-x: auto;
    flex-shrink: 0;
  }

  .strip-thumb {
    width: 60px;
    height: 40px;
    border: 2px solid var(--border);
    border-radius: 4px;
    overflow: hidden;
    cursor: pointer;
    padding: 0;
    background: none;
    flex-shrink: 0;
    transition: border-color 0.1s;
  }

  .strip-thumb.active {
    border-color: var(--link);
  }

  .strip-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /* LEFT: Video viewer */
  .video-viewer {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 1rem;
    background: var(--bg-secondary);
  }

  .video-viewer video {
    max-width: 100%;
    max-height: 100%;
    border-radius: 6px;
    border: 1px solid var(--border);
  }

  /* LEFT: Empty state */
  .empty-visual {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-muted);
    text-align: center;
    padding: 2rem;
  }

  .empty-icon {
    font-size: 2.5rem;
    opacity: 0.3;
    margin-bottom: 0.75rem;
  }

  .empty-visual p {
    margin: 0;
    font-size: 0.85rem;
  }

  .empty-hint {
    font-size: 0.75rem;
    margin-top: 0.5rem;
    opacity: 0.7;
    line-height: 1.5;
  }

  /* RIGHT: Info panel */
  .info-panel {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .info-details {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .info-status {
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: uppercase;
  }

  .info-status.passed { color: var(--color-pass); }
  .info-status.failed { color: var(--color-fail); }
  .info-status.skipped { color: var(--color-skip); }
  .info-status.pending { color: var(--color-pending); }

  /* Lifted error block — sits above .pane-tabs in the right pane so
     the error message is always visible regardless of which tab the
     user is on. Tinted background + left accent stripe matches the
     project's status-fail accent pattern. */
  .error-block {
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--color-fail) 5%, var(--bg));
    padding: 0.65rem 0.85rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    flex-shrink: 0;
    border-left: 3px solid var(--color-fail);
    max-height: 38vh;
    overflow-y: auto;
  }
  .error-block-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .error-block-actions {
    display: flex;
    gap: 0.35rem;
  }
  .error-block-stack {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .error-label-snippet {
    margin-top: 0.4rem;
  }

  /* Rerun panel inside the Info tab — shows the rerun command
     verbatim so the user can read + edit before copying. */
  .info-rerun {
    border-top: 1px solid var(--border);
    padding-top: 0.85rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .info-rerun-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .rerun-cmd {
    margin: 0;
    padding: 0.65rem 0.75rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-family: monospace;
    font-size: 0.78rem;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-all;
    line-height: 1.5;
  }

  .error-label {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--text-muted);
    letter-spacing: 0.05em;
  }

  .error-msg {
    margin: 0;
    padding: 0.85rem;
    background: var(--error-bg);
    border: 1px solid var(--error-border);
    border-radius: 6px;
    color: var(--error-text);
    font-size: 0.82rem;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.5;
  }

  .stack-toggle {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: none;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 0.8rem;
    padding: 0.25rem 0;
    font-weight: 500;
  }

  .stack-toggle:hover { color: var(--text); }

  .toggle-icon {
    font-size: 0.6rem;
  }

  .stack-trace {
    margin: 0;
    padding: 0.75rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-secondary);
    font-size: 0.78rem;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.6;
  }

  .detail-row {
    display: flex;
    gap: 0.75rem;
    font-size: 0.8rem;
  }

  .detail-key {
    color: var(--text-muted);
    min-width: 4.5rem;
    font-weight: 500;
  }

  .detail-val {
    color: var(--text-secondary);
    word-break: break-all;
  }

  .detail-link {
    color: var(--link);
    text-decoration: none;
  }

  .detail-link:hover { text-decoration: underline; }

  /* RIGHT: Commands panel */
  .commands-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .commands-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.6rem 1rem;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .commands-title {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--text-muted);
    letter-spacing: 0.05em;
  }

  .commands-count {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .commands-meta {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .collapse-toggle {
    background: none;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.15rem 0.5rem;
    font-size: 0.72rem;
    color: var(--text-muted);
    cursor: pointer;
    transition: background 0.1s, color 0.1s, border-color 0.1s;
  }

  .collapse-toggle:hover {
    background: var(--bg-hover);
    color: var(--text);
    border-color: var(--text-muted);
  }

  .command-list {
    list-style: none;
    padding: 0;
    margin: 0;
    flex: 1;
    overflow-y: auto;
  }

  .cmd {
    display: flex;
    align-items: baseline;
    gap: 0;
    padding: 0.45rem 1rem;
    font-size: 0.82rem;
    border-bottom: 1px solid var(--border-light);
    transition: background 0.1s;
  }

  .cmd:hover {
    background: var(--bg-hover);
  }

  .cmd-failed {
    background: var(--error-bg);
  }

  .cmd-gherkin {
    background: color-mix(in srgb, var(--link, #3b82f6) 10%, transparent);
    border-left: 2px solid var(--link, #3b82f6);
    font-weight: 600;
  }
  .cmd-gherkin .cmd-name {
    color: var(--link, #3b82f6);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 0.7rem;
  }
  .cmd-gherkin .cmd-arg {
    color: var(--text-primary);
    font-weight: 600;
  }
  .cmd-setup {
    background: var(--bg-subtle, rgba(255,255,255,0.03));
    border-left: 2px solid var(--text-muted);
    font-weight: 600;
  }
  .cmd-setup .cmd-name {
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 0.7rem;
  }
  .cmd-chevron {
    display: inline-block;
    width: 0.8em;
    color: var(--text-muted);
    font-size: 0.7rem;
  }
  .cmd-group-count {
    margin-left: auto;
    padding: 0 0.4rem;
    font-size: 0.65rem;
    color: var(--text-muted);
    background: var(--bg-hover, rgba(128,128,128,0.12));
    border-radius: 8px;
    font-variant-numeric: tabular-nums;
  }
  .cmd-child {
    padding-left: 1.5rem;
  }

  /* Per-step console/network badge. Neutral count by default; red when the
     step carries console errors or failed requests, so a problem step stands
     out in the otherwise-flat list. */
  .cmd-diag-badge {
    margin-left: auto;
    flex-shrink: 0;
    min-width: 1.1rem;
    text-align: center;
    padding: 0 0.35rem;
    font-size: 0.62rem;
    font-weight: 600;
    line-height: 1.5;
    color: var(--text-muted);
    background: var(--bg-hover, rgba(128,128,128,0.12));
    border-radius: 8px;
    font-variant-numeric: tabular-nums;
  }
  .cmd-diag-badge.has-error {
    color: #fff;
    background: var(--color-fail);
  }

  .cmd-failed:hover {
    background: var(--error-bg);
  }

  .cmd-num {
    color: var(--text-muted);
    font-size: 0.7rem;
    width: 1.5rem;
    text-align: right;
    font-family: monospace;
    flex-shrink: 0;
    margin-right: 0.5rem;
  }

  .cmd-icon {
    font-size: 0.7rem;
    width: 1rem;
    text-align: center;
    color: var(--color-pass);
    flex-shrink: 0;
    margin-right: 0.5rem;
  }

  .cmd-failed .cmd-icon {
    color: var(--color-fail);
  }

  .cmd-body {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    min-width: 0;
    flex: 1;
  }

  .cmd-name {
    font-family: monospace;
    font-weight: 600;
    font-size: 0.8rem;
    color: var(--text);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .cmd-arg {
    font-family: monospace;
    font-size: 0.78rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .cmd-failed .cmd-name,
  .cmd-failed .cmd-arg {
    color: var(--error-text);
  }

  .cmd-clickable {
    cursor: pointer;
  }

  /*
   * Step has no captured snapshot. Visually dim and use the
   * not-allowed cursor so users can see at a glance which steps
   * actually pin a snapshot. Click still fires (it raises a toast),
   * so we don't disable pointer-events. Issue #26.
   */
  .cmd-no-snap {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .cmd-active {
    background: color-mix(in srgb, var(--link) 10%, transparent) !important;
    border-left: 2px solid var(--link);
    padding-left: calc(1rem - 2px);
  }

  .cmd-locked {
    background: color-mix(in srgb, var(--link) 15%, transparent) !important;
    border-left: 2px solid var(--link);
    padding-left: calc(1rem - 2px);
  }

  .cmd-locked::after {
    content: "pinned";
    font-size: 0.6rem;
    color: var(--link);
    text-transform: uppercase;
    letter-spacing: 0.03em;
    margin-left: auto;
    padding: 0.1rem 0.3rem;
    background: color-mix(in srgb, var(--link) 10%, transparent);
    border-radius: 3px;
  }

  /* RIGHT: Code panel */
  .code-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .code-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.6rem 1rem;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .code-title {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--text-muted);
    letter-spacing: 0.05em;
  }

  .code-lang {
    font-size: 0.7rem;
    color: var(--text-muted);
    padding: 0.1rem 0.4rem;
    background: var(--bg-hover);
    border-radius: 3px;
  }

  .code-block {
    margin: 0;
    padding: 1rem;
    flex: 1;
    overflow: auto;
    background: var(--bg-secondary);
    font-size: 0.82rem;
    line-height: 1.6;
  }

  .code-block code {
    color: var(--text);
  }

  /* RIGHT: Empty state */
  .empty-panel {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 2rem;
    text-align: center;
    color: var(--text-muted);
  }

  .empty-panel p {
    margin: 0;
    font-size: 0.85rem;
  }

  /* Info strip extras */
  .tag-pill {
    padding: 0.1rem 0.4rem;
    border-radius: 10px;
    font-size: 0.65rem;
    font-weight: 500;
    background: color-mix(in srgb, var(--link) 12%, transparent);
    color: var(--link);
  }

  .annotation-pill {
    padding: 0.1rem 0.4rem;
    border-radius: 10px;
    font-size: 0.65rem;
    font-weight: 600;
    color: white;
  }

  .annotation-pill.skip { background: var(--color-skip); }
  .annotation-pill.fixme { background: #e06c00; }
  .annotation-pill.slow { background: var(--link); }
  .annotation-pill.fail { background: var(--color-fail); }

  /* Error panel: code snippet */
  .code-snippet {
    margin: 0;
    padding: 0.75rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 0.78rem;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.6;
    color: var(--text-secondary);
  }

  /* Details panel */
  .details-panel {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    overflow-y: auto;
  }

  .details-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .details-heading {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    color: var(--text-muted);
    letter-spacing: 0.05em;
  }

  /* Retry timeline */
  .retry-timeline {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .retry-row {
    display: grid;
    grid-template-columns: 5rem 4.5rem 3.5rem 1fr;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.4rem 0.6rem;
    border-radius: 4px;
    font-size: 0.8rem;
    background: var(--bg-secondary);
  }

  .retry-row.retry-fail {
    background: var(--error-bg);
  }

  .retry-attempt {
    font-weight: 500;
    color: var(--text-secondary);
    font-size: 0.78rem;
  }

  .retry-status {
    font-family: monospace;
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
  }

  .retry-status.passed { color: var(--color-pass); }
  .retry-status.failed, .retry-status.timedOut { color: var(--color-fail); }
  .retry-status.skipped { color: var(--color-skip); }
  .retry-status.interrupted { color: var(--color-fail); }

  .retry-dur {
    font-family: monospace;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .retry-error {
    font-size: 0.75rem;
    color: var(--error-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  /* Annotations */
  .annotation-list {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .annotation-row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.82rem;
  }

  .annotation-type {
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    font-size: 0.7rem;
    font-weight: 600;
    color: white;
    flex-shrink: 0;
  }

  .annotation-type.skip { background: var(--color-skip); }
  .annotation-type.fixme { background: #e06c00; }
  .annotation-type.slow { background: var(--link); }
  .annotation-type.fail { background: var(--color-fail); }

  .annotation-desc {
    color: var(--text-secondary);
    font-size: 0.8rem;
  }

  /* Source location */
  .location-value {
    font-size: 0.8rem;
    padding: 0.35rem 0.6rem;
    background: var(--bg-secondary);
    border-radius: 4px;
    display: inline-block;
  }

  /* Console output */
  .console-output {
    margin: 0;
    padding: 0.75rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 0.75rem;
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.5;
    color: var(--text-secondary);
    max-height: 200px;
    overflow-y: auto;
  }

  .console-output.stderr {
    border-color: var(--error-border);
    color: var(--error-text);
  }

  /* Browser-console line levels: error/warn lines stand out from log/info. */
  .console-line { display: block; }
  .console-line.console-err { color: var(--color-fail); }
  .console-line.console-warn { color: var(--color-skip); }

  /* Network failures — one row per failed request. */
  .diag-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .diag-net {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.75rem;
    padding: 0.35rem 0.6rem;
    background: var(--bg-secondary);
    border: 1px solid var(--error-border);
    border-radius: 4px;
    color: var(--error-text);
    word-break: break-word;
  }

  /* History panel */
  .history-panel {
    padding: 0.75rem;
    overflow-y: auto;
    height: 100%;
  }

  .notes-tab {
    padding: 0.75rem;
    overflow-y: auto;
    height: 100%;
  }

  .history-loading, .history-empty {
    color: var(--text-muted);
    font-size: 0.85rem;
    text-align: center;
    padding: 2rem 0;
    margin: 0;
  }

  .history-timeline {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .history-back {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.4rem 0.65rem;
    margin-bottom: 0.5rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-secondary);
    color: var(--link);
    font-size: 0.78rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
    width: auto;
  }
  .history-back:hover { background: var(--bg-hover); border-color: var(--link); }

  .history-entry {
    display: flex;
    align-items: flex-start;
    gap: 0.65rem;
    padding: 0.55rem 0.5rem;
    border: none;
    border-radius: 6px;
    background: transparent;
    text-decoration: none;
    text-align: left;
    color: var(--text);
    width: 100%;
    cursor: pointer;
    transition: background 0.1s;
    position: relative;
    font: inherit;
  }

  .history-entry:hover {
    background: var(--bg-hover);
  }

  .history-entry.active {
    background: color-mix(in srgb, var(--link) 8%, transparent);
    border-left: 2px solid var(--link);
  }


  .history-entry + .history-entry {
    border-top: 1px solid var(--border-light);
  }

  .history-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
    margin-top: 0.3rem;
  }

  .history-dot.passed { background: var(--color-pass); }
  .history-dot.failed { background: var(--color-fail); }
  .history-dot.skipped { background: var(--color-skip); }
  .history-dot.pending { background: var(--color-pending); }

  .history-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .history-top {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
  }

  .history-status {
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    font-family: monospace;
  }

  .history-status.passed { color: var(--color-pass); }
  .history-status.failed { color: var(--color-fail); }
  .history-status.skipped { color: var(--color-skip); }

  .history-dur {
    font-family: monospace;
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .history-time {
    font-size: 0.72rem;
    color: var(--text-muted);
    margin-left: auto;
  }

  .history-bottom {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.75rem;
  }

  .history-run {
    color: var(--link);
    font-weight: 500;
  }

  .history-branch {
    color: var(--text-muted);
  }

  .history-error {
    color: var(--error-text);
    font-size: 0.72rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  /* Info grid (classname, error_type, hostname, skip_message) */
  .info-grid {
    display: grid;
    grid-template-columns: 5.5rem 1fr;
    gap: 0.35rem 0.75rem;
    font-size: 0.82rem;
  }

  .info-key {
    color: var(--text-muted);
    font-weight: 500;
    font-size: 0.78rem;
  }

  .info-val {
    color: var(--text-secondary);
    word-break: break-all;
    font-size: 0.8rem;
  }

  /* Properties table */
  .props-table {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .prop-row {
    display: flex;
    gap: 0.75rem;
    padding: 0.3rem 0.5rem;
    border-radius: 4px;
    font-size: 0.8rem;
    background: var(--bg-secondary);
  }

  .prop-key {
    font-family: monospace;
    font-size: 0.75rem;
    color: var(--text-muted);
    min-width: 8rem;
    flex-shrink: 0;
  }

  .prop-val {
    font-family: monospace;
    font-size: 0.75rem;
    color: var(--text);
    word-break: break-all;
  }
</style>
