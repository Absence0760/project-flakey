import { describe, it, expect } from "vitest";
import { isHttpUrl, safeHref, absoluteAttachmentUrl } from "./safe-url.js";

describe("isHttpUrl", () => {
	it("accepts http URLs", () => {
		expect(isHttpUrl("http://example.com")).toBe(true);
		expect(isHttpUrl("http://example.com/path?q=1")).toBe(true);
	});

	it("accepts https URLs", () => {
		expect(isHttpUrl("https://example.com")).toBe(true);
		expect(isHttpUrl("https://jira.example.atlassian.net/browse/ABC-1")).toBe(true);
	});

	it("rejects javascript: URLs (the XSS payload)", () => {
		expect(isHttpUrl("javascript:alert(1)")).toBe(false);
		expect(isHttpUrl("JAVASCRIPT:alert(1)")).toBe(false);
		// `javascript://example.com/%0Aalert(1)` actually parses successfully
		// in URL — protocol comes out as `javascript:`. Caught by protocol check.
		expect(isHttpUrl("javascript://example.com/%0Aalert(1)")).toBe(false);
	});

	it("rejects data: URLs", () => {
		expect(isHttpUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
		expect(isHttpUrl("data:image/png;base64,AAAA")).toBe(false);
	});

	it("rejects vbscript:, file:, ftp:", () => {
		expect(isHttpUrl("vbscript:alert(1)")).toBe(false);
		expect(isHttpUrl("file:///etc/passwd")).toBe(false);
		expect(isHttpUrl("ftp://example.com")).toBe(false);
	});

	it("rejects malformed inputs", () => {
		expect(isHttpUrl(null)).toBe(false);
		expect(isHttpUrl(undefined)).toBe(false);
		expect(isHttpUrl("")).toBe(false);
		expect(isHttpUrl("not a url")).toBe(false);
		expect(isHttpUrl("/relative/path")).toBe(false);
	});
});

describe("safeHref", () => {
	it("returns the URL when http(s)", () => {
		expect(safeHref("https://example.com")).toBe("https://example.com");
	});

	it("returns null for unsafe schemes", () => {
		expect(safeHref("javascript:alert(1)")).toBeNull();
		expect(safeHref("data:text/html,...")).toBeNull();
		expect(safeHref(null)).toBeNull();
		expect(safeHref(undefined)).toBeNull();
	});
});

describe("absoluteAttachmentUrl", () => {
	const API = "https://api.flakey.io";

	it("joins same-origin /uploads paths onto the API base URL", () => {
		expect(absoluteAttachmentUrl("/uploads/evidence/42/7/x.png", API))
			.toBe("https://api.flakey.io/uploads/evidence/42/7/x.png");
	});

	it("returns an absolute https URL untouched (S3 presigned form)", () => {
		const presigned = "https://flakey-bucket.s3.amazonaws.com/runs/1/screenshots/foo.png?X-Amz-Signature=abc";
		expect(absoluteAttachmentUrl(presigned, API)).toBe(presigned);
	});

	it("returns '#' for javascript: URLs even when the backend somehow surfaces one", () => {
		// Defence-in-depth: if a future regression ever lets user input
		// flow into attachment.url, this gate keeps it out of <a href>.
		expect(absoluteAttachmentUrl("javascript:alert(1)", API)).toBe("#");
	});

	it("returns '#' for data: URLs (no inline HTML smuggling)", () => {
		expect(absoluteAttachmentUrl("data:text/html,<script>alert(1)</script>", API)).toBe("#");
	});

	it("returns '#' for file:// URLs", () => {
		expect(absoluteAttachmentUrl("file:///etc/passwd", API)).toBe("#");
	});

	it("returns '#' for null / undefined / empty input", () => {
		expect(absoluteAttachmentUrl(null, API)).toBe("#");
		expect(absoluteAttachmentUrl(undefined, API)).toBe("#");
		expect(absoluteAttachmentUrl("", API)).toBe("#");
	});

	it("returns '#' for a malformed value that isn't a path or a URL", () => {
		expect(absoluteAttachmentUrl("not a url and not a path", API)).toBe("#");
	});
});
