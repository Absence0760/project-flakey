import { untrack } from "svelte";

/**
 * Remembers the last-used query string per top-level section so the sidebar
 * can restore a user's filters when they navigate away and back.
 *
 * The pages themselves already mirror their filters into the URL (`?suite=…`,
 * `?status=…`, `?q=…`) and read them back on mount — so reload and bookmarks
 * work. The remaining gap is the sidebar: its links are bare paths (`/runs`),
 * so a round-trip (filter /runs → click Flaky → click Automated runs) drops
 * the query string. This store lets the layout point each sidebar link at the
 * section's last-seen URL instead.
 *
 * Backed by sessionStorage: filters survive in-tab navigation and reload, but
 * a brand-new tab starts clean. The URL stays the source of truth and remains
 * shareable — this only changes what the bare sidebar links resolve to.
 */

const KEY = "bt_section_views";

function load(): Record<string, string> {
  if (typeof sessionStorage === "undefined") return {};
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

let views = $state<Record<string, string>>(load());

function persist() {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(views));
  } catch {
    /* quota exceeded / storage disabled — the in-memory copy still works */
  }
}

/** Record the current query string (e.g. "?suite=api") for a section path. */
export function rememberView(section: string, search: string): void {
  // Read untracked so a caller inside an $effect doesn't take a reactive
  // dependency on `views` (which the same call then mutates).
  if (untrack(() => views[section]) === search) return;
  views = { ...views, [section]: search };
  persist();
}

/** The remembered query string for a section, or "" if none seen yet. */
export function viewFor(section: string): string {
  return views[section] ?? "";
}
