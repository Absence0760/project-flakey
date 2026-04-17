<script lang="ts">
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
  let scale = $state(1);

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
    scale = Math.min(scaleX, scaleY, 1);
  }

  async function loadSnapshot(path: string) {
    loading = true;
    error = null;
    bundle = null;

    try {
      const url = `${UPLOADS_URL}/${path}`;
      const res = await fetch(url);
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

      const blob = new Blob(chunks);
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
      <div class="snapshot-scaler" style="transform: scale({scale}); width: {bundle.viewportWidth}px; height: {bundle.viewportHeight}px;">
        <iframe
          bind:this={iframeEl}
          sandbox="allow-same-origin"
          title="DOM Snapshot"
          width={bundle.viewportWidth}
          height={bundle.viewportHeight}
        ></iframe>
      </div>
    </div>
    <div class="step-nav">
      <button class="step-btn" onclick={() => selectedStep = Math.max(0, selectedStep - 1)} disabled={selectedStep <= 0} aria-label="Previous step">‹</button>
      <span class="step-info">
        <span class="step-count">{Math.min(selectedStep, bundle.steps.length - 1) + 1} / {bundle.steps.length}</span>
        <span class="step-name">{currentStep.commandName}{currentStep.commandMessage ? ` — ${currentStep.commandMessage}` : ""}</span>
      </span>
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
    overflow: hidden;
    background: #fff;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    position: relative;
  }

  .snapshot-scaler {
    transform-origin: top center;
    flex-shrink: 0;
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
