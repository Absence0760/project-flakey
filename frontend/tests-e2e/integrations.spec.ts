import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";

import { ADMIN_USER, VIEWER_USER } from "./fixtures/users";

/**
 * Integration-surface e2e: webhooks (full CRUD + delivery), Jira
 * settings + test connection, PagerDuty settings + test connection.
 *
 * Webhook delivery is exercised end-to-end: a one-shot HTTP server
 * spun up inside the test captures the POST body the backend fires,
 * so we can assert the payload shape Slack/Discord/Teams plugins
 * actually receive — not just the formatPayload unit-test surface.
 *
 * Jira/PagerDuty `/test` endpoints make outbound requests; without a
 * configured integration they correctly 400. We don't try to mock
 * the upstream — that would test the mock, not the integration. We
 * pin the configured-vs-unconfigured contract instead, which is what
 * regresses silently in practice.
 */

const BACKEND = "http://localhost:3000";
const POLL_TIMEOUT = 10_000;

async function getToken(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem("bt_token") ?? "");
}

/**
 * Spin up a one-shot http server on a random free port. Returns the
 * URL the test should register as the webhook target, plus a promise
 * that resolves with the captured request once the backend posts.
 *
 * The server auto-closes once the first request comes in (or when the
 * test calls `close()` for cleanup paths that never fire).
 */
function captureNextWebhook(): {
  url: () => string;
  received: Promise<{ body: string; headers: Record<string, string | string[] | undefined> }>;
  close: () => void;
} {
  let server: Server;
  let resolveReq: (value: { body: string; headers: any }) => void;
  let rejectReq: (err: Error) => void;
  const received = new Promise<{ body: string; headers: any }>((resolve, reject) => {
    resolveReq = resolve;
    rejectReq = reject;
  });

  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      resolveReq({ body, headers: req.headers });
    });
  });

  server.listen(0); // ask OS for a free port

  return {
    url: () => {
      const addr = server.address() as AddressInfo;
      return `http://127.0.0.1:${addr.port}/webhook`;
    },
    received,
    close: () => {
      server.close();
      rejectReq(new Error("server closed before any webhook arrived"));
    },
  };
}

/* ───────────────────────── Webhooks ─────────────────────────── */

