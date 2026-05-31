// Shared date / duration formatting. These were previously copy-pasted
// (and had drifted) across ~12 pages and components; this is the single
// canonical implementation. Falsy timestamps render as an em dash so a
// missing value reads as "—" rather than collapsing the layout.

/**
 * Relative "time ago" label, e.g. "just now", "5m ago", "yesterday",
 * "3d ago", "2mo ago", "1y ago". Falsy input → "—".
 */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/**
 * Absolute, locale-aware timestamp for tooltips/details, e.g.
 * "May 31, 2026, 11:48 AM". Falsy or unparseable input → "".
 */
export function absoluteDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Human duration from milliseconds: "850ms", "4.2s", "3m 7s", "1h 5m".
 * Trailing zero-seconds are dropped ("5m", "2h 0m" keeps minutes).
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSecs = Math.floor(ms / 1000);
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  if (hrs > 0) return secs > 0 ? `${hrs}h ${mins}m ${secs}s` : `${hrs}h ${mins}m`;
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}
