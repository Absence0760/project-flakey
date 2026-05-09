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
  // fitScale: whatever scale exactly fits the snapshot's viewport into
  // the pane (auto, recomputed on resize). zoom: the user's zoom
  // multiplier on top of that — 1.0 = "fit", 2.0 = 2× the fit size, etc.
  // Issue #26: the original `Math.min(scaleX, scaleY, 1)` made the DOM
  // unreadable for any test bigger than the modal pane, with no way to
  // zoom in. We default to fit (zoom=1) and let users dial in.
  let fitScale = $state(1);
  let zoom = $state(1);
  let scale = $derived(fitScale * zoom);

  let currentStep = $derived.by(() => {
    if (!bundle) return null;
    const idx = Math.max(0, Math.min(selectedStep, bundle.steps.length - 1));
    return bundle.steps[idx] ?? null;
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
</script>

<svelte:window onresize={computeScale} />

<div class="snapshot-viewer">
  {#if loading}
    <div class="snapshot-status">Loading snapshot...</div>
  {:else if error}
    <div class="snapshot-status error">{error}</div>
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
        <iframe
          bind:this={iframeEl}
          sandbox="allow-same-origin"
          title="DOM Snapshot"
          width={bundle.viewportWidth}
          height={bundle.viewportHeight}
          style="transform: scale({scale}); transform-origin: top left;"
        ></iframe>
      </div>
    </div>
    <div class="step-nav">
      <button class="step-btn" onclick={() => selectedStep = Math.max(0, selectedStep - 1)} disabled={selectedStep <= 0} aria-label="Previous step">‹</button>
      <span class="step-info">
        <span class="step-count">{Math.min(selectedStep, bundle.steps.length - 1) + 1} / {bundle.steps.length}</span>
        <span class="step-name">{currentStep.commandName}{currentStep.commandMessage ? ` — ${currentStep.commandMessage}` : ""}</span>
      </span>
      <div class="zoom-controls" role="group" aria-label="Snapshot zoom">
        <button class="step-btn" onclick={zoomOut} disabled={zoom <= 0.5} aria-label="Zoom out">−</button>
        <button class="step-btn zoom-reset" onclick={zoomReset} aria-label="Reset zoom" title="Reset zoom">{Math.round(scale * 100)}%</button>
        <button class="step-btn" onclick={zoomIn} disabled={zoom >= 4} aria-label="Zoom in">+</button>
      </div>
      <button class="step-btn" onclick={() => selectedStep = Math.min(bundle!.steps.length - 1, selectedStep + 1)} disabled={selectedStep >= bundle.steps.length - 1} aria-label="Next step">›</button>
    </div>
  {:else}
    <div class="snapshot-status">No snapshot data available.</div>
  {/if}
</div>

<style>
  .snapshot-viewer {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .snapshot-status {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  .snapshot-status.error {
    color: var(--color-fail);
  }

  .snapshot-frame {
    flex: 1;
    overflow: auto;
    background: #fff;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    position: relative;
  }

  .snapshot-scaler {
    flex-shrink: 0;
    overflow: hidden;
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

  iframe {
    border: none;
    display: block;
  }

  .step-nav {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    border-top: 1px solid var(--border, rgba(255,255,255,0.08));
    background: var(--bg-subtle, rgba(255,255,255,0.02));
    font-size: 0.8rem;
  }
  .step-btn {
    background: none;
    border: 1px solid var(--border, rgba(255,255,255,0.15));
    color: var(--text-primary);
    border-radius: 4px;
    width: 28px;
    height: 28px;
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
  }
  .step-btn:disabled { opacity: 0.4; cursor: default; }
  .step-btn:not(:disabled):hover { background: var(--bg-hover, rgba(128,128,128,0.1)); }
  .step-info {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    overflow: hidden;
  }
  .step-count { color: var(--text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .step-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
