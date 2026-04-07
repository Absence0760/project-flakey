import pg from "pg";
import bcrypt from "bcryptjs";
import { copyFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const pool = new pg.Pool({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? "flakey",        // Use superuser for seeding (bypasses RLS)
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
    // Ensure app role exists (for RLS)
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'flakey_app') THEN
          CREATE ROLE flakey_app LOGIN PASSWORD 'flakey_app';
        END IF;
      END $$;
    `);
    await client.query("GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO flakey_app");
    await client.query("GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO flakey_app");
    await client.query("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO flakey_app");

    await client.query("TRUNCATE runs, specs, tests RESTART IDENTITY CASCADE");
    await client.query("TRUNCATE org_invites RESTART IDENTITY CASCADE");
    await client.query("DELETE FROM org_members");
    await client.query("DELETE FROM api_keys");
    await client.query("DELETE FROM organizations");
    await client.query("DELETE FROM users");

    // Seed users
    const adminHash = bcrypt.hashSync("admin", 10);
    const demoHash = bcrypt.hashSync("demo123", 10);
    const admin = await client.query(
      "INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, 'Admin', 'admin') RETURNING id",
      ["admin@flakey.dev", adminHash]
    );
    const demo = await client.query(
      "INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, 'Demo User', 'viewer') RETURNING id",
      ["demo@flakey.dev", demoHash]
    );
    const adminId = admin.rows[0].id;
    const demoId = demo.rows[0].id;

    // Seed orgs
    const org1 = await client.query(
      "INSERT INTO organizations (name, slug) VALUES ('Acme Corp', 'acme') RETURNING id"
    );
    const org2 = await client.query(
      "INSERT INTO organizations (name, slug) VALUES ('Demo Team', 'demo-team') RETURNING id"
    );
    const orgId = org1.rows[0].id;
    const org2Id = org2.rows[0].id;

    // Admin owns Acme Corp, Demo User owns Demo Team
    await client.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')", [orgId, adminId]);
    await client.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')", [org2Id, demoId]);

    console.log("Seeded users: admin@flakey.dev/admin (Acme Corp), demo@flakey.dev/demo123 (Demo Team)");

    // Set RLS context for seeded runs
    await client.query("SELECT set_config('app.current_org_id', $1::text, true)", [String(orgId)]);

    const numRuns = 50;
    const now = Date.now();
    const DAY_MS = 86400000;

    // Spread runs across different time periods for date filter testing:
    //  - 5 runs today
    //  - 5 runs yesterday
    //  - 10 runs in the last 7 days
    //  - 10 runs in the last 30 days
    //  - 10 runs in the last 6 months
    //  - 10 runs 6-18 months ago
    const runOffsets: number[] = [];
    for (let i = 0; i < 5; i++) runOffsets.push(randomInt(0, DAY_MS * 0.5));              // today
    for (let i = 0; i < 5; i++) runOffsets.push(DAY_MS + randomInt(0, DAY_MS * 0.8));     // yesterday
    for (let i = 0; i < 10; i++) runOffsets.push(DAY_MS * randomInt(2, 7));                // last week
    for (let i = 0; i < 10; i++) runOffsets.push(DAY_MS * randomInt(8, 30));               // last month
    for (let i = 0; i < 10; i++) runOffsets.push(DAY_MS * randomInt(31, 180));             // last 6 months
    for (let i = 0; i < 10; i++) runOffsets.push(DAY_MS * randomInt(181, 540));            // 6-18 months ago
    runOffsets.sort((a, b) => b - a); // oldest first

    for (let r = 0; r < numRuns; r++) {
      const suite = pick(suites);
      const branch = pick(branches);
      const sha = Math.random().toString(16).slice(2, 10);
      const startedAt = new Date(now - runOffsets[r]);
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
          metadata: object | null;
        }[];
      }[] = [];

      const runResult = await client.query(
        `INSERT INTO runs (suite_name, branch, commit_sha, ci_run_id, reporter, started_at, finished_at, total, passed, failed, skipped, pending, duration_ms, created_at, org_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id`,
        [suite, branch, sha, `ci-${r + 1}`, "mochawesome", startedAt.toISOString(), finishedAt.toISOString(), 0, 0, 0, 0, 0, durationMs, startedAt.toISOString(), orgId]
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
            tests: [{ title: testTitle, status, duration, error, errorStack, code, commandLog, screenshotPaths, metadata: null }],
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
            `INSERT INTO tests (spec_id, title, full_title, status, duration_ms, error_message, error_stack, screenshot_paths, video_path, test_code, command_log, metadata)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
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
              test.metadata ? JSON.stringify(test.metadata) : null,
            ]
          );
        }
      }
    }

    // --- Playwright seed runs ---
    const pwSpecs = [
      {
        file: "tests/auth/login.spec.ts",
        tests: [
          { title: "should login with valid credentials", status: "passed", duration: 1200, tags: ["@smoke", "@auth"], annotations: [], location: { file: "tests/auth/login.spec.ts", line: 8, column: 5 }, retries: null, stdout: ["Navigating to /login", "Login form rendered"], stderr: null },
          { title: "should show error for invalid password", status: "failed", duration: 3500, tags: ["@auth"], annotations: [], location: { file: "tests/auth/login.spec.ts", line: 22, column: 5 },
            retries: [
              { attempt: 1, status: "failed", duration: 3200, error: { message: "Timeout: locator.click resolved to hidden element", stack: "at login.spec.ts:30:5" } },
              { attempt: 2, status: "failed", duration: 3500, error: { message: "Timeout: locator.click resolved to hidden element", stack: "at login.spec.ts:30:5" } },
            ],
            stdout: ["Navigating to /login"], stderr: ["Warning: element not interactable"],
            errorSnippet: "  await page.locator('#submit-btn').click();\n> await expect(page.locator('.error-msg')).toBeVisible();\n  await expect(page.locator('.error-msg')).toHaveText('Invalid password');" },
          { title: "should handle SSO redirect", status: "passed", duration: 4200, tags: ["@auth", "@sso"], annotations: [{ type: "slow", description: "involves external SSO provider redirect" }], location: { file: "tests/auth/login.spec.ts", line: 45, column: 5 },
            retries: [
              { attempt: 1, status: "failed", duration: 5000, error: { message: "Navigation timeout" } },
              { attempt: 2, status: "passed", duration: 4200 },
            ],
            stdout: ["SSO redirect initiated", "SSO callback received", "Dashboard loaded"], stderr: null },
          { title: "should remember me checkbox", status: "skipped", duration: 0, tags: ["@auth"], annotations: [{ type: "skip", description: "Feature not implemented yet" }, { type: "fixme", description: "Blocked by AUTH-234" }], location: { file: "tests/auth/login.spec.ts", line: 70, column: 5 }, retries: null, stdout: null, stderr: null },
        ]
      },
      {
        file: "tests/checkout/payment.spec.ts",
        tests: [
          { title: "should complete checkout with credit card", status: "passed", duration: 6800, tags: ["@checkout", "@smoke"], annotations: [{ type: "slow", description: "waits for payment gateway" }], location: { file: "tests/checkout/payment.spec.ts", line: 12, column: 5 }, retries: null, stdout: ["Cart total: $99.99", "Payment processed", "Confirmation email sent"], stderr: null },
          { title: "should apply discount code", status: "passed", duration: 2100, tags: ["@checkout"], annotations: [], location: { file: "tests/checkout/payment.spec.ts", line: 35, column: 5 }, retries: null, stdout: ["Discount SAVE20 applied: -$20.00"], stderr: null },
          { title: "should reject expired card", status: "failed", duration: 8500, tags: ["@checkout", "@negative"], annotations: [], location: { file: "tests/checkout/payment.spec.ts", line: 52, column: 5 }, retries: null, stdout: null, stderr: ["Error: PaymentGateway returned 402"],
            errorSnippet: "  await page.fill('#card-expiry', '01/20');\n  await page.click('#pay-btn');\n> await expect(page.locator('.error-banner')).toContainText('expired');" },
        ]
      },
    ];

    for (let i = 0; i < 3; i++) {
      const pwStart = new Date(now - DAY_MS * randomInt(1, 14));
      const pwDuration = randomInt(20000, 60000);
      const pwRun = await client.query(
        `INSERT INTO runs (suite_name, branch, commit_sha, ci_run_id, reporter, started_at, finished_at, total, passed, failed, skipped, pending, duration_ms, created_at, org_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        ["e2e-playwright", pick(branches), Math.random().toString(16).slice(2, 10), `pw-${i + 1}`, "playwright",
         pwStart.toISOString(), new Date(pwStart.getTime() + pwDuration).toISOString(),
         0, 0, 0, 0, 0, pwDuration, pwStart.toISOString(), orgId]
      );
      const pwRunId = pwRun.rows[0].id;
      let pwTotal = 0, pwPassed = 0, pwFailed = 0, pwSkipped = 0;

      for (const spec of pwSpecs) {
        const specTests = spec.tests.map((t) => {
          // Randomize some statuses for variety across runs
          let status = t.status;
          if (t.retries && Math.random() < 0.5) status = "passed"; // sometimes the retry succeeds
          return { ...t, status };
        });
        const sp = specTests.filter((t) => t.status === "passed").length;
        const sf = specTests.filter((t) => t.status === "failed").length;
        const ss = specTests.filter((t) => t.status === "skipped").length;

        const specResult = await client.query(
          `INSERT INTO specs (run_id, file_path, title, total, passed, failed, skipped, duration_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [pwRunId, spec.file, spec.file.split("/").pop()?.replace(".spec.ts", "") ?? spec.file,
           specTests.length, sp, sf, ss, specTests.reduce((s, t) => s + t.duration, 0)]
        );

        for (const t of specTests) {
          const metadata: Record<string, unknown> = {};
          if (t.tags.length) metadata.tags = t.tags;
          if (t.annotations.length) metadata.annotations = t.annotations;
          if (t.location) metadata.location = t.location;
          if (t.retries) metadata.retries = t.retries;
          if (t.stdout) metadata.stdout = t.stdout;
          if (t.stderr) metadata.stderr = t.stderr;
          if ((t as any).errorSnippet) metadata.error_snippet = (t as any).errorSnippet;

          const errMsg = t.status === "failed" ? (t.retries?.[t.retries.length - 1]?.error?.message ?? pick(errors)) : null;
          const errStack = t.status === "failed" ? `at ${spec.file}:${t.location?.line ?? 0}` : null;

          await client.query(
            `INSERT INTO tests (spec_id, title, full_title, status, duration_ms, error_message, error_stack, screenshot_paths, video_path, test_code, command_log, metadata)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [specResult.rows[0].id, t.title, `${spec.file} > ${t.title}`, t.status, t.duration,
             errMsg, errStack, [], null, null, null,
             Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null]
          );
          pwTotal++;
          if (t.status === "passed") pwPassed++;
          else if (t.status === "failed") pwFailed++;
          else pwSkipped++;
        }
      }
      await client.query("UPDATE runs SET total=$1, passed=$2, failed=$3, skipped=$4 WHERE id=$5",
        [pwTotal, pwPassed, pwFailed, pwSkipped, pwRunId]);
    }
    console.log("Seeded 3 Playwright runs with metadata (tags, annotations, retries, stdout).");

    // --- JUnit seed runs ---
    const junitSuites = [
      {
        name: "com.example.UserServiceTest",
        file: "src/test/java/com/example/UserServiceTest.java",
        hostname: "ci-runner-42",
        properties: { "java.version": "17.0.2", "os.name": "Linux", "junit.version": "5.9.3" },
        tests: [
          { title: "testCreateUser", classname: "com.example.UserServiceTest", status: "passed", duration: 520, stdout: "Creating user: john@test.com\nUser created with ID: 42", stderr: null, errorType: null, skipMessage: null },
          { title: "testGetUserById", classname: "com.example.UserServiceTest", status: "passed", duration: 180, stdout: "Fetching user ID=42\nUser found: john@test.com", stderr: null, errorType: null, skipMessage: null },
          { title: "testDeleteUser", classname: "com.example.UserServiceTest", status: "failed", duration: 850, stdout: "Attempting to delete user ID=42", stderr: "WARN: Foreign key constraint on orders table", errorType: "java.lang.AssertionError", skipMessage: null },
          { title: "testUpdateEmail", classname: "com.example.UserServiceTest", status: "failed", duration: 300, stdout: null, stderr: "ERROR: Email validation failed", errorType: "java.lang.NullPointerException", skipMessage: null },
          { title: "testBulkImport", classname: "com.example.UserServiceTest", status: "skipped", duration: 0, stdout: null, stderr: null, errorType: null, skipMessage: "Requires external CSV service" },
        ]
      },
      {
        name: "com.example.OrderServiceTest",
        file: "src/test/java/com/example/OrderServiceTest.java",
        hostname: "ci-runner-42",
        properties: { "java.version": "17.0.2", "db.dialect": "PostgreSQL" },
        tests: [
          { title: "testCreateOrder", classname: "com.example.OrderServiceTest", status: "passed", duration: 1200, stdout: "Order created: ORD-001\nTotal: $149.99", stderr: null, errorType: null, skipMessage: null },
          { title: "testCancelOrder", classname: "com.example.OrderServiceTest", status: "passed", duration: 650, stdout: "Order ORD-001 cancelled\nRefund initiated: $149.99", stderr: null, errorType: null, skipMessage: null },
          { title: "testOrderHistory", classname: "com.example.OrderServiceTest", status: "failed", duration: 2100, stdout: "Querying order history for user 42", stderr: "WARN: Slow query detected (>1s)", errorType: "org.opentest4j.AssertionFailedError", skipMessage: null },
        ]
      },
    ];

    for (let i = 0; i < 3; i++) {
      const jStart = new Date(now - DAY_MS * randomInt(1, 14));
      const jDuration = randomInt(5000, 15000);
      const jRun = await client.query(
        `INSERT INTO runs (suite_name, branch, commit_sha, ci_run_id, reporter, started_at, finished_at, total, passed, failed, skipped, pending, duration_ms, created_at, org_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        ["api-tests", pick(branches), Math.random().toString(16).slice(2, 10), `junit-${i + 1}`, "junit",
         jStart.toISOString(), new Date(jStart.getTime() + jDuration).toISOString(),
         0, 0, 0, 0, 0, jDuration, jStart.toISOString(), orgId]
      );
      const jRunId = jRun.rows[0].id;
      let jTotal = 0, jPassed = 0, jFailed = 0, jSkipped = 0;

      for (const suite of junitSuites) {
        const suiteTests = suite.tests.map((t) => {
          let status = t.status;
          if (status === "failed" && Math.random() < 0.3) status = "passed";
          return { ...t, status };
        });
        const sp = suiteTests.filter((t) => t.status === "passed").length;
        const sf = suiteTests.filter((t) => t.status === "failed").length;
        const ss = suiteTests.filter((t) => t.status === "skipped").length;

        const specResult = await client.query(
          `INSERT INTO specs (run_id, file_path, title, total, passed, failed, skipped, duration_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [jRunId, suite.file, suite.name, suiteTests.length, sp, sf, ss,
           suiteTests.reduce((s, t) => s + t.duration, 0)]
        );

        for (const t of suiteTests) {
          const metadata: Record<string, unknown> = {};
          if (t.classname) metadata.classname = t.classname;
          if (t.errorType && t.status === "failed") metadata.error_type = t.errorType;
          if (t.stdout) metadata.stdout = t.stdout.split("\n");
          if (t.stderr) metadata.stderr = t.stderr.split("\n");
          if (t.skipMessage) metadata.skip_message = t.skipMessage;
          metadata.hostname = suite.hostname;
          metadata.properties = suite.properties;

          const errMsg = t.status === "failed" ? `Expected condition not met in ${t.title}` : null;
          const errStack = t.status === "failed"
            ? `${t.errorType ?? "AssertionError"}: Expected condition not met\n    at ${t.classname}.${t.title}(${suite.file.split("/").pop()}:${randomInt(20, 150)})\n    at org.junit.platform.engine.support.hierarchical.NodeTestTask.execute(NodeTestTask.java:95)`
            : null;

          await client.query(
            `INSERT INTO tests (spec_id, title, full_title, status, duration_ms, error_message, error_stack, screenshot_paths, video_path, test_code, command_log, metadata)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [specResult.rows[0].id, t.title, `${t.classname} > ${t.title}`, t.status, t.duration,
             errMsg, errStack, [], null, null, null,
             Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null]
          );
          jTotal++;
          if (t.status === "passed") jPassed++;
          else if (t.status === "failed") jFailed++;
          else jSkipped++;
        }
      }
      await client.query("UPDATE runs SET total=$1, passed=$2, failed=$3, skipped=$4 WHERE id=$5",
        [jTotal, jPassed, jFailed, jSkipped, jRunId]);
    }
    console.log("Seeded 3 JUnit runs with metadata (classname, error_type, stdout/stderr, properties, hostname).");

    // Log date distribution for verification
    const counts = { today: 0, yesterday: 0, week: 0, month: 0, sixMonths: 0, older: 0 };
    const res = await client.query("SELECT created_at FROM runs ORDER BY created_at DESC");
    for (const row of res.rows) {
      const age = now - new Date(row.created_at).getTime();
      if (age < DAY_MS) counts.today++;
      else if (age < DAY_MS * 2) counts.yesterday++;
      else if (age < DAY_MS * 7) counts.week++;
      else if (age < DAY_MS * 30) counts.month++;
      else if (age < DAY_MS * 180) counts.sixMonths++;
      else counts.older++;
    }
    console.log(`Seeded ${numRuns} runs across ${suites.length} suites with screenshots.`);
    console.log(`Distribution: today=${counts.today}, yesterday=${counts.yesterday}, last7d=${counts.week}, last30d=${counts.month}, last6mo=${counts.sixMonths}, older=${counts.older}`);
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