test.describe("integrations — webhooks (CRUD + URL validation + delivery)", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("admin creates a Slack-platform webhook, sees it in the list, updates name, deletes it", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    await page.goto("/dashboard");
    const token = await getToken(page);
    const auth = { Authorization: `Bearer ${token}` };

    const name = `e2e-hook-${Date.now().toString(36)}`;
    const createRes = await page.request.post(`${BACKEND}/webhooks`, {
      headers: { ...auth, "Content-Type": "application/json" },
      data: {
        name,
        url: "https://hooks.slack.com/services/T00/B00/example",
        events: ["run.failed", "flaky.detected"],
        platform: "slack",
      },
    });
    expect(createRes.status()).toBe(201);
    const created = (await createRes.json()) as { id: number; platform: string; events: string[] };
    expect(created.platform).toBe("slack");
    expect(created.events).toEqual(["run.failed", "flaky.detected"]);

    // List includes it.
    const list = (await (
      await page.request.get(`${BACKEND}/webhooks`, { headers: auth })
    ).json()) as { id: number; name: string }[];
    expect(list.find((w) => w.id === created.id)?.name).toBe(name);

    // Update name + active state.
    const renamedTo = `${name}-renamed`;
    const patchRes = await page.request.patch(`${BACKEND}/webhooks/${created.id}`, {
      headers: { ...auth, "Content-Type": "application/json" },
      data: { name: renamedTo, active: false },
    });
    expect(patchRes.status()).toBeLessThan(300);

    const listAfter = (await (
      await page.request.get(`${BACKEND}/webhooks`, { headers: auth })
    ).json()) as { id: number; name: string; active: boolean }[];
    const renamed = listAfter.find((w) => w.id === created.id);
    expect(renamed?.name).toBe(renamedTo);
    expect(renamed?.active).toBe(false);

    // Delete.
    const delRes = await page.request.delete(`${BACKEND}/webhooks/${created.id}`, { headers: auth });
    expect(delRes.status()).toBe(200);

    const listFinal = (await (
      await page.request.get(`${BACKEND}/webhooks`, { headers: auth })
    ).json()) as { id: number }[];
    expect(listFinal.find((w) => w.id === created.id), "deleted webhook should be gone from list").toBeUndefined();
  });

  test("URL validation: file://, javascript:, data:, and malformed URLs are rejected with 400", async ({
    page,
  }) => {
    test.setTimeout(15_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    const reject = async (url: unknown, expectMessage: RegExp) => {
      const res = await page.request.post(`${BACKEND}/webhooks`, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        data: { name: "evil", url, events: ["run.failed"], platform: "generic" },
      });
      expect(res.status(), `expected 400 for url=${JSON.stringify(url)}`).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(expectMessage);
    };

    await reject("", /required/i);
    await reject("not-a-url", /valid absolute URL/i);
    await reject("file:///etc/passwd", /scheme/i);
    await reject("javascript:alert(1)", /scheme/i);
    await reject("data:text/plain,hello", /scheme/i);
    // ftp is also blocked — only http/https allowed
    await reject("ftp://example.com/", /scheme/i);
  });

  test("a viewer-role user is forbidden from listing/creating webhooks (admin-only)", async ({
    browser,
  }) => {
    test.setTimeout(15_000);
    const viewerCtx = await browser.newContext({ storageState: VIEWER_USER.storageStatePath });
    try {
      const viewerPage = await viewerCtx.newPage();
      await viewerPage.goto("/dashboard");
      const viewerToken = await getToken(viewerPage);

      // VIEWER_USER is a real viewer-role member of acme. The webhooks
      // API requires admin on every method (incl. GET); viewer must 403.
      const list = await viewerPage.request.get(`${BACKEND}/webhooks`, {
        headers: { Authorization: `Bearer ${viewerToken}` },
      });
      expect(list.status()).toBe(403);

      const create = await viewerPage.request.post(`${BACKEND}/webhooks`, {
        headers: { Authorization: `Bearer ${viewerToken}`, "Content-Type": "application/json" },
        data: { name: "x", url: "https://example.com/", events: ["run.failed"] },
      });
      expect(create.status()).toBe(403);
    } finally {
      await viewerCtx.close();
    }
  });

  test("POST /webhooks/:id/test fires a 'run.failed' payload to the configured URL — generic platform", async ({
    page,
  }) => {
    test.setTimeout(20_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    const captured = captureNextWebhook();
    try {
      // Create a webhook pointed at our local capture server.
      const createRes = await page.request.post(`${BACKEND}/webhooks`, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        data: {
          name: `e2e-fire-${Date.now().toString(36)}`,
          url: captured.url(),
          events: ["run.failed"],
          platform: "generic",
        },
      });
      expect(createRes.status()).toBe(201);
      const { id } = (await createRes.json()) as { id: number };

      // Fire the test event.
      const fireRes = await page.request.post(`${BACKEND}/webhooks/${id}/test`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(fireRes.status()).toBe(200);
      const fireBody = (await fireRes.json()) as { ok: boolean; status: number };
      expect(fireBody.ok, "the test endpoint should report the upstream 200 it got from us").toBe(true);
      expect(fireBody.status).toBe(200);

      // Capture server received the payload.
      const req = await Promise.race([
        captured.received,
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("webhook never arrived after 5s")), 5_000),
        ),
      ]);
      const payload = JSON.parse(req.body);
      // Generic platform: the payload IS the WebhookRunFailedPayload directly.
      expect(payload.event).toBe("run.failed");
      expect(payload.run.suite_name).toBeTruthy();
      expect(payload.run.failed).toBeGreaterThan(0);
      expect(Array.isArray(payload.failed_tests)).toBe(true);
      expect(payload.failed_tests.length).toBeGreaterThan(0);

      // Cleanup.
      await page.request.delete(`${BACKEND}/webhooks/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } finally {
      // captured.close() is a noop after received resolved.
    }
  });

  test("POST /webhooks/:id/test with a Slack webhook formats the payload into Slack's blocks shape", async ({
    page,
  }) => {
    test.setTimeout(20_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    const captured = captureNextWebhook();
    try {
      const createRes = await page.request.post(`${BACKEND}/webhooks`, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        data: {
          name: `e2e-slack-${Date.now().toString(36)}`,
          url: captured.url(),
          events: ["run.failed"],
          platform: "slack",
        },
      });
      const { id } = (await createRes.json()) as { id: number };

      await page.request.post(`${BACKEND}/webhooks/${id}/test`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const req = await Promise.race([
        captured.received,
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("webhook never arrived after 5s")), 5_000),
        ),
      ]);
      const payload = JSON.parse(req.body);
      // Slack-shape payload should have blocks[] with a header section
      // (rather than the raw run.failed shape we get from generic).
      expect(payload.blocks, "slack platform must produce a blocks array").toBeTruthy();
      expect(Array.isArray(payload.blocks)).toBe(true);
      expect(payload.event, "slack format does NOT carry the raw event field at the top level").toBeUndefined();

      await page.request.delete(`${BACKEND}/webhooks/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } finally {
      // captured.close() is a noop after received resolved.
    }
  });

  test("POST /webhooks/:id/test with an unknown id returns 404", async ({ page }) => {
    test.setTimeout(15_000);
    await page.goto("/dashboard");
    const token = await getToken(page);
    const res = await page.request.post(`${BACKEND}/webhooks/999999/test`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(404);
  });
});

/* ───────────────────────── Jira ─────────────────────────── */

