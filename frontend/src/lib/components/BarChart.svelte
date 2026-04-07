<script lang="ts">
  type Bar = {
    label: string;
    value: number;
    subtitle?: string;
  };

  type Props = {
    bars: Bar[];
    color?: string;
    maxBars?: number;
    formatValue?: (v: number) => string;
  };

  let {
    bars,
    color = "var(--color-fail)",
    maxBars = 10,
    formatValue = (v: number) => String(v),
  }: Props = $props();

  let visibleBars = $derived(bars.slice(0, maxBars));
  let maxVal = $derived(Math.max(...visibleBars.map((b) => b.value), 1));
</script>

<div class="bar-chart">
  {#if visibleBars.length === 0}
    <p class="bar-empty">No data</p>
  {:else}
    {#each visibleBars as bar, i}
      <div class="bar-row">
        <div class="bar-info">
          <span class="bar-rank">{i + 1}</span>
          <div class="bar-labels">
            <span class="bar-label">{bar.label}</span>
            {#if bar.subtitle}
              <span class="bar-subtitle">{bar.subtitle}</span>
            {/if}
          </div>
          <span class="bar-value">{formatValue(bar.value)}</span>
        </div>
        <div class="bar-track">
          <div
            class="bar-fill"
            style:width="{(bar.value / maxVal) * 100}%"
            style:background={color}
          ></div>
        </div>
      </div>
    {/each}
  {/if}
</div>

<style>
  .bar-chart {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .bar-empty {
    color: var(--text-muted);
    font-size: 0.85rem;
    text-align: center;
    padding: 1.5rem 0;
    margin: 0;
  }

  .bar-row {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .bar-info {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }

  .bar-rank {
    font-size: 0.7rem;
    color: var(--text-muted);
    font-family: monospace;
    min-width: 1.25rem;
    text-align: right;
    flex-shrink: 0;
  }

  .bar-labels {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .bar-label {
    font-size: 0.78rem;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bar-subtitle {
    font-size: 0.7rem;
    color: var(--text-muted);
    font-family: monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bar-value {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--text);
    flex-shrink: 0;
    font-family: monospace;
  }

  .bar-track {
    height: 4px;
    background: var(--border-light);
    border-radius: 2px;
    margin-left: 1.75rem;
  }

  .bar-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 0.3s ease;
    min-width: 2px;
  }
</style>
