<script lang="ts">
  interface Props {
    images: string[];
    index: number;
    open: boolean;
    onclose: () => void;
  }

  let { images, index = $bindable(0), open, onclose }: Props = $props();

  function prev() {
    index = (index - 1 + images.length) % images.length;
  }

  function next() {
    index = (index + 1) % images.length;
  }

  function onKeydown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === "Escape") onclose();
    if (e.key === "ArrowLeft") prev();
    if (e.key === "ArrowRight") next();
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <div class="backdrop" onclick={onclose} role="dialog" aria-modal="true">
    <div class="lightbox" onclick={(e) => e.stopPropagation()}>
      <button class="close-btn" onclick={onclose}>&#10005;</button>

      {#if images.length > 1}
        <button class="nav-btn left" onclick={prev}>&#8249;</button>
        <button class="nav-btn right" onclick={next}>&#8250;</button>
      {/if}

      <img src={images[index]} alt="Screenshot {index + 1}" />

      {#if images.length > 1}
        <div class="counter">{index + 1} / {images.length}</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.85);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .lightbox {
    position: relative;
    max-width: 90vw;
    max-height: 90vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  img {
    max-width: 90vw;
    max-height: 85vh;
    object-fit: contain;
    border-radius: 4px;
  }

  .close-btn {
    position: absolute;
    top: -2.5rem;
    right: 0;
    background: none;
    border: none;
    color: white;
    font-size: 1.5rem;
    cursor: pointer;
    padding: 0.25rem 0.5rem;
    opacity: 0.8;
  }

  .close-btn:hover {
    opacity: 1;
  }

  .nav-btn {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    background: rgba(255, 255, 255, 0.1);
    border: none;
    color: white;
    font-size: 2.5rem;
    cursor: pointer;
    padding: 0.5rem 0.75rem;
    border-radius: 4px;
    line-height: 1;
    opacity: 0.7;
  }

  .nav-btn:hover {
    opacity: 1;
    background: rgba(255, 255, 255, 0.2);
  }

  .nav-btn.left {
    left: -3.5rem;
  }

  .nav-btn.right {
    right: -3.5rem;
  }

  .counter {
    position: absolute;
    bottom: -2rem;
    left: 50%;
    transform: translateX(-50%);
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.85rem;
  }
</style>
