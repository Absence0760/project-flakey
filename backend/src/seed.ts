import pg from "pg";

const pool = new pg.Pool({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? "flakey",
  password: process.env.DB_PASSWORD ?? "flakey",
  database: process.env.DB_NAME ?? "flakey",
});

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

// Flaky tests — these flip between pass and fail
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
    // Clear existing data
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

      // Pick 2-5 random spec files for this run
      const numSpecs = randomInt(2, 5);
      const runSpecs = [...specFiles].sort(() => Math.random() - 0.5).slice(0, numSpecs);

      let runTotal = 0;
      let runPassed = 0;
      let runFailed = 0;
      let runSkipped = 0;

      // Pre-calculate stats
      const specData: { file: string; tests: { title: string; status: string; duration: number; error: string | null }[] }[] = [];

      for (const specFile of runSpecs) {
        const tests = testNames[specFile] ?? [];
        const specTests: typeof specData[0]["tests"] = [];

        for (const testTitle of tests) {
          let status: string;
          let error: string | null = null;
          const duration = randomInt(200, 15000);

          if (flakyTests.has(testTitle)) {
            // Flaky: 40% chance of failure
            status = Math.random() < 0.4 ? "failed" : "passed";
          } else {
            // Normal: 10% chance of failure, 5% skipped
            const roll = Math.random();
            if (roll < 0.1) status = "failed";
            else if (roll < 0.15) status = "skipped";
            else status = "passed";
          }

          if (status === "failed") {
            error = pick(errors);
          }

          specTests.push({ title: testTitle, status, duration, error });
          runTotal++;
          if (status === "passed") runPassed++;
          else if (status === "failed") runFailed++;
          else runSkipped++;
        }

        specData.push({ file: specFile, tests: specTests });
      }

      const runResult = await client.query(
        `INSERT INTO runs (suite_name, branch, commit_sha, ci_run_id, reporter, started_at, finished_at, total, passed, failed, skipped, pending, duration_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id`,
        [suite, branch, sha, `ci-${r + 1}`, "mochawesome", startedAt.toISOString(), finishedAt.toISOString(), runTotal, runPassed, runFailed, runSkipped, 0, durationMs]
      );
      const runId = runResult.rows[0].id;

      for (const spec of specData) {
        const specPassed = spec.tests.filter((t) => t.status === "passed").length;
        const specFailed = spec.tests.filter((t) => t.status === "failed").length;
        const specSkipped = spec.tests.filter((t) => t.status === "skipped").length;
        const specDuration = spec.tests.reduce((s, t) => s + t.duration, 0);

        const specResult = await client.query(
          `INSERT INTO specs (run_id, file_path, title, total, passed, failed, skipped, duration_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id`,
          [runId, spec.file, spec.file.split("/").pop()?.replace(".feature", "") ?? spec.file, spec.tests.length, specPassed, specFailed, specSkipped, specDuration]
        );
        const specId = specResult.rows[0].id;

        for (const test of spec.tests) {
          await client.query(
            `INSERT INTO tests (spec_id, title, full_title, status, duration_ms, error_message, error_stack, screenshot_paths, video_path)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              specId,
              test.title,
              `${spec.file} > ${test.title}`,
              test.status,
              test.duration,
              test.error,
              test.error ? `    at Context.<anonymous> (${spec.file}:${randomInt(10, 200)}:${randomInt(5, 40)})` : null,
              "{}",
              null,
            ]
          );
        }
      }
    }

    console.log(`Seeded ${numRuns} runs across ${suites.length} suites.`);
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
