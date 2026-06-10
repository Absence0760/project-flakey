<script lang="ts">
  import { authFetch } from "$lib/stores/auth";
  import { UPLOADS_URL } from "$lib/api";
  import {
    failureStepIndex,
    stepDiagnostics,
    isNetworkFailure,
    stepDurationsMs,
    slowStepIndices,
    type ConsoleEntryLite,
    type NetworkEntryLite,
  } from "$lib/utils/snapshot-match";
  import { formatDuration } from "$lib/utils/format";

  type Props = {
    snapshotPath: string;
    selectedStep: number;
  };

  let { snapshotPath, selectedStep = $bindable() }: Props = $props();

  interface SnapshotStep {
    index: number;
    commandName: string;
    commandMessage: string;
    timestamp: number;
    html: string;
    scrollX: number;
    scrollY: number;
    console?: ConsoleEntryLite[];
    network?: NetworkEntryLite[];
  }

  interface SnapshotBundle {
    version: 1;
    testTitle: string;
    specFile: string;
    steps: SnapshotStep[];
    viewportWidth: number;
    viewportHeight: number;
  }

  let bundle = $state<SnapshotBundle | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let iframeEl = $state<HTMLIFrameElement | null>(null);
  let frameEl = $state<HTMLDivElement | null>(null);
  let viewerEl = $state<HTMLDivElement | null>(null);
  // fitScale: whatever scale exactly fits the snapshot's viewport into
  // the pane (auto, recomputed on resize). zoom: the user's zoom
  // multiplier on top of that — 1.0 = "fit", 2.0 = 2× the fit size, etc.
  // Issue #26: the original `Math.min(scaleX, scaleY, 1)` made the DOM
  // unreadable for any test bigger than the modal pane, with no way to
  // zoom in. We default to fit (zoom=1) and let users dial in.
  let fitScale = $state(1);
  let zoom = $state(1);
  let scale = $derived(fitScale * zoom);

  let stepCount = $derived(bundle?.steps.length ?? 0);
  // The failure frame is the synthetic "failure" step the snapshots support
  // file appends in afterEach — present ONLY when the test failed. Keying off
  // that (not "the last step") means the red FAILURE tick shows for failed
  // tests only; this viewer is also opened for PASSED tests, whose final step
  // is an ordinary command, not a failure.
  let failureStep = $derived(bundle ? failureStepIndex(bundle.steps) : null);
  let clampedStep = $derived(Math.max(0, Math.min(selectedStep, stepCount - 1)));

  let currentStep = $derived.by(() => {
    if (!bundle) return null;
    return bundle.steps[clampedStep] ?? null;
  });

  // Per-step console/network strip. Open state + chosen tab persist across
  // steps (set once, keep as you scrub). Counts drive the tab headers.
  let diagOpen = $state(false);
  let diagTab = $state<"console" | "network">("console");
  let currentDiag = $derived(
    currentStep ? stepDiagnostics(currentStep) : { consoleCount: 0, networkCount: 0, errorCount: 0 },
  );
  let consoleEntries = $derived(currentStep?.console ?? []);
  let networkEntries = $derived(currentStep?.network ?? []);
  let consoleErrorCount = $derived(consoleEntries.filter((c) => c.level === "error").length);
  let networkFailCount = $derived(networkEntries.filter((n) => isNetworkFailure(n.status)).length);
  // The tab actually shown: honor the user's choice, but fall back to whichever
  // source has data so an empty tab is never displayed (a step may have only
  // console or only network).
  let activeTab = $derived(
    diagTab === "network"
      ? (networkEntries.length > 0 ? "network" : "console")
      : (consoleEntries.length > 0 ? "console" : "network"),
  );

  // HTTP status → severity class for the network status chip.
  function netStatusClass(status: number | undefined): string {
    if (isNetworkFailure(status)) return "fail";
    if (status !== undefined && status >= 300) return "redirect";
    return "ok";
  }

  // Per-step durations (ms) derived from each step's cumulative timestamp, so
  // the nav surfaces how long the active step took and flags the slow ones.
  let stepDurations = $derived(bundle ? stepDurationsMs(bundle.steps) : []);
  let slowSteps = $derived(slowStepIndices(stepDurations));
  let currentDurationMs = $derived(stepDurations[clampedStep] ?? 0);

  $effect(() => {
    if (snapshotPath) loadSnapshot(snapshotPath);
  });

  $effect(() => {
    if (currentStep && iframeEl) {
      iframeEl.srcdoc = currentStep.html;
      iframeEl.onload = () => {
        try {
          iframeEl?.contentWindow?.scrollTo(currentStep!.scrollX, currentStep!.scrollY);
        } catch {}
      };
    }
  });

  $effect(() => {
    if (bundle && frameEl) {
      computeScale();
    }
  });

  function computeScale() {
    if (!bundle || !frameEl) return;
    const containerWidth = frameEl.clientWidth;
    const containerHeight = frameEl.clientHeight;
    if (containerWidth === 0 || containerHeight === 0) return;

    const scaleX = containerWidth / bundle.viewportWidth;
    const scaleY = containerHeight / bundle.viewportHeight;
    fitScale = Math.min(scaleX, scaleY, 1);
  }

  function zoomIn() { zoom = Math.min(zoom * 1.25, 4); }
  function zoomOut() { zoom = Math.max(zoom / 1.25, 0.5); }
  function zoomReset() { zoom = 1; }

  function goPrev() { if (clampedStep > 0) selectedStep = clampedStep - 1; }
  function goNext() { if (clampedStep < stepCount - 1) selectedStep = clampedStep + 1; }
  function goFirst() { selectedStep = 0; }
  function goLast() { if (stepCount > 0) selectedStep = stepCount - 1; }
  function goTo(i: number) { selectedStep = Math.max(0, Math.min(i, stepCount - 1)); }

  // Keyboard scrubbing — Arrow keys step, Home/End jump to ends. Only
  // fire when focus is inside the viewer (not the iframe content) so we
  // don't hijack typing if someone ever opens devtools on the iframe.
  function onKeydown(e: KeyboardEvent) {
    if (!bundle || stepCount === 0) return;
    // Don't steal keys from form inputs the modal's right pane may have
    // focused (notes textarea, etc.).
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

    if (e.key === "ArrowLeft") { e.preventDefault(); goPrev(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); goNext(); }
    else if (e.key === "Home") { e.preventDefault(); goFirst(); }
    else if (e.key === "End") { e.preventDefault(); goLast(); }
  }

  async function loadSnapshot(path: string) {
    loading = true;
    error = null;
    bundle = null;

    try {
      const url = `${UPLOADS_URL}/${path}`;
      // authFetch attaches the Bearer token; required by the new
      // auth+ownership check on /uploads/*.
      const res = await authFetch(url);
      if (!res.ok) throw new Error(`Failed to fetch snapshot: ${res.status}`);

      const ds = new DecompressionStream("gzip");
      const decompressed = res.body!.pipeThrough(ds);
      const reader = decompressed.getReader();
      const chunks: Uint8Array[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      const blob = new Blob(chunks as BlobPart[]);
      const text = await blob.text();
      bundle = JSON.parse(text);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load snapshot";
    } finally {
      loading = false;
    }
  }

  function tickTitle(s: SnapshotStep, i: number): string {
    const base = `Step ${i + 1}: ${s.commandName}${s.commandMessage ? ` — ${s.commandMessage}` : ""}`;
    return i === failureStep ? `${base} (failure)` : base;
  }
</script>

<svelte:window onresize={computeScale} onkeydown={onKeydown} />

<div class="snapshot-viewer" bind:this={viewerEl}>
  {#if loading}
    <div class="snapshot-status">
      <div class="spinner" aria-hidden="true"></div>
      <span>Loading snapshot…</span>
    </div>
  {:else if error}
    <div class="snapshot-status error">
      <span class="status-icon" aria-hidden="true">!</span>
      <span>{error}</span>
    </div>
  {:else if bundle && currentStep}
    <div class="snapshot-frame" bind:this={frameEl}>
      <!--
        Layout box is sized to the *visually rendered* dimensions
        (viewport × scale) so the parent's overflow scroll exposes the
        extra pixels at zoom > 1. The iframe stays at intrinsic
        viewport size and `transform: scale(...)` draws it inside that
        box. transform-origin: top left so we anchor to the corner the
        scrollbars start from. (Issue #26.)
      -->
      <div
        class="snapshot-scaler"
        style="width: {bundle.viewportWidth * scale}px; height: {bundle.viewportHeight * scale}px;"
      >
        <!--
          SECURITY: this iframe renders captured DOM snapshots from
          customer test runs (via srcdoc, written in the $effect above).
          The snapshot HTML is UNTRUSTED — a malicious customer can
          control what their reporter captured. The current sandbox
          flags must never relax:

            * NO allow-scripts. Any script in the captured DOM is
              defanged at the iframe boundary. The only feature
              currently needing scripts (scrollTo on load) is invoked
              from the PARENT frame (line ~70), not by code inside the
              iframe — so allow-scripts is unnecessary and adding it
              would immediately turn this into stored-XSS.
            * allow-same-origin is present ONLY so the parent's
              `iframeEl.contentWindow.scrollTo(...)` call works
              (cross-origin srcdoc would throw on contentWindow
              access). Without allow-scripts the same-origin grant
              is harmless: scripts can't run to exfiltrate cookies
              or read localStorage from inside this frame.

          If anyone ever needs to add allow-scripts to enable
          interactivity in the captured DOM, the ONLY safe path is to
          DROP allow-same-origin in the same change (so the iframe
          becomes a unique-origin sandbox). Never have both flags set
          together — that combination is a stored-XSS surface.
        -->
        <iframe
          bind:this={iframeEl}
          sandbox="allow-same-origin"
          title="DOM Snapshot"
          width={bundle.viewportWidth}
          height={bundle.viewportHeight}
          style="transform: scale({scale}); transform-origin: top left;"
        ></iframe>
        <!--
          The iframe is sandboxed (no allow-scripts), but inputs and
          links inside the captured DOM are still focusable / clickable
          and would steal focus from the scrubber. The overlay swallows
          pointer events on the iframe content while letting the
          scrubber + zoom buttons stay interactive.
        -->
        <div class="snapshot-overlay" aria-hidden="true"></div>
      </div>
    </div>

    {#if stepCount > 1}
      <!--
        Scrubber: one tick per snapshot step. Clicking a tick jumps to
        that step. The "fill" bar grows to the current step's position
        so the user sees how far through the test they've scrubbed.
        The failure tick is colored red so the user can see at a
        glance how far the test got before failing.
      -->
      <div class="step-scrubber" role="group" aria-label="Snapshot timeline">
        <div class="scrubber-track">
          <div
            class="scrubber-fill"
            style="width: {((clampedStep) / Math.max(1, stepCount - 1)) * 100}%"
          ></div>
          {#each bundle.steps as s, i}
            <button
              class="scrubber-tick"
              class:current={i === clampedStep}
              class:fail={i === failureStep}
              style="left: {(i / Math.max(1, stepCount - 1)) * 100}%"
              onclick={() => goTo(i)}
              aria-label={tickTitle(s, i)}
              title={tickTitle(s, i)}
            ></button>
          {/each}
        </div>
      </div>
    {/if}

    <div class="step-nav">
      <button class="step-btn" onclick={goPrev} disabled={clampedStep <= 0} aria-label="Previous step" title="Previous step (←)">‹</button>
      <span class="step-info">
        <span class="step-count" class:fail={clampedStep === failureStep}>{clampedStep + 1} / {stepCount}</span>
        {#if clampedStep === failureStep}
          <span class="failure-badge" title="This is the frame where the test failed.">FAILURE</span>
        {/if}
        <span
          class="step-dur"
          class:slow={slowSteps.has(clampedStep)}
          title={slowSteps.has(clampedStep) ? "One of the slowest steps in this test" : "Time taken by this step"}
        >{formatDuration(currentDurationMs)}</span>{#if slowSteps.has(clampedStep)}<span class="step-dur-flag" title="One of the slowest steps in this test" aria-hidden="true">slow</span>{/if}
        <span class="step-name" title={currentStep.commandName + (currentStep.commandMessage ? ` — ${currentStep.commandMessage}` : "")}>
          <span class="step-cmd">{currentStep.commandName}</span>{#if currentStep.commandMessage}<span class="step-msg"> — {currentStep.commandMessage}</span>{/if}
        </span>
      </span>
      <div class="zoom-controls" role="group" aria-label="Snapshot zoom">
        <button class="step-btn" onclick={zoomOut} disabled={zoom <= 0.5} aria-label="Zoom out" title="Zoom out">−</button>
        <button class="step-btn zoom-reset" onclick={zoomReset} aria-label="Reset zoom" title="Reset zoom">{Math.round(scale * 100)}%</button>
        <button class="step-btn" onclick={zoomIn} disabled={zoom >= 4} aria-label="Zoom in" title="Zoom in">+</button>
      </div>
      <button class="step-btn" onclick={goNext} disabled={clampedStep >= stepCount - 1} aria-label="Next step" title="Next step (→)">›</button>
    </div>

    {#if currentDiag.consoleCount + currentDiag.networkCount > 0}
      <!--
        Per-step diagnostics strip: the console + network captured for the
        ACTIVE step (Phase 1 enrichment populates these on Playwright bundles).
        Collapsed by default so the frame stays prominent; the header shows
        counts and turns red when the step carries errors / failed requests.
      -->
      <div class="step-diag" class:open={diagOpen}>
        <div class="diag-tabs" role="tablist" aria-label="Step console and network">
          <button
            class="diag-toggle"
            onclick={() => (diagOpen = !diagOpen)}
            aria-expanded={diagOpen}
            aria-label={diagOpen ? "Hide step console & network" : "Show step console & network"}
            title={diagOpen ? "Hide step console & network" : "Show step console & network"}
          >
            <span class="diag-chevron" class:open={diagOpen} aria-hidden="true">▸</span>
          </button>
          {#if consoleEntries.length > 0}
            <button
              class="diag-tab"
              class:active={diagOpen && activeTab === "console"}
              role="tab"
              aria-selected={activeTab === "console"}
              onclick={() => { diagTab = "console"; diagOpen = true; }}
            >
              Console
              <span class="diag-count">{currentDiag.consoleCount}</span>
              {#if consoleErrorCount > 0}
                <span class="diag-badge err" title={`${consoleErrorCount} error${consoleErrorCount === 1 ? "" : "s"}`}>{consoleErrorCount}</span>
              {/if}
            </button>
          {/if}
          {#if networkEntries.length > 0}
            <button
              class="diag-tab"
              class:active={diagOpen && activeTab === "network"}
              role="tab"
              aria-selected={activeTab === "network"}
              onclick={() => { diagTab = "network"; diagOpen = true; }}
            >
              Network
              <span class="diag-count">{currentDiag.networkCount}</span>
              {#if networkFailCount > 0}
                <span class="diag-badge err" title={`${networkFailCount} failed`}>{networkFailCount}</span>
              {/if}
            </button>
          {/if}
        </div>

        {#if diagOpen}
          <div class="diag-body" role="tabpanel">
            {#if activeTab === "console"}
              <ul class="diag-console">
                {#each consoleEntries as line}
                  <li class="diag-row console-{line.level}">
                    <span class="diag-level level-{line.level}">{line.level}</span>
                    <span class="diag-text">{line.text}</span>
                  </li>
                {/each}
              </ul>
            {:else}
              <ul class="diag-network">
                {#each networkEntries as req}
                  {@const cls = netStatusClass(req.status)}
                  <li class="diag-row">
                    <span class="net-method">{req.method}</span>
                    <span class="net-url" title={req.url}>{req.url}</span>
                    <span class="net-status net-status-{cls}">{req.status ?? "—"}</span>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  {:else}
    <div class="snapshot-status">
      <span class="status-icon" aria-hidden="true">∅</span>
      <span>No snapshot steps recorded for this test.</span>
    </div>
  {/if}
</div>

<style>
  .snapshot-viewer {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg);
  }

  .snapshot-status {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    height: 100%;
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .snapshot-status.error {
    color: var(--color-fail);
  }

  .status-icon {
    width: 1.75rem;
    height: 1.75rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    border: 1px solid currentColor;
    font-size: 0.95rem;
    font-weight: 700;
    opacity: 0.7;
  }

  .spinner {
    width: 1.5rem;
    height: 1.5rem;
    border: 2px solid var(--border);
    border-top-color: var(--link);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .snapshot-frame {
    flex: 1;
    overflow: auto;
    /* Neutral surround that works in both themes. The captured iframe
       content is white internally (it's the snapshot of the rendered
       page); the box-shadow on .snapshot-scaler provides the edge cue
       that distinguishes iframe-end from frame-empty-space — no checker
       pattern needed (the earlier checker read as eye-searing high-
       contrast noise in dark mode). */
    background: var(--bg-secondary);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    position: relative;
  }

  .snapshot-scaler {
    flex-shrink: 0;
    overflow: hidden;
    position: relative;
    background: #fff;
    box-shadow: 0 0 0 1px var(--border);
  }

  .snapshot-overlay {
    position: absolute;
    inset: 0;
    /* The overlay must NOT block the parent's scroll wheel. pointer-events
       none lets wheel/scroll fall through to .snapshot-frame; we still
       need to intercept clicks on the iframe — the iframe absorbs its
       own clicks anyway because it's sandboxed without allow-scripts,
       so an explicit overlay click-shield is no longer required. */
    pointer-events: none;
  }

  iframe {
    border: none;
    display: block;
    /* Iframe is sandboxed (no allow-scripts), so JS in the captured DOM
       can't run; but form inputs / links would still take focus.
       pointer-events: none turns the iframe into a static image. */
    pointer-events: none;
  }

  /* Scrubber */
  .step-scrubber {
    padding: 0.5rem 0.75rem 0;
    background: var(--bg-secondary);
    border-top: 1px solid var(--border);
  }
  .scrubber-track {
    position: relative;
    height: 14px;
    background: var(--border);
    border-radius: 7px;
    cursor: pointer;
  }
  .scrubber-fill {
    position: absolute;
    top: 0;
    left: 0;
    height: 100%;
    background: var(--link);
    border-radius: 7px;
    opacity: 0.25;
    transition: width 0.12s ease-out;
    pointer-events: none;
  }
  .scrubber-tick {
    position: absolute;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--bg);
    border: 1.5px solid var(--text-muted);
    padding: 0;
    cursor: pointer;
    transition: transform 0.1s, background 0.1s, border-color 0.1s;
  }
  .scrubber-tick:hover {
    transform: translate(-50%, -50%) scale(1.3);
    border-color: var(--link);
  }
  .scrubber-tick.current {
    background: var(--link);
    border-color: var(--link);
    transform: translate(-50%, -50%) scale(1.4);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--link) 25%, transparent);
  }
  .scrubber-tick.fail {
    border-color: var(--color-fail);
  }
  .scrubber-tick.fail.current,
  .scrubber-tick.current.fail {
    background: var(--color-fail);
    border-color: var(--color-fail);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-fail) 30%, transparent);
  }

  .zoom-controls {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .zoom-controls .zoom-reset {
    width: auto;
    padding: 0 0.5rem;
    font-variant-numeric: tabular-nums;
    font-size: 0.75rem;
  }

  .step-nav {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    border-top: 1px solid var(--border);
    background: var(--bg-secondary);
    font-size: 0.8rem;
  }
  .step-btn {
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 4px;
    width: 28px;
    height: 28px;
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .step-btn:disabled { opacity: 0.4; cursor: default; }
  .step-btn:not(:disabled):hover { background: var(--bg-hover); border-color: var(--text-muted); }
  .step-info {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    overflow: hidden;
  }
  .step-count {
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    font-weight: 600;
  }
  .step-count.fail { color: var(--color-fail); }
  .step-dur {
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    font-size: 0.75rem;
  }
  .step-dur.slow { color: var(--color-skip); font-weight: 600; }
  .step-dur-flag {
    font-size: 0.58rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #fff;
    background: var(--color-skip);
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
    white-space: nowrap;
  }
  .failure-badge {
    background: var(--color-fail);
    color: #fff;
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    padding: 0.1rem 0.35rem;
    border-radius: 3px;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .step-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
    min-width: 0;
  }
  .step-cmd {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-weight: 600;
    color: var(--link);
  }
  .step-msg {
    color: var(--text-secondary);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  /* Per-step diagnostics — devtools-style Console / Network tabs */
  .step-diag {
    border-top: 1px solid var(--border);
    background: var(--bg-secondary);
    font-size: 0.75rem;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .step-diag.open {
    /* When open, cap the panel so the snapshot frame stays the hero; the body
       scrolls. ~38% of the viewer, bounded. */
    flex: 0 0 auto;
  }

  .diag-tabs {
    display: flex;
    align-items: stretch;
    gap: 0;
    padding: 0 0.5rem;
    min-height: 2rem;
  }
  .diag-toggle {
    display: inline-flex;
    align-items: center;
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0 0.4rem;
  }
  .diag-toggle:hover { color: var(--text); }
  .diag-chevron {
    font-size: 0.7rem;
    transition: transform 0.12s ease;
    display: inline-block;
  }
  .diag-chevron.open { transform: rotate(90deg); }

  .diag-tab {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0 0.6rem;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 0.72rem;
    font-weight: 600;
    height: 2rem;
    white-space: nowrap;
  }
  .diag-tab:hover { color: var(--text); }
  .diag-tab.active {
    color: var(--link);
    border-bottom-color: var(--link);
  }
  .diag-count {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    font-size: 0.66rem;
    color: var(--text-muted);
    background: var(--bg-hover, rgba(128,128,128,0.16));
    border-radius: 8px;
    padding: 0 0.35rem;
    min-width: 1.1rem;
    text-align: center;
  }
  .diag-tab.active .diag-count { color: var(--text); }
  .diag-badge {
    font-variant-numeric: tabular-nums;
    font-weight: 700;
    font-size: 0.6rem;
    border-radius: 8px;
    padding: 0 0.3rem;
    min-width: 1rem;
    text-align: center;
    color: #fff;
  }
  .diag-badge.err { background: var(--color-fail); }

  .diag-body {
    max-height: 180px;
    overflow-y: auto;
    padding: 0.25rem 0 0.4rem;
    border-top: 1px solid var(--border);
  }
  .diag-console,
  .diag-network {
    list-style: none;
    margin: 0;
    padding: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.72rem;
  }
  /* One row per entry — striped, full-width hover, monospace. */
  .diag-row {
    display: flex;
    gap: 0.6rem;
    align-items: baseline;
    padding: 0.18rem 0.75rem;
    color: var(--text-secondary);
    word-break: break-word;
    border-left: 2px solid transparent;
  }
  .diag-row:nth-child(even) { background: color-mix(in srgb, var(--bg) 40%, transparent); }
  .diag-row:hover { background: var(--bg-hover); }

  /* Console: a fixed-width level chip + the message. Error/warn rows tint. */
  .diag-level {
    flex-shrink: 0;
    width: 3.1rem;
    text-transform: uppercase;
    font-size: 0.58rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-align: center;
    border-radius: 3px;
    padding: 0.05rem 0;
    color: var(--text-muted);
    background: var(--bg-hover, rgba(128,128,128,0.16));
  }
  .level-error { color: #fff; background: var(--color-fail); }
  .level-warn { color: #1a1a1a; background: var(--color-skip); }
  .diag-text { white-space: pre-wrap; }
  .console-error { color: var(--color-fail); border-left-color: var(--color-fail); }
  .console-warn { color: var(--color-skip); }

  /* Network: method · url (truncates) · status chip (severity-colored). */
  .net-method {
    flex-shrink: 0;
    width: 3.2rem;
    font-weight: 700;
    color: var(--text);
    font-size: 0.66rem;
  }
  .net-url {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-secondary);
  }
  .net-status {
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
    font-weight: 700;
    padding: 0 0.35rem;
    border-radius: 3px;
    font-size: 0.66rem;
  }
  .net-status-ok { color: var(--color-pass); }
  .net-status-redirect { color: var(--text-muted); }
  .net-status-fail { color: #fff; background: var(--color-fail); }
</style>
