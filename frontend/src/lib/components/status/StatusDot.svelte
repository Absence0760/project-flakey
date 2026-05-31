<script lang="ts">
  // Canonical colored status circle used across run / test / error
  // lists. Colors are token-driven (see app.css --color-*); `live`
  // pulses blue. Size is in px — lists use 10px, denser inline
  // contexts 6–8px — so callers pass `size` instead of redefining
  // the dot per page.
  type Status = "pass" | "fail" | "aborted" | "live" | "skip" | "running";
  let { status, size = 10 }: { status: Status; size?: number } = $props();
</script>

<span class="status-dot {status}" style="--dot-size: {size}px"></span>

<style>
  .status-dot {
    display: inline-block;
    width: var(--dot-size);
    height: var(--dot-size);
    border-radius: 50%;
    flex-shrink: 0;
  }
  .pass { background: var(--color-pass); }
  .fail { background: var(--color-fail); }
  .skip { background: var(--color-skip); }
  .aborted { background: var(--text-muted); }
  .running { background: var(--link); }
  .live {
    background: #3b82f6;
    animation: live-pulse 2s ease-in-out infinite;
  }
  @keyframes live-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }
</style>
