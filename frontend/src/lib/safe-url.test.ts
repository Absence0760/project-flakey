import { describe, it, expect } from "vitest";
import { isHttpUrl, safeHref } from "./safe-url.js";

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
