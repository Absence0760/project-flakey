import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // src/** for the pure-helper unit tests; the root-level glob picks up
    // build-config guards that live next to their subject (e.g.
    // svelte.config.test.ts beside svelte.config.js).
    include: ["src/**/*.test.ts", "*.test.ts"],
    environment: "node",
  },
});
