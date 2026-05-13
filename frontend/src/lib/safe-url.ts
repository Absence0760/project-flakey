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
