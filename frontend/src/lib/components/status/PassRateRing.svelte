<script lang="ts">
  // Pass-rate donut: `rate` is 0–100. Color steps match the rest of
  // the app — good ≥90 (pass), warn ≥50 (link), bad <50 (fail). Size
  // and stroke are props so denser contexts can shrink it; the center
  // label is optional. The dashboard suite cards use their own
  // unrotated variant, so this component intentionally covers only the
  // rotated run-detail style.
  let {
    rate,
    size = 64,
    stroke = 3,
    showLabel = true,
  }: { rate: number; size?: number; stroke?: number; showLabel?: boolean } = $props();

  const ARC = "M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831";
</script>

<div class="progress-ring" style="width:{size}px;height:{size}px" title="{rate}% pass rate">
  <svg viewBox="0 0 36 36" class="ring-svg">
    <path class="ring-bg" style="stroke-width:{stroke}" d={ARC} />
    <path
      class="ring-fill"
      class:good={rate >= 90}
      class:warn={rate >= 50 && rate < 90}
      class:bad={rate < 50}
      style="stroke-width:{stroke}"
      stroke-dasharray="{rate}, 100"
      d={ARC}
    />
  </svg>
  {#if showLabel}
    <div class="ring-label"><span class="ring-pct">{rate}%</span></div>
  {/if}
</div>

<style>
  .progress-ring {
    position: relative;
    flex-shrink: 0;
  }
  .ring-svg {
    width: 100%;
    height: 100%;
    transform: rotate(-90deg);
  }
  .ring-bg {
    fill: none;
    stroke: var(--border);
  }
  .ring-fill {
    fill: none;
    stroke-linecap: round;
    transition: stroke-dasharray 0.6s ease;
  }
  .ring-fill.good { stroke: var(--color-pass); }
  .ring-fill.warn { stroke: var(--link); }
  .ring-fill.bad { stroke: var(--color-fail); }

  .ring-label {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }
  .ring-pct {
    font-size: 0.85rem;
    font-weight: 700;
    color: var(--text);
  }
</style>
