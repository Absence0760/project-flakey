<script lang="ts">
  type DataPoint = {
    label: string;
    value: number;
  };

  type Series = {
    data: DataPoint[];
    color: string;
    label: string;
  };

  type Props = {
    series: Series[];
    height?: number;
    yLabel?: string;
    yMax?: number;
    formatY?: (v: number) => string;
    formatTooltip?: (point: DataPoint, seriesLabel: string) => string;
  };

  let {
    series,
    height = 200,
    yLabel = "",
    yMax: yMaxProp,
    formatY = (v: number) => String(v),
    formatTooltip,
  }: Props = $props();

  const PADDING = { top: 20, right: 16, bottom: 32, left: 48 };

  let containerWidth = $state(600);
  let hoverIndex = $state<number | null>(null);
  let tooltipX = $state(0);
  let tooltipY = $state(0);

  let allValues = $derived(series.flatMap((s) => s.data.map((d) => d.value)));
  let yMax = $derived(yMaxProp ?? Math.max(...allValues, 1));
  let labels = $derived(series[0]?.data.map((d) => d.label) ?? []);

  let chartW = $derived(containerWidth - PADDING.left - PADDING.right);
  let chartH = $derived(height - PADDING.top - PADDING.bottom);

  function x(i: number): number {
    if (labels.length <= 1) return PADDING.left + chartW / 2;
    return PADDING.left + (i / (labels.length - 1)) * chartW;
  }

  function y(val: number): number {
    return PADDING.top + chartH - (val / yMax) * chartH;
  }

  function pathD(data: DataPoint[]): string {
    return data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join("");
  }

  function areaD(data: DataPoint[]): string {
    const line = pathD(data);
    const baseline = PADDING.top + chartH;
    return `${line}L${x(data.length - 1).toFixed(1)},${baseline}L${x(0).toFixed(1)},${baseline}Z`;
  }

  let yTicks = $derived.by(() => {
    const count = 4;
    const step = yMax / count;
    return Array.from({ length: count + 1 }, (_, i) => Math.round(i * step));
  });

  let xTickLabels = $derived.by(() => {
    if (labels.length <= 8) return labels.map((l, i) => ({ label: formatDate(l), index: i }));
    const step = Math.ceil(labels.length / 6);
    return labels
      .map((l, i) => ({ label: formatDate(l), index: i }))
      .filter((_, i) => i % step === 0 || i === labels.length - 1);
  });

  function formatDate(iso: string): string {
    const d = new Date(iso.length === 10 ? iso + "T00:00:00" : iso);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  function formatDateLong(iso: string): string {
    const d = new Date(iso.length === 10 ? iso + "T00:00:00" : iso);
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }

  function handleMouseMove(e: MouseEvent) {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const mx = e.clientX - rect.left;
    if (labels.length === 0) return;
    let closest = 0;
    let closestDist = Infinity;
    for (let i = 0; i < labels.length; i++) {
      const dist = Math.abs(x(i) - mx);
      if (dist < closestDist) {
        closestDist = dist;
        closest = i;
      }
    }
    hoverIndex = closest;
    tooltipX = x(closest);
    tooltipY = e.clientY - rect.top;
  }
</script>

<div class="chart-container" bind:clientWidth={containerWidth}>
  {#if labels.length === 0}
    <div class="chart-empty" style:height="{height}px">No data</div>
  {:else}
    <svg
      width={containerWidth}
      {height}
      onmousemove={handleMouseMove}
      onmouseleave={() => hoverIndex = null}
    >
      <!-- Grid lines -->
      {#each yTicks as tick}
        <line
          x1={PADDING.left}
          y1={y(tick)}
          x2={PADDING.left + chartW}
          y2={y(tick)}
          class="grid-line"
        />
        <text x={PADDING.left - 8} y={y(tick) + 4} class="y-label">{formatY(tick)}</text>
      {/each}

      <!-- X axis labels -->
      {#each xTickLabels as tick}
        <text x={x(tick.index)} y={height - 6} class="x-label">{tick.label}</text>
      {/each}

      <!-- Series -->
      {#each series as s}
        <path d={areaD(s.data)} class="area" style:fill={s.color} />
        <path d={pathD(s.data)} class="line" style:stroke={s.color} />
      {/each}

      <!-- Hover crosshair -->
      {#if hoverIndex !== null}
        <line
          x1={x(hoverIndex)}
          y1={PADDING.top}
          x2={x(hoverIndex)}
          y2={PADDING.top + chartH}
          class="crosshair"
        />
        {#each series as s}
          <circle
            cx={x(hoverIndex)}
            cy={y(s.data[hoverIndex].value)}
            r="4"
            class="dot"
            style:fill={s.color}
          />
        {/each}
      {/if}
    </svg>

    <!-- Tooltip -->
    {#if hoverIndex !== null}
      <div
        class="tooltip"
        style:left="{tooltipX}px"
        style:top="{Math.max(PADDING.top, tooltipY - 60)}px"
      >
        <div class="tooltip-date">{formatDateLong(labels[hoverIndex])}</div>
        {#each series as s}
          <div class="tooltip-row">
            <span class="tooltip-dot" style:background={s.color}></span>
            <span class="tooltip-label">{s.label}</span>
            <span class="tooltip-val">
              {formatTooltip ? formatTooltip(s.data[hoverIndex], s.label) : formatY(s.data[hoverIndex].value)}
            </span>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .chart-container {
    position: relative;
    width: 100%;
    overflow: hidden;
  }

  .chart-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    font-size: 0.85rem;
  }

  svg {
    display: block;
  }

  .grid-line {
    stroke: var(--border-light);
    stroke-width: 1;
  }

  .y-label {
    font-size: 10px;
    fill: var(--text-muted);
    text-anchor: end;
    dominant-baseline: middle;
  }

  .x-label {
    font-size: 10px;
    fill: var(--text-muted);
    text-anchor: middle;
  }

  .area {
    opacity: 0.1;
  }

  .line {
    fill: none;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .crosshair {
    stroke: var(--text-muted);
    stroke-width: 1;
    stroke-dasharray: 3 3;
    opacity: 0.5;
  }

  .dot {
    stroke: var(--bg);
    stroke-width: 2;
  }

  .tooltip {
    position: absolute;
    transform: translateX(-50%);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.5rem 0.65rem;
    font-size: 0.75rem;
    pointer-events: none;
    z-index: 10;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
    white-space: nowrap;
  }

  .tooltip-date {
    color: var(--text-muted);
    margin-bottom: 0.3rem;
    font-size: 0.7rem;
  }

  .tooltip-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .tooltip-row + .tooltip-row {
    margin-top: 0.15rem;
  }

  .tooltip-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .tooltip-label {
    color: var(--text-secondary);
  }

  .tooltip-val {
    font-weight: 600;
    color: var(--text);
    margin-left: auto;
    padding-left: 0.75rem;
  }
</style>
