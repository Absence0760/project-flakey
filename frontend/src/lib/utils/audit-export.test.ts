import { describe, it, expect } from "vitest";
import type { AuditExportConfig } from "$lib/api";
import {
  emptyDraft,
  draftFromConfig,
  validateEndpointUrl,
  validateAuthHeaderName,
  validateS3Bucket,
  validateDraft,
  draftToCreateBody,
  draftToUpdateBody,
  exportHealth,
  exportHealthLabel,
  destinationSummary,
  type ExportDraft,
} from "./audit-export";

function cfg(overrides: Partial<AuditExportConfig> = {}): AuditExportConfig {
  return {
    id: 1,
    destination: "http",
    enabled: true,
    endpoint_url: "https://siem.example.com/collect",
    auth_header_name: "Authorization",
    auth_token_set: true,
    s3_bucket: null,
    s3_prefix: null,
    last_exported_id: "42",
    last_success_at: "2026-06-01T00:00:00.000Z",
    last_error: null,
    consecutive_failures: 0,
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("validateEndpointUrl", () => {
  it("accepts an absolute https URL", () => {
    expect(validateEndpointUrl("https://http-inputs.splunkcloud.com/x")).toBeNull();
  });
  it("accepts http", () => {
    expect(validateEndpointUrl("http://collector.local/x")).toBeNull();
  });
  it("rejects a blank URL as required", () => {
    expect(validateEndpointUrl("   ")).toMatch(/required/i);
  });
  it("rejects a non-absolute / unparseable URL", () => {
    expect(validateEndpointUrl("not a url")).toMatch(/valid absolute/i);
    expect(validateEndpointUrl("/relative/path")).toMatch(/valid absolute/i);
  });
  it("rejects a non-http(s) scheme", () => {
    expect(validateEndpointUrl("ftp://host/x")).toMatch(/http or https/i);
    expect(validateEndpointUrl("javascript:alert(1)")).toMatch(/http or https/i);
  });
  it("trims surrounding whitespace before validating", () => {
    expect(validateEndpointUrl("  https://ok.example.com/  ")).toBeNull();
  });
});

describe("validateAuthHeaderName", () => {
  it("treats blank as valid (optional)", () => {
    expect(validateAuthHeaderName("")).toBeNull();
    expect(validateAuthHeaderName("   ")).toBeNull();
  });
  it("accepts a normal header token", () => {
    expect(validateAuthHeaderName("Authorization")).toBeNull();
    expect(validateAuthHeaderName("X-Splunk-Token")).toBeNull();
  });
  it("rejects a header name with spaces or illegal chars", () => {
    expect(validateAuthHeaderName("Bad Header")).toMatch(/valid HTTP header/i);
    expect(validateAuthHeaderName("colon:name")).toMatch(/valid HTTP header/i);
  });
});

describe("validateS3Bucket", () => {
  it("accepts a valid DNS-label bucket name", () => {
    expect(validateS3Bucket("acme-audit-archive")).toBeNull();
    expect(validateS3Bucket("a1.b2.c3")).toBeNull();
  });
  it("rejects a blank bucket as required", () => {
    expect(validateS3Bucket("")).toMatch(/required/i);
  });
  it("rejects uppercase / underscore / leading dot", () => {
    expect(validateS3Bucket("My_Bucket")).toMatch(/valid S3 bucket/i);
    expect(validateS3Bucket(".bad")).toMatch(/valid S3 bucket/i);
    expect(validateS3Bucket("a")).toMatch(/valid S3 bucket/i); // too short for the pattern
  });
});

describe("validateDraft", () => {
  it("validates the http branch (endpoint + header name)", () => {
    const d: ExportDraft = { ...emptyDraft("http"), endpointUrl: "", authHeaderName: "X-Tok" };
    expect(validateDraft(d)).toMatch(/required/i);
    d.endpointUrl = "https://ok.example.com";
    d.authHeaderName = "bad header";
    expect(validateDraft(d)).toMatch(/valid HTTP header/i);
    d.authHeaderName = "X-Tok";
    expect(validateDraft(d)).toBeNull();
  });
  it("validates the s3 branch (bucket only) and ignores http fields", () => {
    const d: ExportDraft = { ...emptyDraft("s3"), endpointUrl: "garbage", s3Bucket: "" };
    expect(validateDraft(d)).toMatch(/required/i);
    d.s3Bucket = "valid-bucket";
    expect(validateDraft(d)).toBeNull(); // endpointUrl garbage is irrelevant for s3
  });
});

describe("draftToCreateBody", () => {
  it("builds an http body, dropping blank optionals and trimming", () => {
    const d: ExportDraft = {
      ...emptyDraft("http"),
      enabled: true,
      fromBeginning: true,
      endpointUrl: "  https://siem/x  ",
      authHeaderName: "",
      authToken: "",
    };
    expect(draftToCreateBody(d)).toEqual({
      destination: "http",
      enabled: true,
      from_beginning: true,
      endpoint_url: "https://siem/x",
    });
  });
  it("includes auth_header_name + auth_token when present", () => {
    const d: ExportDraft = {
      ...emptyDraft("http"),
      endpointUrl: "https://siem/x",
      authHeaderName: "Authorization",
      authToken: "Splunk abc",
    };
    const body = draftToCreateBody(d);
    expect(body.auth_header_name).toBe("Authorization");
    expect(body.auth_token).toBe("Splunk abc");
  });
  it("builds an s3 body with optional prefix", () => {
    const d: ExportDraft = { ...emptyDraft("s3"), s3Bucket: "  acme-archive  ", s3Prefix: " flakey/audit " };
    expect(draftToCreateBody(d)).toEqual({
      destination: "s3",
      enabled: false,
      from_beginning: false,
      s3_bucket: "acme-archive",
      s3_prefix: "flakey/audit",
    });
  });
});

describe("draftToUpdateBody", () => {
  it("omits auth_token when blank (keep stored token), includes it when set", () => {
    const base: ExportDraft = {
      ...emptyDraft("http"),
      enabled: true,
      endpointUrl: "https://siem/x",
      authHeaderName: "Authorization",
    };
    expect("auth_token" in draftToUpdateBody(base)).toBe(false);
    const rotated = draftToUpdateBody({ ...base, authToken: "new-token" });
    expect(rotated.auth_token).toBe("new-token");
  });
  it("does not send the destination (immutable)", () => {
    const body = draftToUpdateBody({ ...emptyDraft("s3"), s3Bucket: "b" });
    expect("destination" in body).toBe(false);
  });
});

describe("draftFromConfig", () => {
  it("starts authToken blank (token is never returned)", () => {
    const d = draftFromConfig(cfg());
    expect(d.authToken).toBe("");
    expect(d.endpointUrl).toBe("https://siem.example.com/collect");
    expect(d.destination).toBe("http");
  });
  it("maps null s3 fields to empty strings", () => {
    const d = draftFromConfig(cfg({ destination: "s3", endpoint_url: null, s3_bucket: "b", s3_prefix: null }));
    expect(d.s3Bucket).toBe("b");
    expect(d.s3Prefix).toBe("");
  });
});

describe("exportHealth + label", () => {
  it("disabled when not enabled, regardless of counters", () => {
    expect(exportHealth(cfg({ enabled: false, last_success_at: "x", consecutive_failures: 3 }))).toBe("disabled");
  });
  it("failing when enabled with consecutive failures", () => {
    expect(exportHealth(cfg({ enabled: true, consecutive_failures: 2 }))).toBe("failing");
  });
  it("ok when enabled, no failures, and a prior success", () => {
    expect(exportHealth(cfg({ enabled: true, consecutive_failures: 0, last_success_at: "x" }))).toBe("ok");
  });
  it("idle when enabled but nothing delivered yet", () => {
    expect(exportHealth(cfg({ enabled: true, consecutive_failures: 0, last_success_at: null }))).toBe("idle");
  });
  it("has a label for every state", () => {
    for (const h of ["ok", "failing", "disabled", "idle"] as const) {
      expect(exportHealthLabel(h)).toBeTruthy();
    }
  });
});

describe("destinationSummary", () => {
  it("shows the endpoint URL for http", () => {
    expect(destinationSummary(cfg())).toBe("https://siem.example.com/collect");
  });
  it("shows s3://bucket/prefix for s3", () => {
    expect(destinationSummary(cfg({ destination: "s3", s3_bucket: "b", s3_prefix: "p" }))).toBe("s3://b/p");
    expect(destinationSummary(cfg({ destination: "s3", s3_bucket: "b", s3_prefix: null }))).toBe("s3://b");
  });
});
