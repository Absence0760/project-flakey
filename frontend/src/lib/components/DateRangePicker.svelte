<script lang="ts">
  type Props = {
    from: string | undefined;
    to: string | undefined;
    onchange: (from: string | undefined, to: string | undefined) => void;
  };

  let { from, to, onchange }: Props = $props();

  let open = $state(false);
  let selecting = $state<"from" | "to">("from");
  let viewYear = $state(new Date().getFullYear());
  let viewMonth = $state(new Date().getMonth());

  const presets = [
    { label: "Today", days: 0 },
    { label: "Last 7 days", days: 7 },
    { label: "Last 30 days", days: 30 },
    { label: "Last 90 days", days: 90 },
    { label: "Last year", days: 365 },
  ] as const;

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

  function fmt(date: string | undefined): string {
    if (!date) return "—";
    const d = new Date(date + "T00:00:00");
    return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }

  function toISO(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function applyPreset(days: number) {
    const today = new Date();
    const toDate = toISO(today);
    if (days === 0) {
      onchange(toDate, toDate);
    } else {
      const fromDate = new Date(today);
      fromDate.setDate(fromDate.getDate() - days);
      onchange(toISO(fromDate), toDate);
    }
    open = false;
  }

  function clearFilter() {
    onchange(undefined, undefined);
    open = false;
  }

  function prevMonth() {
    if (viewMonth === 0) { viewMonth = 11; viewYear--; }
    else viewMonth--;
  }

  function nextMonth() {
    if (viewMonth === 11) { viewMonth = 0; viewYear++; }
    else viewMonth++;
  }

  function calendarDays(year: number, month: number): (number | null)[] {
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells: (number | null)[] = [];
    for (let i = 0; i < firstDay; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    return cells;
  }

  function selectDay(day: number) {
    const iso = toISO(new Date(viewYear, viewMonth, day));
    if (selecting === "from") {
      if (to && iso > to) {
        onchange(iso, iso);
      } else {
        onchange(iso, to);
      }
      selecting = "to";
    } else {
      if (from && iso < from) {
        onchange(iso, from);
      } else {
        onchange(from, iso);
      }
      selecting = "from";
    }
  }

  function isInRange(day: number): boolean {
    if (!from || !to) return false;
    const iso = toISO(new Date(viewYear, viewMonth, day));
    return iso >= from && iso <= to;
  }

  function isFrom(day: number): boolean {
    if (!from) return false;
    return toISO(new Date(viewYear, viewMonth, day)) === from;
  }

  function isTo(day: number): boolean {
    if (!to) return false;
    return toISO(new Date(viewYear, viewMonth, day)) === to;
  }

  function isToday(day: number): boolean {
    const today = new Date();
    return day === today.getDate() && viewMonth === today.getMonth() && viewYear === today.getFullYear();
  }

  function isFuture(day: number): boolean {
    const date = new Date(viewYear, viewMonth, day);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return date > today;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") open = false;
  }

  function handleBackdropClick(e: MouseEvent) {
    open = false;
  }

  $effect(() => {
    if (from) {
      const d = new Date(from + "T00:00:00");
      viewYear = d.getFullYear();
      viewMonth = d.getMonth();
    }
  });

  let displayLabel = $derived.by(() => {
    if (!from && !to) return "All Time";
    if (from === to) return fmt(from);
    return `${fmt(from)} – ${fmt(to)}`;
  });

  let cells = $derived(calendarDays(viewYear, viewMonth));
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="picker-wrapper">
  <button class="trigger" onclick={() => { open = !open; selecting = "from"; }}>
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
      <rect x="2" y="3" width="12" height="11" rx="1.5" />
      <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" />
    </svg>
    <span class="trigger-label">{displayLabel}</span>
    <svg class="chevron" class:open width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="M2.5 4L5 6.5L7.5 4" />
    </svg>
  </button>

  {#if open}
    <div class="backdrop" onclick={handleBackdropClick}></div>
    <div class="dropdown">
      <div class="presets">
        {#each presets as preset}
          <button class="preset-btn" onclick={() => applyPreset(preset.days)}>
            {preset.label}
          </button>
        {/each}
        {#if from || to}
          <button class="preset-btn clear" onclick={clearFilter}>Clear</button>
        {/if}
      </div>

      <div class="calendar">
        <div class="cal-header">
          <button class="cal-nav" onclick={prevMonth}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M7.5 2.5L4 6l3.5 3.5"/></svg>
          </button>
          <span class="cal-title">{MONTHS[viewMonth]} {viewYear}</span>
          <button class="cal-nav" onclick={nextMonth}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4.5 2.5L8 6l-3.5 3.5"/></svg>
          </button>
        </div>

        <div class="cal-grid">
          {#each DAYS as dayName}
            <span class="cal-day-name">{dayName}</span>
          {/each}
          {#each cells as day}
            {#if day === null}
              <span class="cal-empty"></span>
            {:else}
              <button
                class="cal-day"
                class:in-range={isInRange(day)}
                class:range-start={isFrom(day)}
                class:range-end={isTo(day)}
                class:today={isToday(day)}
                class:future={isFuture(day)}
                disabled={isFuture(day)}
                onclick={() => selectDay(day)}
              >
                {day}
              </button>
            {/if}
          {/each}
        </div>

        <div class="cal-footer">
          <div class="range-display">
            <button
              class="range-field"
              class:active={selecting === "from"}
              onclick={() => selecting = "from"}
            >
              <span class="range-label">From</span>
              <span class="range-value">{fmt(from)}</span>
            </button>
            <span class="range-arrow">→</span>
            <button
              class="range-field"
              class:active={selecting === "to"}
              onclick={() => selecting = "to"}
            >
              <span class="range-label">To</span>
              <span class="range-value">{fmt(to)}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .picker-wrapper {
    position: relative;
  }

  .trigger {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    color: var(--text);
    font-size: 0.825rem;
    cursor: pointer;
    transition: border-color 0.15s, box-shadow 0.15s;
  }

  .trigger:hover {
    border-color: var(--link);
  }

  .trigger-label {
    white-space: nowrap;
  }

  .chevron {
    transition: transform 0.15s;
    color: var(--text-muted);
  }

  .chevron.open {
    transform: rotate(180deg);
  }

  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 49;
  }

  .dropdown {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 50;
    display: flex;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.08);
    overflow: hidden;
  }

  .presets {
    display: flex;
    flex-direction: column;
    padding: 0.5rem;
    border-right: 1px solid var(--border);
    min-width: 130px;
  }

  .preset-btn {
    padding: 0.45rem 0.75rem;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 0.8rem;
    text-align: left;
    cursor: pointer;
    transition: background 0.1s, color 0.1s;
    white-space: nowrap;
  }

  .preset-btn:hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  .preset-btn.clear {
    margin-top: 0.25rem;
    color: var(--text-muted);
    border-top: 1px solid var(--border-light);
    padding-top: 0.55rem;
    border-radius: 0 0 5px 5px;
  }

  .calendar {
    padding: 0.75rem;
    min-width: 260px;
  }

  .cal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }

  .cal-title {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text);
  }

  .cal-nav {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    transition: background 0.1s;
  }

  .cal-nav:hover {
    background: var(--bg-hover);
    color: var(--text);
  }

  .cal-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 1px;
  }

  .cal-day-name {
    font-size: 0.7rem;
    color: var(--text-muted);
    text-align: center;
    padding: 0.3rem 0;
    font-weight: 500;
  }

  .cal-empty {
    aspect-ratio: 1;
  }

  .cal-day {
    aspect-ratio: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    color: var(--text);
    font-size: 0.78rem;
    cursor: pointer;
    border-radius: 6px;
    transition: background 0.1s, color 0.1s;
    position: relative;
  }

  .cal-day:hover:not(:disabled) {
    background: var(--bg-hover);
  }

  .cal-day.today {
    font-weight: 700;
    color: var(--link);
  }

  .cal-day.in-range {
    background: color-mix(in srgb, var(--link) 12%, transparent);
    border-radius: 0;
  }

  .cal-day.range-start {
    background: var(--link);
    color: #fff;
    border-radius: 6px 0 0 6px;
    font-weight: 600;
  }

  .cal-day.range-start.range-end {
    border-radius: 6px;
  }

  .cal-day.range-end {
    background: var(--link);
    color: #fff;
    border-radius: 0 6px 6px 0;
    font-weight: 600;
  }

  .cal-day.future {
    color: var(--text-muted);
    opacity: 0.4;
    cursor: not-allowed;
  }

  .cal-footer {
    margin-top: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--border-light);
  }

  .range-display {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .range-field {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    padding: 0.35rem 0.5rem;
    border: 1.5px solid var(--border);
    border-radius: 6px;
    background: var(--bg);
    cursor: pointer;
    transition: border-color 0.15s;
  }

  .range-field.active {
    border-color: var(--link);
  }

  .range-label {
    font-size: 0.65rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }

  .range-value {
    font-size: 0.78rem;
    color: var(--text);
  }

  .range-arrow {
    color: var(--text-muted);
    font-size: 0.8rem;
  }
</style>
