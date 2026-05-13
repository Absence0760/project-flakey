// Defence-in-depth: render-time gate for user-supplied URLs that end up
// in `<a href>`. Backend write paths already reject non-http(s), but old
// rows or future code paths shouldn't be able to surface a `javascript:`
// payload as a clickable link.
export function isHttpUrl(value: string | null | undefined): boolean {
	if (!value) return false;
	try {
		const u = new URL(value);
		return u.protocol === 'http:' || u.protocol === 'https:';
	} catch {
		return false;
	}
}

// Returns the URL when it's safe to render as an `href`, otherwise `null`.
export function safeHref(value: string | null | undefined): string | null {
	return isHttpUrl(value) ? (value as string) : null;
}

// Resolve a storage-backed attachment URL for use in `<a href>` /
// `<img src>`. The backend returns one of:
//   - presigned absolute https:// URL (S3 mode)
//   - same-origin `/uploads/...` path (local mode)
// Anything else (javascript:, data:, file:, garbage) collapses to `#`
// so a future regression that ever lets user input flow into this
// field can't smuggle a script-running URL into a rendered tag.
export function absoluteAttachmentUrl(url: string | null | undefined, apiBaseUrl: string): string {
	if (!url) return '#';
	if (url.startsWith('/')) return `${apiBaseUrl}${url}`;
	return isHttpUrl(url) ? url : '#';
}
