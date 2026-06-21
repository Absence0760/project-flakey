// Pure helpers for the audit-export (SIEM) admin form. Kept DOM-free so they're
// unit-testable (frontend/CLAUDE.md: vitest covers pure helpers only). The
// validation rules mirror backend/src/routes/audit.ts (`validateExportBody`,
// HTTP_FIELD_NAME, S3_BUCKET_NAME) so the form rejects bad input before a round
// trip — the backend re-validates as the source of truth, this is just early UX.
import type { AuditExportConfig } from "$lib/api";

// RFC 7230 field-name (token chars). Matches HTTP_FIELD_NAME on the backend.
const HTTP_FIELD_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
// Conservative S3 bucket DNS-label shape. Matches S3_BUCKET_NAME on the backend.
const S3_BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export type Destination = "http" | "s3";

// Draft the form binds to. Strings (not null) so inputs stay controlled; the
// caller maps them to the API request body (trimming, dropping blanks).
export interface ExportDraft {
  destination: Destination;
  enabled: boolean;
  fromBeginning: boolean;
  endpointUrl: string;
  authHeaderName: string;
  authToken: string;
  s3Bucket: string;
  s3Prefix: string;
}

export function emptyDraft(destination: Destination = "http"): ExportDraft {
  return {
    destination,
    enabled: false,
    fromBeginning: false,
    endpointUrl: "",
    authHeaderName: "",
    authToken: "",
    s3Bucket: "",
    s3Prefix: "",
  };
}

// Build an edit draft from a saved config. The token is never returned by the
// API (auth_token_set is a boolean), so authToken always starts blank — a blank
// value means "leave the stored token untouched" on save.
export function draftFromConfig(c: AuditExportConfig): ExportDraft {
  return {
    destination: c.destination,
    enabled: c.enabled,
    fromBeginning: false, // not editable after create (cursor already seeded)
    endpointUrl: c.endpoint_url ?? "",
    authHeaderName: c.auth_header_name ?? "",
    authToken: "",
    s3Bucket: c.s3_bucket ?? "",
    s3Prefix: c.s3_prefix ?? "",
  };
}

// Validate an endpoint URL the way validateWebhookUrl does at the layer the
// browser can check: absolute http(s) URL. (The backend additionally runs the
// SSRF guard — private/loopback/metadata blocking — which we can't replicate
// client-side; a value that passes here can still be 400'd server-side, and
// that error is surfaced verbatim.)
export function validateEndpointUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "Endpoint URL is required";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "Endpoint URL is not a valid absolute URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return "Endpoint URL must use http or https";
  }
  return null;
}

export function validateAuthHeaderName(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null; // optional
  if (!HTTP_FIELD_NAME.test(v)) return "Header name is not a valid HTTP header field-name";
  return null;
}

export function validateS3Bucket(raw: string): string | null {
  const v = raw.trim();
  if (!v) return "S3 bucket is required";
  if (!S3_BUCKET_NAME.test(v)) return "Bucket name is not a valid S3 bucket name";
  return null;
}

// Full-draft validation. Returns the first error message, or null if valid.
// Branches on destination exactly like the backend's validateExportBody.
export function validateDraft(d: ExportDraft): string | null {
  if (d.destination !== "http" && d.destination !== "s3") {
    return "Destination must be HTTP or S3";
  }
  if (d.destination === "http") {
    return validateEndpointUrl(d.endpointUrl) ?? validateAuthHeaderName(d.authHeaderName);
  }
  return validateS3Bucket(d.s3Bucket);
}

// Map a draft to the POST /audit/export create body — trims, drops blank
// optionals, and only sends the fields relevant to the chosen destination.
export function draftToCreateBody(d: ExportDraft): import("$lib/api").AuditExportCreate {
  if (d.destination === "http") {
    return {
      destination: "http",
      enabled: d.enabled,
      from_beginning: d.fromBeginning,
      endpoint_url: d.endpointUrl.trim(),
      ...(d.authHeaderName.trim() ? { auth_header_name: d.authHeaderName.trim() } : {}),
      ...(d.authToken ? { auth_token: d.authToken } : {}),
    };
  }
  return {
    destination: "s3",
    enabled: d.enabled,
    from_beginning: d.fromBeginning,
    s3_bucket: d.s3Bucket.trim(),
    ...(d.s3Prefix.trim() ? { s3_prefix: d.s3Prefix.trim() } : {}),
  };
}

// Map a draft to the PATCH /audit/export/:id update body. Destination is
// immutable, so it's not sent. A blank authToken means "keep the stored token";
// a non-blank value rotates it. (Clearing a token isn't exposed in the form —
// the create-then-rotate flow covers the real use case; a token is only ever
// set or rotated, never deliberately removed while keeping the destination.)
export function draftToUpdateBody(d: ExportDraft): import("$lib/api").AuditExportUpdate {
  if (d.destination === "http") {
    return {
      enabled: d.enabled,
      endpoint_url: d.endpointUrl.trim(),
      auth_header_name: d.authHeaderName.trim(),
      ...(d.authToken ? { auth_token: d.authToken } : {}),
    };
  }
  return {
    enabled: d.enabled,
    s3_bucket: d.s3Bucket.trim(),
    s3_prefix: d.s3Prefix.trim(),
  };
}

// Health summary for a saved destination, derived from its delivery counters.
// Drives the status dot + label without each call site re-deriving the rules.
export type ExportHealth = "ok" | "failing" | "disabled" | "idle";

export function exportHealth(c: AuditExportConfig): ExportHealth {
  if (!c.enabled) return "disabled";
  if (c.consecutive_failures > 0) return "failing";
  if (c.last_success_at) return "ok";
  return "idle"; // enabled but nothing delivered yet
}

export function exportHealthLabel(h: ExportHealth): string {
  switch (h) {
    case "ok":
      return "Delivering";
    case "failing":
      return "Failing";
    case "disabled":
      return "Disabled";
    case "idle":
      return "Awaiting first delivery";
  }
}

// A one-line human summary of where a destination points, for list rows.
export function destinationSummary(c: AuditExportConfig): string {
  if (c.destination === "http") return c.endpoint_url ?? "(no endpoint)";
  const bucket = c.s3_bucket ?? "(no bucket)";
  return c.s3_prefix ? `s3://${bucket}/${c.s3_prefix}` : `s3://${bucket}`;
}
