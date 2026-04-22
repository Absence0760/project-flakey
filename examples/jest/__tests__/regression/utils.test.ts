import { slugify, truncate, groupBy, formatDuration, retry } from "../../src/utils.js";

describe("utils — regression", () => {
  describe("slugify()", () => {
    it("lowercases text", () => {
      expect(slugify("Hello World")).toBe("hello-world");
    });

    it("replaces spaces with hyphens", () => {
      expect(slugify("foo bar baz")).toBe("foo-bar-baz");
    });

    it("removes special characters", () => {
      expect(slugify("hello! world?")).toBe("hello-world");
    });

    it("trims leading/trailing hyphens", () => {
      expect(slugify("  hello  ")).toBe("hello");
    });

    it("collapses multiple separators", () => {
      expect(slugify("foo  --  bar")).toBe("foo-bar");
    });

    it("handles empty string", () => {
      expect(slugify("")).toBe("");
    });
  });

  describe("truncate()", () => {
    it("returns original when short enough", () => {
      expect(truncate("hello", 10)).toBe("hello");
      expect(truncate("hello", 5)).toBe("hello");
    });

    it("truncates with ellipsis", () => {
      expect(truncate("hello world", 8)).toBe("hello...");
    });

    it("handles exact boundary", () => {
      expect(truncate("hello", 5)).toBe("hello");
    });
  });

  describe("groupBy()", () => {
    it("groups items by key", () => {
      const items = [
        { name: "a", type: "x" },
        { name: "b", type: "y" },
        { name: "c", type: "x" },
      ];
      const result = groupBy(items, (i) => i.type);
      expect(result["x"]).toHaveLength(2);
      expect(result["y"]).toHaveLength(1);
    });

    it("returns empty object for empty input", () => {
      expect(groupBy([], (i: string) => i)).toEqual({});
    });
  });

  describe("formatDuration()", () => {
    it("formats milliseconds", () => {
      expect(formatDuration(500)).toBe("500ms");
    });

    it("formats seconds", () => {
      expect(formatDuration(2500)).toBe("2.5s");
    });

    it("formats minutes", () => {
      expect(formatDuration(65_000)).toBe("1m 5s");
    });
  });

  describe("retry()", () => {
    it("returns immediately on success", () => {
      let calls = 0;
      const result = retry(() => { calls++; return 42; }, 3);
      expect(result).toBe(42);
      expect(calls).toBe(1);
    });

    it("retries on failure and succeeds", () => {
      let calls = 0;
      const result = retry(() => {
        calls++;
        if (calls < 3) throw new Error("not yet");
        return "ok";
      }, 5);
      expect(result).toBe("ok");
      expect(calls).toBe(3);
    });

    it("throws after exhausting attempts", () => {
      expect(() => retry(() => { throw new Error("always fails"); }, 3)).toThrow("always fails");
    });
  });
});
