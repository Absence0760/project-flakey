// SCIM 2.0 provisioning core (RFC 7643/7644) — the data logic behind the
// /scim/v2 routes. Validated against the committed mock target
// (infra/scim-target/server.mjs), which is the working client contract.
//
// Deactivation containment (proposal trust boundary #5): setting a user
// inactive (or DELETE) removes the org_members row. requireAuth re-reads
// org_members every request, so access ends on the user's NEXT call — we reuse
// the existing instant-revocation guarantee rather than inventing one.

import bcrypt from "bcryptjs";
import crypto from "crypto";
import pool, { tenantQuery } from "../db.js";
import { normalizeEmail } from "../auth.js";
import { logAudit } from "../audit.js";
import { loadSsoConfig, type OrgRole } from "./config.js";

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";

export interface ScimError extends Error { status: number; scimType?: string }
export function scimError(status: number, detail: string, scimType?: string): ScimError {
  const e = new Error(detail) as ScimError;
  e.status = status;
  e.scimType = scimType;
  return e;
}

// ── Token ──────────────────────────────────────────────────────────────────
const TOKEN_PREFIX_LEN = 14; // "fkscim_" (7) + 7 hex

/** Issue a new SCIM bearer token for an org, enabling SCIM. Returns the raw
 *  token ONCE (only its bcrypt hash + prefix are stored). */
export async function issueScimToken(orgId: number): Promise<{ token: string; prefix: string }> {
  const token = `fkscim_${crypto.randomBytes(24).toString("hex")}`;
  const prefix = token.slice(0, TOKEN_PREFIX_LEN);
  const hash = bcrypt.hashSync(token, 12);
  // Upsert: an org may enable SCIM before configuring OIDC/SAML login, so there
  // may be no org_sso_configs row yet. enabled defaults false, so the
  // OIDC/SAML completeness CHECKs are satisfied for a SCIM-only row.
  await tenantQuery(
    orgId,
    `INSERT INTO org_sso_configs (org_id, scim_enabled, scim_token_prefix, scim_token_hash)
       VALUES ($1, true, $2, $3)
     ON CONFLICT (org_id) DO UPDATE SET
       scim_enabled = true, scim_token_prefix = EXCLUDED.scim_token_prefix,
       scim_token_hash = EXCLUDED.scim_token_hash, updated_at = NOW()`,
    [orgId, prefix, hash],
  );
  await logAudit(orgId, null, "auth.sso.scim.token.issue", "org", String(orgId), { prefix });
  return { token, prefix };
}

export async function disableScim(orgId: number): Promise<void> {
  await tenantQuery(
    orgId,
    "UPDATE org_sso_configs SET scim_enabled = false, scim_token_prefix = NULL, scim_token_hash = NULL, updated_at = NOW() WHERE org_id = $1",
    [orgId],
  );
  await logAudit(orgId, null, "auth.sso.scim.disable", "org", String(orgId));
}

/** Resolve a SCIM bearer token to its org id, or null. Runs before RLS scope
 *  is set, via the SECURITY DEFINER prefix lookup; full token bcrypt-compared. */
export async function authenticateScim(token: string): Promise<number | null> {
  if (!token || !token.startsWith("fkscim_")) return null;
  const prefix = token.slice(0, TOKEN_PREFIX_LEN);
  const rows = await pool.query("SELECT org_id, token_hash FROM lookup_scim_token($1)", [prefix]);
  const row = rows.rows[0];
  if (!row || !row.token_hash) return null;
  return bcrypt.compareSync(token, row.token_hash) ? row.org_id : null;
}

// ── Users ────────────────────────────────────────────────────────────────────
interface ScimUserRow {
  scim_id: string; org_id: number; user_id: number; user_name: string;
  external_id: string | null; active: boolean; raw: Record<string, unknown>;
}

function userResource(row: ScimUserRow): Record<string, unknown> {
  return {
    schemas: [USER_SCHEMA],
    id: row.scim_id,
    userName: row.user_name,
    externalId: row.external_id ?? undefined,
    name: (row.raw?.name as object) ?? undefined,
    displayName: (row.raw?.displayName as string) ?? undefined,
    emails: (row.raw?.emails as object) ?? [{ value: row.user_name, primary: true }],
    active: row.active,
    meta: { resourceType: "User", location: `/scim/v2/Users/${row.scim_id}` },
  };
}

