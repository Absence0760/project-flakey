<script lang="ts">
  interface Props {
    images: string[];
    index: number;
    open: boolean;
    onclose: () => void;
  }

  let { images, index = $bindable(0), open, onclose }: Props = $props();

  let scale = $state(1);
  let panX = $state(0);
  let panY = $state(0);
  let dragging = $state(false);
  let dragStartX = 0;
  let dragStartY = 0;
  let panStartX = 0;
  let panStartY = 0;

  function resetView() {
    scale = 1;
    panX = 0;
    panY = 0;
  }

  function prev() {
    index = (index - 1 + images.length) % images.length;
    resetView();
  }

  function next() {
    index = (index + 1) % images.length;
    resetView();
  }

  function zoomIn() {
    scale = Math.min(scale * 1.3, 10);
  }

  function zoomOut() {
    scale = Math.max(scale / 1.3, 0.25);
    if (scale <= 1) { panX = 0; panY = 0; }
  }

  function fitToScreen() {
    resetView();
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 1 / 1.15 : 1.15;
    const newScale = Math.max(0.25, Math.min(10, scale * delta));

    // Zoom towards cursor position
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top - rect.height / 2;

    panX = cx - (cx - panX) * (newScale / scale);
    panY = cy - (cy - panY) * (newScale / scale);
    scale = newScale;

    if (scale <= 1) { panX = 0; panY = 0; }
  }

  function onPointerDown(e: PointerEvent) {
    if (scale <= 1) return;
    e.preventDefault();
    dragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    panStartX = panX;
    panStartY = panY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging) return;
    panX = panStartX + (e.clientX - dragStartX);
    panY = panStartY + (e.clientY - dragStartY);
  }

  function onPointerUp() {
    dragging = false;
  }

  function onDblClick() {
    if (scale > 1) {
      resetView();
    } else {
      scale = 3;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === "Escape") onclose();
    if (e.key === "ArrowLeft") prev();
    if (e.key === "ArrowRight") next();
    if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomIn(); }
    if (e.key === "-") { e.preventDefault(); zoomOut(); }
    if (e.key === "0") { e.preventDefault(); fitToScreen(); }
  }

  let zoomPct = $derived(Math.round(scale * 100));
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <div class="backdrop" onclick={onclose} role="dialog" aria-modal="true">
    <div class="lightbox" onclick={(e) => e.stopPropagation()}>
      <button class="close-btn" onclick={onclose} title="Close (Esc)">
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l10 10M13 3L3 13"/></svg>
      </button>

      {#if images.length > 1}
        <button class="nav-btn left" onclick={prev} title="Previous">
          <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 3L5 8l5 5"/></svg>
        </button>
        <button class="nav-btn right" onclick={next} title="Next">
          <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3l5 5-5 5"/></svg>
        </button>
      {/if}

      <!-- Image viewport -->
      <div
        class="viewport"
        class:grabbing={dragging}
        class:zoomable={scale <= 1}
        onwheel={onWheel}
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        ondblclick={onDblClick}
      >
        <img
          src={images[index]}
          alt="Screenshot {index + 1}"
          style:transform="translate({panX}px, {panY}px) scale({scale})"
          draggable="false"
        />
      </div>

      <!-- Bottom toolbar -->
      <div class="toolbar">
        {#if images.length > 1}
          <span class="counter">{index + 1} / {images.length}</span>
          <span class="toolbar-sep"></span>
        {/if}
        <button class="tool-btn" onclick={zoomOut} title="Zoom out (-)">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="5"/><path d="M11 11l3.5 3.5M5 7h4"/></svg>
        </button>
        <span class="zoom-label">{zoomPct}%</span>
        <button class="tool-btn" onclick={zoomIn} title="Zoom in (+)">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="5"/><path d="M11 11l3.5 3.5M5 7h4M7 5v4"/></svg>
        </button>
        <span class="toolbar-sep"></span>
        <button class="tool-btn" onclick={fitToScreen} title="Fit to screen (0)">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="12" height="12" rx="1.5"/><path d="M6 2v4H2M10 14v-4h4M2 10h4v4M14 6h-4V2"/></svg>
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.9);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .lightbox {
    position: relative;
    width: 100vw;
    height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }

  .viewport {
    flex: 1;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    cursor: grab;
  }

  .viewport.grabbing {
    cursor: grabbing;
  }

  .viewport.zoomable {
    cursor: zoom-in;
  }

  img {
    max-width: 90vw;
    max-height: calc(100vh - 4rem);
    object-fit: contain;
    transform-origin: center center;
    transition: transform 0.1s ease-out;
    user-select: none;
    pointer-events: none;
  }

  .close-btn {
    position: absolute;
    top: 1rem;
    right: 1.25rem;
    z-index: 10;
    background: rgba(255, 255, 255, 0.08);
    border: none;
    color: rgba(255, 255, 255, 0.7);
    cursor: pointer;
    padding: 0.5rem;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s, color 0.15s;
  }

  .close-btn:hover {
    background: rgba(255, 255, 255, 0.15);
    color: white;
  }

  .nav-btn {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    z-index: 10;
    background: rgba(255, 255, 255, 0.08);
    border: none;
    color: rgba(255, 255, 255, 0.7);
    cursor: pointer;
    padding: 0.75rem;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s, color 0.15s;
  }

  .nav-btn:hover {
    background: rgba(255, 255, 255, 0.15);
    color: white;
  }

  .nav-btn.left {
    left: 1rem;
  }

  .nav-btn.right {
    right: 1rem;
  }

  /* Bottom toolbar */
  .toolbar {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.5rem 0.75rem;
    background: rgba(0, 0, 0, 0.6);
    border-radius: 8px;
    margin-bottom: 1rem;
  }

  .counter {
    color: rgba(255, 255, 255, 0.6);
    font-size: 0.78rem;
    padding: 0 0.25rem;
  }

  .toolbar-sep {
    width: 1px;
    height: 14px;
    background: rgba(255, 255, 255, 0.15);
  }

  .tool-btn {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.6);
    cursor: pointer;
    padding: 0.3rem;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.1s, color 0.1s;
  }

  .tool-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    color: white;
  }

  .zoom-label {
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.72rem;
    font-family: monospace;
    min-width: 2.5rem;
    text-align: center;
  }
</style>
