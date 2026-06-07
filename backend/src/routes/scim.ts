import express, { Router, type Request, type Response, type NextFunction } from "express";
import {
  authenticateScim,
  createScimUser, getScimUser, listScimUsers, replaceScimUser, patchScimUser, deleteScimUser,
  createScimGroup, getScimGroup, listScimGroups, upsertScimGroup, deleteScimGroup,
  type ScimError,
} from "../sso/scim.js";
import { SSO_ENABLED } from "./sso.js";

// SCIM 2.0 provisioning endpoint (RFC 7643/7644). Mounted at /scim/v2, gated by
// the same FLAKEY_SSO_ENABLED flag, and authenticated by a per-org bearer token
// (NOT a user session). Validated against infra/scim-target/server.mjs.
//
// Multi-tenancy: scimAuth resolves the org from the token and pins req.scimOrgId.
// Every data call routes through tenantQuery(req.scimOrgId, ...) so RLS isolates
// one org's SCIM resources from another's, even though there's no user session.

const SCIM_JSON = "application/scim+json";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { scimOrgId?: number } }
}

const router = Router();

// Parse JSON AND application/scim+json bodies (SCIM clients send the latter).
router.use(express.json({ type: ["application/json", "application/scim+json"], limit: "1mb" }));

function scimJson(res: Response, status: number, body?: unknown): void {
  res.status(status).type(SCIM_JSON);
  res.send(body === undefined ? "" : JSON.stringify(body));
}
function scimErrorBody(status: number, detail: string, scimType?: string) {
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  };
}

// Bearer-token auth. Fail closed: no flag → 404; bad/missing token → 401.
async function scimAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!SSO_ENABLED) {
    scimJson(res, 404, scimErrorBody(404, "SCIM is not enabled on this instance"));
    return;
  }
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) {
    scimJson(res, 401, scimErrorBody(401, "Bearer token required"));
    return;
  }
  let orgId: number | null = null;
  try {
    orgId = await authenticateScim(header.slice(7));
  } catch (err) {
    console.error("SCIM auth error:", err);
    scimJson(res, 500, scimErrorBody(500, "Internal server error"));
    return;
  }
  if (orgId === null) {
    scimJson(res, 401, scimErrorBody(401, "Invalid SCIM token"));
    return;
  }
  req.scimOrgId = orgId;
  next();
}
router.use(scimAuth);

// Trivial SCIM filter parser: `attr eq "value"` (the existence checks IdPs do).
function parseEq(filter: unknown): { attr: string; value: string } | null {
  if (typeof filter !== "string") return null;
  const m = /(\w+)\s+eq\s+"([^"]*)"/i.exec(filter);
  return m ? { attr: m[1], value: m[2] } : null;
}

function meta(type: string, id: string) {
  return { resourceType: type, location: `/scim/v2/${type}s/${id}` };
}
function listResponse(resources: unknown[]) {
  return {
    schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
    totalResults: resources.length,
    itemsPerPage: resources.length,
    startIndex: 1,
    Resources: resources,
  };
}

// ── Discovery ────────────────────────────────────────────────────────────────
router.get("/ServiceProviderConfig", (_req, res) => {
  scimJson(res, 200, {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    documentationUri: "https://flakey.io/docs/scim",
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: "oauthbearertoken", name: "OAuth Bearer Token", description: "Bearer token" }],
    meta: { resourceType: "ServiceProviderConfig", location: "/scim/v2/ServiceProviderConfig" },
  });
});
router.get("/ResourceTypes", (_req, res) => {
  scimJson(res, 200, listResponse([
    { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "User", name: "User",
      endpoint: "/Users", schema: "urn:ietf:params:scim:schemas:core:2.0:User", meta: meta("ResourceType", "User") },
    { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "Group", name: "Group",
      endpoint: "/Groups", schema: "urn:ietf:params:scim:schemas:core:2.0:Group", meta: meta("ResourceType", "Group") },
  ]));
});
router.get("/Schemas", (_req, res) => scimJson(res, 200, listResponse([])));

// Wrap an async handler so a thrown ScimError becomes the right SCIM response.
function h(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      const e = err as ScimError;
      if (e && typeof e.status === "number") {
        scimJson(res, e.status, scimErrorBody(e.status, e.message, e.scimType));
      } else {
        console.error("SCIM handler error:", err);
        scimJson(res, 500, scimErrorBody(500, "Internal server error"));
      }
    }
  };
}

// ── Users ────────────────────────────────────────────────────────────────────
router.get("/Users", h(async (req, res) => {
  scimJson(res, 200, listResponse(await listScimUsers(req.scimOrgId!, parseEq(req.query.filter))));
}));
router.get("/Users/:id", h(async (req, res) => {
  const u = await getScimUser(req.scimOrgId!, String(req.params.id));
  u ? scimJson(res, 200, u) : scimJson(res, 404, scimErrorBody(404, "User not found"));
}));
router.post("/Users", h(async (req, res) => {
  scimJson(res, 201, await createScimUser(req.scimOrgId!, req.body ?? {}));
}));
router.put("/Users/:id", h(async (req, res) => {
  const u = await replaceScimUser(req.scimOrgId!, String(req.params.id), req.body ?? {});
  u ? scimJson(res, 200, u) : scimJson(res, 404, scimErrorBody(404, "User not found"));
}));
router.patch("/Users/:id", h(async (req, res) => {
  const u = await patchScimUser(req.scimOrgId!, String(req.params.id), req.body ?? {});
  u ? scimJson(res, 200, u) : scimJson(res, 404, scimErrorBody(404, "User not found"));
}));
router.delete("/Users/:id", h(async (req, res) => {
  const ok = await deleteScimUser(req.scimOrgId!, String(req.params.id));
  ok ? scimJson(res, 204) : scimJson(res, 404, scimErrorBody(404, "User not found"));
}));

// ── Groups ───────────────────────────────────────────────────────────────────
router.get("/Groups", h(async (req, res) => {
  scimJson(res, 200, listResponse(await listScimGroups(req.scimOrgId!, parseEq(req.query.filter))));
}));
router.get("/Groups/:id", h(async (req, res) => {
  const g = await getScimGroup(req.scimOrgId!, String(req.params.id));
  g ? scimJson(res, 200, g) : scimJson(res, 404, scimErrorBody(404, "Group not found"));
}));
router.post("/Groups", h(async (req, res) => {
  scimJson(res, 201, await createScimGroup(req.scimOrgId!, req.body ?? {}));
}));
router.put("/Groups/:id", h(async (req, res) => {
  const g = await upsertScimGroup(req.scimOrgId!, String(req.params.id), req.body ?? {}, false);
  g ? scimJson(res, 200, g) : scimJson(res, 404, scimErrorBody(404, "Group not found"));
}));
router.patch("/Groups/:id", h(async (req, res) => {
  const g = await upsertScimGroup(req.scimOrgId!, String(req.params.id), req.body ?? {}, true);
  g ? scimJson(res, 200, g) : scimJson(res, 404, scimErrorBody(404, "Group not found"));
}));
router.delete("/Groups/:id", h(async (req, res) => {
  const ok = await deleteScimGroup(req.scimOrgId!, String(req.params.id));
  ok ? scimJson(res, 204) : scimJson(res, 404, scimErrorBody(404, "Group not found"));
}));

export default router;
