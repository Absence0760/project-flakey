import { goto } from "$app/navigation";

/**
 * Mirror page filter state into the address bar without loading anything:
 * a shallow, history-replacing goto (SvelteKit 3's replacement for
 * `replaceState`).
 *
 * Unlike `replaceState`, a shallow goto is a real navigation, so it is
 * skipped when the URL would not change. Pages call this from effects that
 * fire on mount; an unconditional goto there can land in the middle of a
 * back/forward navigation and pin the new URL onto the old page (the
 * release page never rendered after going back from a run).
 */
export function replaceUrl(url: URL): void {
  if (url.href === window.location.href) return;
  void goto(url, { shallow: true, replace: true });
}
