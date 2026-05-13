<script lang="ts">
  import { authFetch } from "$lib/auth";
  import { UPLOADS_URL } from "$lib/api";

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
  // The Cypress reporter writes the failure frame as the LAST entry in
  // the bundle (cy:fail captures right before bailing). ErrorModal only
  // opens this viewer for failed tests, so the last index is the
  // canonical "where it broke" tick. The scrubber marks it red so the
  // user can see at a glance how far the test got before failing.
  let failureStep = $derived(stepCount > 0 ? stepCount - 1 : null);
  let clampedStep = $derived(Math.max(0, Math.min(selectedStep, stepCount - 1)));

  let currentStep = $derived.by(() => {
    if (!bundle) return null;
    return bundle.steps[clampedStep] ?? null;
  });

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
</style>