function extractEmail(body: Record<string, any>): string {
  const fromEmails = Array.isArray(body.emails)
    ? (body.emails.find((e: any) => e?.primary)?.value ?? body.emails[0]?.value)
    : undefined;
  return normalizeEmail(fromEmails ?? body.userName ?? "");
}
function extractName(body: Record<string, any>, email: string): string {
  if (typeof body.displayName === "string" && body.displayName) return body.displayName;
  const n = body.name;
  if (n?.formatted) return n.formatted;
  if (n?.givenName || n?.familyName) return [n.givenName, n.familyName].filter(Boolean).join(" ");
  return email.split("@")[0];
}
function coerceActive(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.toLowerCase() === "true";
  return true;
}

/** Add or remove the user's org membership to match `active`. */
async function syncMembership(orgId: number, userId: number, active: boolean, role: OrgRole): Promise<void> {
  if (active) {
    await pool.query(
      "INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (org_id, user_id) DO NOTHING",
      [orgId, userId, role],
    );
  } else {
    // Remove membership → requireAuth 401s the user's ACCESS token on their next
    // request. ALSO stamp the session-revocation watermark so their still-valid
    // REFRESH token can't outlive deactivation by minting a fresh (personal-org)
    // session via /auth/refresh -> resolveOrg (security review finding #1).
    await pool.query("DELETE FROM org_members WHERE org_id = $1 AND user_id = $2", [orgId, userId]);
    await pool.query("UPDATE users SET sessions_revoked_at = NOW() WHERE id = $1", [userId]);
  }
}