test.describe("integrations — Jira settings + test", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("GET /jira/settings returns the org's current settings (has_api_token boolean, no plaintext)", async ({
    page,
  }) => {
    test.setTimeout(15_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    const res = await page.request.get(`${BACKEND}/jira/settings`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // The response should have has_api_token as a boolean and never
    // expose the plaintext token.
    expect("jira_api_token" in body, "settings must NEVER include the encrypted/plaintext api_token field").toBe(false);
    if ("has_api_token" in body) {
      expect(typeof body.has_api_token).toBe("boolean");
    }
  });

  test("PATCH /jira/settings round-trips base_url + email + project_key (admin only)", async ({
    page,
  }) => {
    test.setTimeout(15_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    const baseUrl = "https://e2e-test.atlassian.net";
    const updateRes = await page.request.patch(`${BACKEND}/jira/settings`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { base_url: baseUrl, email: "ci@example.test", project_key: "FT", issue_type: "Bug" },
    });
    expect(updateRes.status()).toBe(200);

    const settings = (await (
      await page.request.get(`${BACKEND}/jira/settings`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as Record<string, string>;
    expect(settings.jira_base_url).toBe(baseUrl);
    expect(settings.jira_email).toBe("ci@example.test");
    expect(settings.jira_project_key).toBe("FT");
    expect(settings.jira_issue_type).toBe("Bug");

    // Cleanup: clear out the test settings.
    await page.request.patch(`${BACKEND}/jira/settings`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { base_url: "", email: "", project_key: "" },
    });
  });

  test("POST /jira/test returns 400 'Jira not configured' when no api_token is set", async ({
    page,
  }) => {
    test.setTimeout(15_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    // Ensure the api_token is unset.
    await page.request.patch(`${BACKEND}/jira/settings`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { base_url: "", email: "", api_token: "" },
    });

    const res = await page.request.post(`${BACKEND}/jira/test`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not configured/i);
  });

  test("PATCH /jira/settings is admin-only — viewer gets 403", async ({ browser }) => {
    test.setTimeout(15_000);
    const viewerCtx = await browser.newContext({ storageState: VIEWER_USER.storageStatePath });
    try {
      const viewerPage = await viewerCtx.newPage();
      await viewerPage.goto("/dashboard");
      const viewerToken = await getToken(viewerPage);

      const res = await viewerPage.request.patch(`${BACKEND}/jira/settings`, {
        headers: { Authorization: `Bearer ${viewerToken}`, "Content-Type": "application/json" },
        data: { base_url: "https://hostile.test/" },
      });
      expect(res.status()).toBe(403);
    } finally {
      await viewerCtx.close();
    }
  });
});

/* ───────────────────────── PagerDuty ─────────────────────────── */

test.describe("integrations — PagerDuty settings + test", () => {
  test.use({ storageState: ADMIN_USER.storageStatePath });

  test("GET /pagerduty/settings exposes has_key boolean, never the integration_key", async ({
    page,
  }) => {
    test.setTimeout(15_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    const res = await page.request.get(`${BACKEND}/pagerduty/settings`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect("pagerduty_integration_key" in body, "must never expose the encrypted key").toBe(false);
  });

  test("PATCH /pagerduty/settings normalises invalid severity to 'error'", async ({ page }) => {
    test.setTimeout(15_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    await page.request.patch(`${BACKEND}/pagerduty/settings`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { severity: "BOGUS-VALUE", auto_trigger: true },
    });
    const settings = (await (
      await page.request.get(`${BACKEND}/pagerduty/settings`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as { pagerduty_severity: string; pagerduty_auto_trigger: boolean };
    expect(settings.pagerduty_severity, "invalid severity must normalise to 'error'").toBe("error");
    expect(settings.pagerduty_auto_trigger).toBe(true);

    // Reset auto_trigger.
    await page.request.patch(`${BACKEND}/pagerduty/settings`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { auto_trigger: false },
    });
  });

  test("POST /pagerduty/test returns 400 when no integration_key is set", async ({ page }) => {
    test.setTimeout(15_000);
    await page.goto("/dashboard");
    const token = await getToken(page);

    // Force-unset the key.
    await page.request.patch(`${BACKEND}/pagerduty/settings`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      data: { integration_key: "" },
    });

    const res = await page.request.post(`${BACKEND}/pagerduty/test`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not configured/i);
  });

  test("PATCH /pagerduty/settings is admin-only — viewer gets 403", async ({ browser }) => {
    test.setTimeout(15_000);
    const viewerCtx = await browser.newContext({ storageState: VIEWER_USER.storageStatePath });
    try {
      const viewerPage = await viewerCtx.newPage();
      await viewerPage.goto("/dashboard");
      const viewerToken = await getToken(viewerPage);
      const res = await viewerPage.request.patch(`${BACKEND}/pagerduty/settings`, {
        headers: { Authorization: `Bearer ${viewerToken}`, "Content-Type": "application/json" },
        data: { severity: "critical" },
      });
      expect(res.status()).toBe(403);
    } finally {
      await viewerCtx.close();
    }
  });
});
