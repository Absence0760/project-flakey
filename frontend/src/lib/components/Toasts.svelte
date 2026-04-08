<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { subscribe, dismissToast, type Toast } from "$lib/toast";

  let toasts = $state<Toast[]>([]);
  let unsub: (() => void) | null = null;

  onMount(() => {
    unsub = subscribe((t) => toasts = t);
  });

  onDestroy(() => unsub?.());
</script>

{#if toasts.length > 0}
  <div class="toast-container">
    {#each toasts as t (t.id)}
      <div class="toast {t.type}" role="alert">
        <span class="toast-msg">{t.message}</span>
        <button class="toast-close" onclick={() => dismissToast(t.id)}>&times;</button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .toast-container {
    position: fixed;
    bottom: 1.5rem;
    right: 1.5rem;
    z-index: 9999;
    display: flex;
    flex-direction: column-reverse;
    gap: 0.5rem;
    max-width: 380px;
  }

  .toast {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 0.85rem;
    border-radius: 8px;
    font-size: 0.82rem;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    animation: toast-in 0.2s ease-out;
  }

  .toast.success {
    background: var(--color-pass, #22c55e);
    color: #fff;
  }
  .toast.error {
    background: var(--color-fail, #ef4444);
    color: #fff;
  }
  .toast.info {
    background: var(--bg-secondary, #374151);
    color: var(--text, #f3f4f6);
    border: 1px solid var(--border, #4b5563);
  }

  .toast-msg { flex: 1; }

  .toast-close {
    background: none; border: none; color: inherit; font-size: 1.1rem;
    cursor: pointer; padding: 0 0.2rem; opacity: 0.7; line-height: 1;
  }
  .toast-close:hover { opacity: 1; }

  @keyframes toast-in {
    from { transform: translateY(10px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }
</style>
