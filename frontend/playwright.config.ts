import { defineConfig, devices } from "@playwright/test";

const FRONTEND_PORT = 8888;
const BACKEND_URL = process.env.E2E_BACKEND_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./tests-e2e",
  timeout: 30_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm preview --port ${FRONTEND_PORT}`,
    url: `http://localhost:${FRONTEND_PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      VITE_API_URL: BACKEND_URL,
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
