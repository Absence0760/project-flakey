/**
 * SSRF hardening for outbound audit-export HTTP delivery.
 *
 *  1. redirect:"manual" — a 3xx from the (validated) endpoint is NOT followed,
 *     so it can't bounce the request + auth header to a private/metadata target
 *     after the SSRF gate.
 *  2. connect-time IP pin (webhookSafeFetch) — refuses a connection whose
 *     resolved address is private/reserved, per the WEBHOOK_ALLOW_PRIVATE_TARGETS
 *     policy. (validateWebhookUrl alone only checks the hostname string.)
 *
 * No DB: drives testDelivery (synthetic probe) and webhookSafeFetch directly.
 * The private-target policy is read per connect, so we toggle it per test.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { testDelivery, type AuditExportConfigRow } from "../audit-export.js";
import { webhookSafeFetch } from "../routes/webhooks.js";

let server: http.Server;
let port = 0;
const hits: Record<string, number> = {};

before(async () => {
  server = http.createServer((req, res) => {
    const path = (req.url || "/").split("?")[0];
    hits[path] = (hits[path] ?? 0) + 1;
    if (path === "/redirecting") {
      res.writeHead(302, { Location: `http://127.0.0.1:${port}/redirect-target` });
      res.end();
      return;
    }
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function httpConfig(path: string): AuditExportConfigRow {
  return {
    id: 1, org_id: 1, destination: "http", enabled: true,
    endpoint_url: `http://127.0.0.1:${port}${path}`,
    auth_header_name: "Authorization", auth_token_encrypted: "Bearer t",
    s3_bucket: null, s3_prefix: null, last_exported_id: "0",
  };
}

test("a 3xx redirect is refused, not followed (no replay to the redirect target)", async () => {
  process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = "true"; // allow the 127.0.0.1 endpoint itself
  hits["/redirecting"] = 0;
  hits["/redirect-target"] = 0;

  const result = await testDelivery(httpConfig("/redirecting"));

  assert.equal(result.ok, false, "a redirect must be treated as a failed delivery");
  assert.equal(hits["/redirecting"], 1, "the endpoint was hit once");
  assert.equal(hits["/redirect-target"], 0, "the redirect target must NOT be requested");
});

test("webhookSafeFetch refuses a HOSTNAME that resolves to a private address when the policy blocks", async () => {
  // Use a hostname (not an IP literal): undici only invokes the custom lookup —
  // where the connect-time pin lives — for hostnames. 'localhost' resolves to a
  // loopback IP, which isPrivateOrReservedHost flags. This is the same path a
  // public hostname with an A record pointing at 169.254.169.254 would take.
  // (IP literals are caught earlier by validateWebhookUrl's string check.)
  process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = "false"; // force the block
  await assert.rejects(
    webhookSafeFetch(`http://localhost:${port}/`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    }),
    "connecting to a host that resolves to a private/reserved address must be refused"
  );
});

test("webhookSafeFetch connects normally when the policy permits the target", async () => {
  process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = "true";
  const res = await webhookSafeFetch(`http://127.0.0.1:${port}/`, {
    method: "GET",
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(res.status, 200, "a permitted target connects normally through the pinning agent");
});