export async function createScimUser(orgId: number, body: Record<string, any>): Promise<Record<string, unknown>> {
  const email = extractEmail(body);
  if (!email) throw scimError(400, "userName/email is required", "invalidValue");
  const active = coerceActive(body.active ?? true);
  const name = extractName(body, email);
  const config = await loadSsoConfig(orgId, false);
  const role: OrgRole = config?.defaultRole ?? "viewer";

  // Duplicate guard — RFC 7644 §3.3 returns 409 on uniqueness conflict.
  const dup = await tenantQuery(orgId, "SELECT scim_id FROM scim_users WHERE org_id = $1 AND user_name = $2", [orgId, email]);
  if (dup.rows.length > 0) throw scimError(409, "User already exists", "uniqueness");

  // Find or create the Flakey user.
  const existing = await pool.query("SELECT id FROM users WHERE LOWER(email) = $1", [email]);
  let userId: number;
  if (existing.rows.length > 0) {
    userId = existing.rows[0].id;
  } else {
    const pw = bcrypt.hashSync(crypto.randomBytes(32).toString("hex"), 12);
    const created = await pool.query(
      "INSERT INTO users (email, password_hash, name, email_verified) VALUES ($1, $2, $3, true) RETURNING id",
      [email, pw, name],
    );
    userId = created.rows[0].id;
  }

  const scimId = crypto.randomUUID();
  await tenantQuery(
    orgId,
    `INSERT INTO scim_users (scim_id, org_id, user_id, user_name, external_id, active, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [scimId, orgId, userId, email, body.externalId ?? null, active, JSON.stringify(body)],
  );
  await tenantQuery(
    orgId,
    `INSERT INTO sso_identities (org_id, user_id, protocol, external_id, last_login_at)
     VALUES ($1, $2, 'scim', $3, NULL) ON CONFLICT (org_id, protocol, external_id) DO NOTHING`,
    [orgId, userId, email],
  );
  await syncMembership(orgId, userId, active, role);
  await logAudit(orgId, userId, "auth.sso.scim.user.create", "user", String(userId), { email, active });

  const row = (await tenantQuery(orgId, "SELECT * FROM scim_users WHERE scim_id = $1", [scimId])).rows[0];
  return userResource(row as ScimUserRow);
}

export async function getScimUser(orgId: number, scimId: string): Promise<Record<string, unknown> | null> {
  const r = await tenantQuery(orgId, "SELECT * FROM scim_users WHERE scim_id = $1", [scimId]);
  return r.rows[0] ? userResource(r.rows[0] as ScimUserRow) : null;
}

export async function listScimUsers(orgId: number, filterEq: { attr: string; value: string } | null): Promise<Record<string, unknown>[]> {
  let rows: ScimUserRow[];
  if (filterEq && (filterEq.attr === "userName" || filterEq.attr === "externalId")) {
    const col = filterEq.attr === "userName" ? "user_name" : "external_id";
    const r = await tenantQuery(orgId, `SELECT * FROM scim_users WHERE org_id = $1 AND ${col} = $2`, [orgId, filterEq.value]);
    rows = r.rows as ScimUserRow[];
  } else {
    const r = await tenantQuery(orgId, "SELECT * FROM scim_users WHERE org_id = $1 ORDER BY created_at", [orgId]);
    rows = r.rows as ScimUserRow[];
  }
  return rows.map(userResource);
}

async function applyUserActive(orgId: number, row: ScimUserRow, active: boolean): Promise<void> {
  const config = await loadSsoConfig(orgId, false);
  const role: OrgRole = config?.defaultRole ?? "viewer";
  await tenantQuery(orgId, "UPDATE scim_users SET active = $1, updated_at = NOW() WHERE scim_id = $2", [active, row.scim_id]);
  await syncMembership(orgId, row.user_id, active, role);
  await logAudit(orgId, row.user_id, active ? "auth.sso.scim.user.activate" : "auth.sso.scim.user.deactivate", "user", String(row.user_id), { email: row.user_name });
}

export async function replaceScimUser(orgId: number, scimId: string, body: Record<string, any>): Promise<Record<string, unknown> | null> {
  const r = await tenantQuery(orgId, "SELECT * FROM scim_users WHERE scim_id = $1", [scimId]);
  const row = r.rows[0] as ScimUserRow | undefined;
  if (!row) return null;
  const active = coerceActive(body.active ?? row.active);
  await tenantQuery(orgId, "UPDATE scim_users SET raw = $1, external_id = $2, updated_at = NOW() WHERE scim_id = $3",
    [JSON.stringify(body), body.externalId ?? row.external_id, scimId]);
  await applyUserActive(orgId, row, active);
  return getScimUser(orgId, scimId);
}

export async function patchScimUser(orgId: number, scimId: string, body: Record<string, any>): Promise<Record<string, unknown> | null> {
  const r = await tenantQuery(orgId, "SELECT * FROM scim_users WHERE scim_id = $1", [scimId]);
  const row = r.rows[0] as ScimUserRow | undefined;
  if (!row) return null;
  let active = row.active;
  for (const op of body.Operations ?? []) {
    const verb = (op.op ?? "").toLowerCase();
    if (verb !== "replace" && verb !== "add") continue;
    if (typeof op.path === "string" && op.path.toLowerCase() === "active") active = coerceActive(op.value);
    else if (!op.path && op.value && typeof op.value === "object" && "active" in op.value) active = coerceActive(op.value.active);
  }
  await applyUserActive(orgId, row, active);
  return getScimUser(orgId, scimId);
}

export async function deleteScimUser(orgId: number, scimId: string): Promise<boolean> {
  const r = await tenantQuery(orgId, "SELECT * FROM scim_users WHERE scim_id = $1", [scimId]);
  const row = r.rows[0] as ScimUserRow | undefined;
  if (!row) return false;
  // Full deprovision from THIS org: drop membership + the SCIM identity + the
  // SCIM resource. The global users row is left (may belong to other orgs).
  await syncMembership(orgId, row.user_id, false, "viewer");
  await tenantQuery(orgId, "DELETE FROM sso_identities WHERE org_id = $1 AND protocol = 'scim' AND external_id = $2", [orgId, row.user_name]);
  await tenantQuery(orgId, "DELETE FROM scim_users WHERE scim_id = $1", [scimId]);
  await logAudit(orgId, row.user_id, "auth.sso.scim.user.delete", "user", String(row.user_id), { email: row.user_name });
  return true;
}

// ── Groups ───────────────────────────────────────────────────────────────────
// Groups carry role intent: a group whose displayName maps via role_map to a
// Flakey role sets that role on its members. (Scoped to admin-configured
// role_map values, same containment as the login role claim.)
interface ScimGroupRow { scim_id: string; org_id: number; display_name: string; raw: Record<string, unknown> }

function groupResource(row: ScimGroupRow): Record<string, unknown> {
  return {
    schemas: [GROUP_SCHEMA],
    id: row.scim_id,
    displayName: row.display_name,
    members: (row.raw?.members as object) ?? [],
    meta: { resourceType: "Group", location: `/scim/v2/Groups/${row.scim_id}` },
  };
}

async function applyGroupRole(orgId: number, displayName: string, members: any[]): Promise<void> {
  const config = await loadSsoConfig(orgId, false);
  const role = config?.roleMap?.[displayName] as OrgRole | undefined;
  if (!role) return; // group not mapped to a role → no-op (cannot widen access)
  for (const m of members ?? []) {
    const memberScimId = typeof m === "string" ? m : m?.value;
    if (!memberScimId) continue;
    const u = await tenantQuery(orgId, "SELECT user_id FROM scim_users WHERE scim_id = $1", [memberScimId]);
    const uid = u.rows[0]?.user_id;
    if (uid) await pool.query("UPDATE org_members SET role = $1 WHERE org_id = $2 AND user_id = $3", [role, orgId, uid]);
  }
}

export async function createScimGroup(orgId: number, body: Record<string, any>): Promise<Record<string, unknown>> {
  const displayName = body.displayName;
  if (!displayName) throw scimError(400, "displayName is required", "invalidValue");
  const dup = await tenantQuery(orgId, "SELECT scim_id FROM scim_groups WHERE org_id = $1 AND display_name = $2", [orgId, displayName]);
  if (dup.rows.length > 0) throw scimError(409, "Group already exists", "uniqueness");
  const scimId = crypto.randomUUID();
  await tenantQuery(orgId, "INSERT INTO scim_groups (scim_id, org_id, display_name, raw) VALUES ($1, $2, $3, $4)",
    [scimId, orgId, displayName, JSON.stringify(body)]);
  await applyGroupRole(orgId, displayName, body.members ?? []);
  await logAudit(orgId, null, "auth.sso.scim.group.create", "group", scimId, { displayName });
  const row = (await tenantQuery(orgId, "SELECT * FROM scim_groups WHERE scim_id = $1", [scimId])).rows[0];
  return groupResource(row as ScimGroupRow);
}

export async function getScimGroup(orgId: number, scimId: string): Promise<Record<string, unknown> | null> {
  const r = await tenantQuery(orgId, "SELECT * FROM scim_groups WHERE scim_id = $1", [scimId]);
  return r.rows[0] ? groupResource(r.rows[0] as ScimGroupRow) : null;
}

export async function listScimGroups(orgId: number, filterEq: { attr: string; value: string } | null): Promise<Record<string, unknown>[]> {
  let rows: ScimGroupRow[];
  if (filterEq && filterEq.attr === "displayName") {
    const r = await tenantQuery(orgId, "SELECT * FROM scim_groups WHERE org_id = $1 AND display_name = $2", [orgId, filterEq.value]);
    rows = r.rows as ScimGroupRow[];
  } else {
    const r = await tenantQuery(orgId, "SELECT * FROM scim_groups WHERE org_id = $1 ORDER BY created_at", [orgId]);
    rows = r.rows as ScimGroupRow[];
  }
  return rows.map(groupResource);
}

export async function upsertScimGroup(orgId: number, scimId: string, body: Record<string, any>, isPatch: boolean): Promise<Record<string, unknown> | null> {
  const r = await tenantQuery(orgId, "SELECT * FROM scim_groups WHERE scim_id = $1", [scimId]);
  const row = r.rows[0] as ScimGroupRow | undefined;
  if (!row) return null;
  let members: any[] = (row.raw?.members as any[]) ?? [];
  if (isPatch) {
    for (const op of body.Operations ?? []) {
      if (op.path === "members" && (op.op ?? "").toLowerCase() === "add") members = members.concat(op.value ?? []);
      else if (op.path === "members" && (op.op ?? "").toLowerCase() === "replace") members = op.value ?? [];
    }
  } else {
    members = body.members ?? [];
  }
  const merged = { ...row.raw, ...(isPatch ? {} : body), members };
  await tenantQuery(orgId, "UPDATE scim_groups SET raw = $1, updated_at = NOW() WHERE scim_id = $2", [JSON.stringify(merged), scimId]);
  await applyGroupRole(orgId, row.display_name, members);
  // Audit: a group update can change member roles (displayName mapped via
  // role_map) — that's a privilege change and must be logged (security review
  // finding #2 / SOC 2 CC6.1). memberCount lets a reviewer scope the blast.
  await logAudit(orgId, null, "auth.sso.scim.group.update", "group", scimId, {
    displayName: row.display_name,
    memberCount: Array.isArray(members) ? members.length : 0,
  });
  return getScimGroup(orgId, scimId);
}

export async function deleteScimGroup(orgId: number, scimId: string): Promise<boolean> {
  const r = await tenantQuery(orgId, "DELETE FROM scim_groups WHERE scim_id = $1 RETURNING display_name", [scimId]);
  if (r.rows.length === 0) return false;
  await logAudit(orgId, null, "auth.sso.scim.group.delete", "group", scimId, { displayName: r.rows[0].display_name });
  return true;
}
