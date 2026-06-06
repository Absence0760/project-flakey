/**
 * Mock SCIM 2.0 target (Phase 14 SSO prototyping).
 *
 * Stands in for Flakey's future `/scim/v2` endpoint so we can e2e-test outbound
 * SCIM provisioning from a real IdP (Authentik) with no online signup. It
 * implements just enough of RFC 7643/7644 for Authentik's SCIM client to
 * discover, create, look up, update, and deactivate Users + Groups — and
 * records everything it receives at `GET /_captured` so a host test can assert
 * the provisioning loop actually fired.
 *
 * This file is ALSO the working contract for the real endpoint: when Flakey
 * builds SCIM (proposal slice 3), `/scim/v2/Users` + `/scim/v2/Groups` must
 * satisfy the same client behavior exercised here.
 *
 * Zero dependencies (pure node:http) so it runs in a stock `node` image with a
 * single mounted file — no npm install, no lockfile. Dev-only; never prod.
 *
 *   PORT        listen port (default 8082)
 *   SCIM_TOKEN  required bearer token (default "flakey-scim-dev-token")
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8082);
const TOKEN = process.env.SCIM_TOKEN ?? "flakey-scim-dev-token";

/** In-memory stores, keyed by SCIM id. */
const users = new Map();
const groups = new Map();
/** Audit of every mutating request, for the test to assert against. */
const log = [];

const SCIM_JSON = "application/scim+json";

function send(res, status, body) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": SCIM_JSON });
  res.end(payload);
}

function listResponse(resources) {
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: resources.length,
    itemsPerPage: resources.length,
    startIndex: 1,
    Resources: resources,
  };
}

function meta(type, id) {
  return { resourceType: type, location: `/scim/v2/${type}s/${id}` };
}

// Parse a trivial SCIM filter: `attr eq "value"`. Enough for the existence
// checks Authentik does before create (userName/externalId/displayName eq …).
function parseEq(filter) {
  if (!filter) return null;
  const m = /(\w+)\s+eq\s+"([^"]*)"/i.exec(filter);
  return m ? { attr: m[1], value: m[2] } : null;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
  });
}

const SERVICE_PROVIDER_CONFIG = {
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
  documentationUri: "https://flakey.io/docs/scim",
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: 200 },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [
    { type: "oauthbearertoken", name: "OAuth Bearer Token", description: "Bearer token" },
  ],
  meta: { resourceType: "ServiceProviderConfig", location: "/scim/v2/ServiceProviderConfig" },
};

const RESOURCE_TYPES = [
  { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "User", name: "User",
    endpoint: "/Users", schema: "urn:ietf:params:scim:schemas:core:2.0:User", meta: meta("ResourceType", "User") },
  { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "Group", name: "Group",
    endpoint: "/Groups", schema: "urn:ietf:params:scim:schemas:core:2.0:Group", meta: meta("ResourceType", "Group") },
];

function handleCollection(store, type, method, id, query, body, res) {
  // Existence lookups: GET /Users?filter=userName eq "x"
  if (method === "GET" && !id) {
    const eq = parseEq(query.get("filter"));
    const all = [...store.values()];
    const matched = eq ? all.filter((r) => JSON.stringify(r[eq.attr] ?? "") === JSON.stringify(eq.value)
      || r.userName === eq.value || r.displayName === eq.value || r.externalId === eq.value) : all;
    return send(res, 200, listResponse(matched));
  }
  if (method === "GET" && id) {
    const r = store.get(id);
    return r ? send(res, 200, r) : send(res, 404, { detail: "Not found", status: "404" });
  }
  if (method === "POST" && !id) {
    const newId = randomUUID();
    const resource = { ...body, id: newId, meta: meta(type, newId) };
    store.set(newId, resource);
    log.push({ op: "create", type, id: newId, userName: body.userName, displayName: body.displayName });
    return send(res, 201, resource);
  }
  if ((method === "PUT" || method === "PATCH") && id) {
    const existing = store.get(id);
    if (!existing) return send(res, 404, { detail: "Not found", status: "404" });
    // PATCH carries Operations; PUT carries a full resource. For a mock we just
    // merge the body (and apply `active` from a PATCH replace) and record it.
    let updated = { ...existing };
    if (method === "PUT") updated = { ...body, id, meta: existing.meta };
    else {
      for (const op of body.Operations ?? []) {
        if ((op.op ?? "").toLowerCase() === "replace" && op.path === "active") updated.active = op.value;
        else if ((op.op ?? "").toLowerCase() === "replace" && !op.path && typeof op.value === "object") updated = { ...updated, ...op.value };
      }
    }
    store.set(id, updated);
    log.push({ op: method.toLowerCase(), type, id, active: updated.active });
    return send(res, 200, updated);
  }
  if (method === "DELETE" && id) {
    store.delete(id);
    log.push({ op: "delete", type, id });
    return send(res, 204);
  }
  return send(res, 405, { detail: "Method not allowed", status: "405" });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // Capture/reset endpoints for the host test — no auth (local-only fixture).
  if (path === "/_captured" && req.method === "GET") {
    return send(res, 200, { users: [...users.values()], groups: [...groups.values()], log });
  }
  if (path === "/_reset" && req.method === "POST") {
    users.clear(); groups.clear(); log.length = 0;
    return send(res, 200, { ok: true });
  }
  if (path === "/health") return send(res, 200, { ok: true });

  // Everything under /scim/v2 requires the bearer token.
  if (path.startsWith("/scim/v2")) {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${TOKEN}`) return send(res, 401, { detail: "Unauthorized", status: "401" });

    if (path === "/scim/v2/ServiceProviderConfig") return send(res, 200, SERVICE_PROVIDER_CONFIG);
    if (path === "/scim/v2/ResourceTypes") return send(res, 200, listResponse(RESOURCE_TYPES));
    if (path === "/scim/v2/Schemas") return send(res, 200, listResponse([]));

    const userMatch = /^\/scim\/v2\/Users(?:\/(.+))?$/.exec(path);
    if (userMatch) return handleCollection(users, "User", req.method, userMatch[1], url.searchParams, await readBody(req), res);

    const groupMatch = /^\/scim\/v2\/Groups(?:\/(.+))?$/.exec(path);
    if (groupMatch) return handleCollection(groups, "Group", req.method, groupMatch[1], url.searchParams, await readBody(req), res);

    return send(res, 404, { detail: "Unknown SCIM resource", status: "404" });
  }

  return send(res, 404, { detail: "Not found", status: "404" });
});

server.listen(PORT, () => {
  console.log(`[scim-target] listening on :${PORT} (token: ${TOKEN.slice(0, 6)}…)`);
});
