import pg from "pg";
import { copyFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const pool = new pg.Pool({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? "flakey",
  password: process.env.DB_PASSWORD ?? "flakey",
  database: process.env.DB_NAME ?? "flakey",
});

const FIXTURE_SCREENSHOT = join(__dirname, "..", "fixtures", "sample-screenshot.png");

const suites = ["encor-e2e", "payments-e2e", "auth-e2e"];
const branches = ["main", "dev", "feature/checkout", "fix/login-timeout"];
const specFiles = [
  "cypress/e2e/collections/permissions.feature",
  "cypress/e2e/auth/login.feature",
  "cypress/e2e/auth/signup.feature",
  "cypress/e2e/dashboard/widgets.feature",
  "cypress/e2e/payments/checkout.feature",
  "cypress/e2e/payments/refund.feature",
  "cypress/e2e/settings/profile.feature",
  "cypress/e2e/search/filters.feature",
];

const testNames: Record<string, string[]> = {
  "cypress/e2e/collections/permissions.feature": [
    "should allow admin to create collection",
    "should restrict read-only user from editing",
    "should allow delete with correct permissions",
  ],
  "cypress/e2e/auth/login.feature": [
    "should login with valid credentials",
    "should show error for invalid password",
    "should redirect to dashboard after login",
    "should handle SSO login flow",
  ],
  "cypress/e2e/auth/signup.feature": [
    "should create account with valid email",
    "should reject duplicate email",
  ],
  "cypress/e2e/dashboard/widgets.feature": [
    "should load all widgets on dashboard",
    "should drag and drop widget to reorder",
    "should persist widget layout after refresh",
    "should show empty state for new users",
  ],
  "cypress/e2e/payments/checkout.feature": [
    "should complete checkout with credit card",
    "should apply discount code",
    "should show validation error for expired card",
    "should calculate tax correctly",
    "should send confirmation email after purchase",
  ],
  "cypress/e2e/payments/refund.feature": [
    "should process full refund",
    "should process partial refund",
    "should prevent refund after 30 days",
  ],
  "cypress/e2e/settings/profile.feature": [
    "should update display name",
    "should upload avatar image",
    "should change email with verification",
  ],
  "cypress/e2e/search/filters.feature": [
    "should filter results by date range",
    "should filter results by category",
    "should combine multiple filters",
    "should clear all filters",
    "should show no results message",
  ],
};

const testCode: Record<string, string> = {
  "should login with valid credentials": `it('should login with valid credentials', () => {
  cy.visit('/login');
  cy.get('[data-testid="email-input"]').type('user@example.com');
  cy.get('[data-testid="password-input"]').type('SecurePass123');
  cy.get('[data-testid="login-btn"]').click();
  cy.url().should('include', '/dashboard');
  cy.get('[data-testid="welcome-msg"]').should('contain', 'Welcome');
});`,
  "should handle SSO login flow": `it('should handle SSO login flow', () => {
  cy.visit('/login');
  cy.get('[data-testid="sso-btn"]').click();
  cy.origin('https://sso.provider.com', () => {
    cy.get('#username').type('sso-user');
    cy.get('#password').type('sso-pass');
    cy.get('#submit').click();
  });
  cy.url().should('include', '/dashboard');
});`,
  "should apply discount code": `it('should apply discount code', () => {
  cy.get('[data-testid="discount-input"]').type('SAVE20');
  cy.get('[data-testid="apply-discount"]').click();
  cy.get('[data-testid="discount-badge"]').should('be.visible');
  cy.get('[data-testid="total-price"]').should('contain', '$80.00');
});`,
  "should drag and drop widget to reorder": `it('should drag and drop widget to reorder', () => {
  cy.get('[data-testid="widget-revenue"]')
    .trigger('dragstart');
  cy.get('[data-testid="widget-slot-2"]')
    .trigger('drop');
  cy.get('[data-testid="widget-slot-2"]')
    .should('contain', 'Revenue');
});`,
  "should combine multiple filters": `it('should combine multiple filters', () => {
  cy.get('[data-testid="filter-date"]').click();
  cy.get('[data-testid="date-last-7"]').click();
  cy.get('[data-testid="filter-category"]').click();
  cy.get('[data-testid="cat-electronics"]').click();
  cy.get('[data-testid="apply-filters"]').click();
  cy.get('[data-testid="results-count"]').should('contain', '12');
});`,
  "should complete checkout with credit card": `it('should complete checkout with credit card', () => {
  cy.get('[data-testid="card-number"]').type('4242424242424242');
  cy.get('[data-testid="card-expiry"]').type('12/28');
  cy.get('[data-testid="card-cvc"]').type('123');
  cy.get('[data-testid="pay-btn"]').click();
  cy.get('[data-testid="confirmation"]', { timeout: 10000 })
    .should('contain', 'Payment successful');
});`,
};

const sampleCommandLogs = [
  [
    { name: "visit", message: "/login", state: "passed" },
    { name: "get", message: "[data-testid=\"email-input\"]", state: "passed" },
    { name: "type", message: "user@example.com", state: "passed" },
    { name: "get", message: "[data-testid=\"password-input\"]", state: "passed" },
    { name: "type", message: "SecurePass123", state: "passed" },
    { name: "get", message: "[data-testid=\"login-btn\"]", state: "passed" },
    { name: "click", message: "", state: "passed" },
    { name: "url", message: "", state: "passed" },
    { name: "should", message: "include /dashboard", state: "failed" },
  ],
  [
    { name: "get", message: "[data-testid=\"submit-btn\"]", state: "passed" },
    { name: "click", message: "", state: "passed" },
    { name: "get", message: "[data-testid=\"success-msg\"]", state: "failed" },
  ],
  [
    { name: "visit", message: "/checkout", state: "passed" },
    { name: "get", message: "[data-testid=\"discount-input\"]", state: "passed" },
    { name: "type", message: "SAVE20", state: "passed" },
    { name: "get", message: "[data-testid=\"apply-discount\"]", state: "passed" },
    { name: "click", message: "", state: "passed" },
    { name: "get", message: "[data-testid=\"discount-badge\"]", state: "failed" },
  ],
];

const errors = [
  "AssertionError: Timed out retrying after 4000ms: Expected to find element: `[data-testid=\"submit-btn\"]`, but never found it.",
  "CypressError: `cy.click()` failed because this element is `disabled`.",
  "AssertionError: expected 200 to equal 201",
  "Error: Request failed with status code 500",
  "AssertionError: Timed out retrying after 4000ms: expected '<div>' to have text 'Success', but the text was 'Loading...'",
  "CypressError: `cy.intercept()` was called with an invalid argument. The route matcher must be a string or object.",
  "TypeError: Cannot read properties of undefined (reading 'id')",
  "AssertionError: expected [] to have a length of 3 but got 0",
];

const flakyTests = new Set([
  "should drag and drop widget to reorder",
  "should apply discount code",
  "should combine multiple filters",
  "should handle SSO login flow",
]);

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function seed() {
  const client = await pool.connect();

  try {
    await client.query("TRUNCATE runs, specs, tests RESTART IDENTITY CASCADE");

    const numRuns = 25;
    const now = Date.now();

    for (let r = 0; r < numRuns; r++) {
      const suite = pick(suites);
      const branch = pick(branches);
      const sha = Math.random().toString(16).slice(2, 10);
      const startedAt = new Date(now - (numRuns - r) * 3600000 * randomInt(2, 8));
      const durationMs = randomInt(30000, 180000);
      const finishedAt = new Date(startedAt.getTime() + durationMs);

      const numSpecs = randomInt(2, 5);
      const runSpecs = [...specFiles].sort(() => Math.random() - 0.5).slice(0, numSpecs);

      let runTotal = 0;
      let runPassed = 0;
      let runFailed = 0;
      let runSkipped = 0;

      const specData: {
        file: string;
        tests: {
          title: string;
          status: string;
          duration: number;
          error: string | null;
          errorStack: string | null;
          code: string | null;
          commandLog: object[] | null;
          screenshotPaths: string[];
        }[];
      }[] = [];

      const runResult = await client.query(
        `INSERT INTO runs (suite_name, branch, commit_sha, ci_run_id, reporter, started_at, finished_at, total, passed, failed, skipped, pending, duration_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id`,
        [suite, branch, sha, `ci-${r + 1}`, "mochawesome", startedAt.toISOString(), finishedAt.toISOString(), 0, 0, 0, 0, 0, durationMs]
      );
      const runId = runResult.rows[0].id;

      // Create screenshot directory for this run
      const screenshotDir = join("uploads", "runs", String(runId), "screenshots");
      mkdirSync(screenshotDir, { recursive: true });

      for (const specFile of runSpecs) {
        const tests = testNames[specFile] ?? [];

        for (const testTitle of tests) {
          let status: string;
          let error: string | null = null;
          let errorStack: string | null = null;
          const duration = randomInt(200, 15000);

          if (flakyTests.has(testTitle)) {
            status = Math.random() < 0.4 ? "failed" : "passed";
          } else {
            const roll = Math.random();
            if (roll < 0.1) status = "failed";
            else if (roll < 0.15) status = "skipped";
            else status = "passed";
          }

          let screenshotPaths: string[] = [];
          if (status === "failed") {
            error = pick(errors);
            errorStack = `    at Context.<anonymous> (${specFile}:${randomInt(10, 200)}:${randomInt(5, 40)})\n    at runTest (node_modules/cypress/lib/runner.js:${randomInt(100, 500)}:${randomInt(5, 30)})\n    at processTicksAndRejections (node:internal/process/task_queues:95:5)`;

            // Copy sample screenshot for failed tests
            const screenshotName = `${specFile.split("/").pop()} -- ${testTitle} (failed).png`;
            const screenshotDest = join(screenshotDir, screenshotName);
            if (existsSync(FIXTURE_SCREENSHOT)) {
              copyFileSync(FIXTURE_SCREENSHOT, screenshotDest);
              screenshotPaths = [`runs/${runId}/screenshots/${screenshotName}`];
            }
          }

          const code = testCode[testTitle] ?? null;
          const commandLog = status === "failed" ? pick(sampleCommandLogs) : null;

          specData.push({
            file: specFile,
            tests: [{ title: testTitle, status, duration, error, errorStack, code, commandLog, screenshotPaths }],
          });

          runTotal++;
          if (status === "passed") runPassed++;
          else if (status === "failed") runFailed++;
          else runSkipped++;
        }
      }

      // Update run stats
      await client.query(
        `UPDATE runs SET total=$1, passed=$2, failed=$3, skipped=$4 WHERE id=$5`,
        [runTotal, runPassed, runFailed, runSkipped, runId]
      );

      // Group by spec file
      const specGroups = new Map<string, typeof specData[0]["tests"]>();
      for (const sd of specData) {
        const existing = specGroups.get(sd.file) ?? [];
        existing.push(...sd.tests);
        specGroups.set(sd.file, existing);
      }

      for (const [specFile, tests] of specGroups) {
        const specPassed = tests.filter((t) => t.status === "passed").length;
        const specFailed = tests.filter((t) => t.status === "failed").length;
        const specSkipped = tests.filter((t) => t.status === "skipped").length;
        const specDuration = tests.reduce((s, t) => s + t.duration, 0);

        const specResult = await client.query(
          `INSERT INTO specs (run_id, file_path, title, total, passed, failed, skipped, duration_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id`,
          [runId, specFile, specFile.split("/").pop()?.replace(".feature", "") ?? specFile, tests.length, specPassed, specFailed, specSkipped, specDuration]
        );
        const specId = specResult.rows[0].id;

        for (const test of tests) {
          await client.query(
            `INSERT INTO tests (spec_id, title, full_title, status, duration_ms, error_message, error_stack, screenshot_paths, video_path, test_code, command_log)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              specId,
              test.title,
              `${specFile} > ${test.title}`,
              test.status,
              test.duration,
              test.error,
              test.errorStack,
              test.screenshotPaths,
              null,
              test.code,
              test.commandLog ? JSON.stringify(test.commandLog) : null,
            ]
          );
        }
      }
    }

    console.log(`Seeded ${numRuns} runs across ${suites.length} suites with screenshots.`);
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
