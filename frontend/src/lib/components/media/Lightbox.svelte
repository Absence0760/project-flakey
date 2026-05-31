<script lang="ts">
  interface Props {
    images: string[];
    /** Original storage paths, parallel to `images`. Used for the
     * filename caption + Download link. Optional for back-compat —
     * if omitted the header falls back to "Screenshot N". */
    paths?: string[];
    index: number;
    open: boolean;
    onclose: () => void;
  }

  let { images, paths = [], index = $bindable(0), open, onclose }: Props = $props();

  // Backdrop ref for programmatic focus when the dialog opens —
  // gives keyboard users a focus target instead of leaving them on
  // whatever triggered the open. Required by WCAG for modal dialogs.
  let backdropEl = $state<HTMLDivElement | null>(null);

  $effect(() => {
    if (open && backdropEl) backdropEl.focus();
  });

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

  // Friendly filename: last path segment of the storage path. Falls
  // back to the URL pathname's last segment when paths[] isn't passed.
  let currentPath = $derived(paths[index] ?? "");
  let filename = $derived.by(() => {
    if (currentPath) return currentPath.split("/").pop() || currentPath;
    const url = images[index] ?? "";
    try {
      const u = new URL(url, "http://x");
      const last = u.pathname.split("/").pop() || "";
      return decodeURIComponent(last);
    } catch {
      return "";
    }
  });
  let fullPathTitle = $derived(currentPath || filename);
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <!--
    Same pattern as ErrorModal — backdrop closes on click but only
    when the click hit the backdrop itself (`target === currentTarget`),
    not when it bubbled up from the inner lightbox. tabindex + focus()
    on open puts kbd focus inside the dialog. Escape / arrows / +/- /
    0 are all handled by the <svelte:window onkeydown> above.
  -->
  <div
    bind:this={backdropEl}
    class="backdrop"
    onclick={(e) => { if (e.target === e.currentTarget) onclose(); }}
    onkeydown={(e) => { if (e.key === "Escape") onclose(); }}
    role="dialog"
    aria-modal="true"
    aria-label={filename ? `Image viewer — ${filename}` : "Image viewer"}
    tabindex="-1"
  >
    <div class="lightbox">
      <!-- Top header: counter + filename + open/download + close -->
      <header class="topbar">
        <div class="topbar-left">
          {#if images.length > 1}
            <span class="counter">{index + 1}<span class="counter-of"> of </span>{images.length}</span>
            <span class="topbar-sep" aria-hidden="true"></span>
          {/if}
          {#if filename}
            <span class="filename" title={fullPathTitle}>{filename}</span>
          {/if}
        </div>
        <div class="topbar-right">
          <a class="topbar-btn" href={images[index]} target="_blank" rel="noopener noreferrer" title="Open in new tab">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M9 2h5v5"/><path d="M14 2L7 9"/><path d="M12 9v4a1 1 0 01-1 1H3a1 1 0 01-1-1V5a1 1 0 011-1h4"/></svg>
            <span class="topbar-btn-label">Open</span>
          </a>
          <a class="topbar-btn" href={images[index]} download={filename || "screenshot.png"} title="Download image">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M8 2v9"/><path d="M4 7l4 4 4-4"/><path d="M2 14h12"/></svg>
            <span class="topbar-btn-label">Download</span>
          </a>
          <span class="topbar-sep" aria-hidden="true"></span>
          <button class="topbar-btn close-btn" onclick={onclose} title="Close (Esc)" aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13"/></svg>
          </button>
        </div>
      </header>

      {#if images.length > 1}
        <button class="nav-btn left" onclick={prev} title="Previous (←)" aria-label="Previous image">
          <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg>
        </button>
        <button class="nav-btn right" onclick={next} title="Next (→)" aria-label="Next image">
          <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg>
        </button>
      {/if}

      <!--
        role="application" + tabindex tells assistive tech this is an
        interactive widget; pointer handlers (pan/zoom via mouse/touch)
        are the mouse contract. Keyboard contract lives on the window
        handler above and on this element: +/- zoom, 0 fit, arrows
        navigate prev/next image, Escape close.

        Svelte's lint warns because role="application" + tabindex on a
        <div> looks like a non-interactive element being made
        focusable, but `application` is a documented interactive ARIA
        role designed for custom widgets that capture keyboard events.
      -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        class="viewport"
        class:grabbing={dragging}
        class:zoomed={scale > 1}
        role="application"
        tabindex="0"
        aria-label="Image viewer. Plus and minus to zoom, 0 to fit, arrows to navigate, Escape to close."
        onwheel={onWheel}
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        ondblclick={onDblClick}
        onkeydown={onKeydown}
      >
        <img
          src={images[index]}
          alt={filename || `Screenshot ${index + 1}`}
          style:transform="translate({panX}px, {panY}px) scale({scale})"
          draggable="false"
        />
      </div>

      <!-- Bottom: keyboard hint (left) + zoom toolbar (right) -->
      <footer class="bottombar">
        <div class="kbd-hint" aria-hidden="true">
          <kbd>Esc</kbd> close
          {#if images.length > 1}
            <span class="kbd-sep">·</span>
            <kbd>←</kbd><kbd>→</kbd> navigate
          {/if}
          <span class="kbd-sep">·</span>
          <kbd>+</kbd><kbd>−</kbd> zoom
          <span class="kbd-sep">·</span>
          <kbd>0</kbd> fit
        </div>
        <div class="toolbar">
          <button class="tool-btn" onclick={zoomOut} title="Zoom out (−)" aria-label="Zoom out">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="7" cy="7" r="5"/><path d="M11 11l3.5 3.5M5 7h4"/></svg>
          </button>
          <span class="zoom-label">{zoomPct}%</span>
          <button class="tool-btn" onclick={zoomIn} title="Zoom in (+)" aria-label="Zoom in">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="7" cy="7" r="5"/><path d="M11 11l3.5 3.5M5 7h4M7 5v4"/></svg>
          </button>
          <span class="toolbar-sep" aria-hidden="true"></span>
          <button class="tool-btn" onclick={fitToScreen} title="Fit to screen (0)" aria-label="Fit to screen">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="1.5"/><path d="M6 2v4H2M10 14v-4h4M2 10h4v4M14 6h-4V2"/></svg>
          </button>
        </div>
      </footer>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.92);
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
    align-items: stretch;
    justify-content: stretch;
  }

  /* Top bar — filename + counter + open/download/close */
  .topbar {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.5rem 0.75rem 0.5rem 1.25rem;
    background: linear-gradient(to bottom, rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0));
    color: rgba(255, 255, 255, 0.85);
    z-index: 10;
  }

  .topbar-left, .topbar-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0; /* allow filename ellipsis */
  }

  .topbar-right {
    flex-shrink: 0;
  }

  .counter {
    font-variant-numeric: tabular-nums;
    font-size: 0.8rem;
    color: rgba(255, 255, 255, 0.7);
    white-space: nowrap;
  }

  .counter-of {
    color: rgba(255, 255, 255, 0.4);
    margin: 0 0.1rem;
  }

  .filename {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.78rem;
    color: rgba(255, 255, 255, 0.85);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: help;
    /* Cap so the filename never pushes the right-side actions off-screen on long paths */
    max-width: min(60vw, 800px);
  }

  .topbar-sep {
    width: 1px;
    align-self: stretch;
    margin: 0.2rem 0.15rem;
    background: rgba(255, 255, 255, 0.2);
  }

  .topbar-btn {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.78);
    cursor: pointer;
    padding: 0.4rem 0.6rem;
    border-radius: 6px;
    font-size: 0.78rem;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }

  .topbar-btn:hover {
    background: rgba(255, 255, 255, 0.14);
    border-color: rgba(255, 255, 255, 0.18);
    color: white;
  }

  .topbar-btn.close-btn {
    padding: 0.4rem 0.5rem;
  }

  /* Hide labels on narrow viewports — icons remain */
  @media (max-width: 700px) {
    .topbar-btn-label { display: none; }
  }

  .viewport {
    flex: 1;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    cursor: default;
    min-height: 0;
  }

  .viewport.zoomed {
    cursor: grab;
  }

  .viewport.grabbing {
    cursor: grabbing;
  }

  img {
    /* Account for top header (~3rem) and bottom bar (~3rem). */
    max-width: 96vw;
    max-height: calc(100vh - 6rem);
    object-fit: contain;
    transform-origin: center center;
    transition: transform 0.1s ease-out;
    user-select: none;
    pointer-events: none;
    /* Subtle shadow so the image edge separates from the dark backdrop */
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);
  }

  .nav-btn {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    z-index: 10;
    background: rgba(0, 0, 0, 0.5);
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.75);
    cursor: pointer;
    padding: 0.85rem;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }

  .nav-btn:hover {
    background: rgba(0, 0, 0, 0.7);
    border-color: rgba(255, 255, 255, 0.2);
    color: white;
  }

  .nav-btn.left { left: 1rem; }
  .nav-btn.right { right: 1rem; }

  /* Bottom bar */
  .bottombar {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.5rem 1rem 0.85rem;
    background: linear-gradient(to top, rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0));
  }

  .kbd-hint {
    color: rgba(255, 255, 255, 0.5);
    font-size: 0.72rem;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-wrap: wrap;
  }

  .kbd-hint kbd {
    display: inline-block;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 3px;
    padding: 0.05rem 0.35rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.68rem;
    color: rgba(255, 255, 255, 0.75);
    line-height: 1.2;
    margin: 0 0.05rem;
  }

  .kbd-sep {
    color: rgba(255, 255, 255, 0.25);
    margin: 0 0.15rem;
  }

  /* Hide kbd hint on narrow viewports — keeps the toolbar usable */
  @media (max-width: 700px) {
    .kbd-hint { display: none; }
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.6rem;
    background: rgba(0, 0, 0, 0.55);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    margin-left: auto;
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
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    min-width: 2.8rem;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
</style>
