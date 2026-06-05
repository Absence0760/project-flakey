/**
 * S3 client config — pins the S3-compatible-store wiring so the local
 * MinIO path (and any Ceph / Backblaze / Wasabi prod target) keeps
 * working.
 *
 * The rule that matters: a custom S3_ENDPOINT must flip on path-style
 * addressing, because `<bucket>.localhost:9000` virtual-host subdomains
 * don't resolve against MinIO. Real AWS (no endpoint) must stay on the
 * default virtual-host addressing — forcing path-style there would
 * break signed-URL hosts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { s3ClientConfig } from "../storage.js";

test("no S3_ENDPOINT → region only, no endpoint, default addressing (real AWS)", () => {
  const cfg = s3ClientConfig({ S3_REGION: "eu-west-1" } as NodeJS.ProcessEnv);
  assert.equal(cfg.region, "eu-west-1");
  assert.equal(cfg.endpoint, undefined);
  assert.equal(cfg.forcePathStyle, undefined);
});

test("region defaults to us-east-1 when S3_REGION is unset", () => {
  const cfg = s3ClientConfig({} as NodeJS.ProcessEnv);
  assert.equal(cfg.region, "us-east-1");
});

test("S3_ENDPOINT set → endpoint applied and path-style forced on (MinIO)", () => {
  const cfg = s3ClientConfig({
    S3_ENDPOINT: "http://localhost:9000",
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.endpoint, "http://localhost:9000");
  assert.equal(cfg.forcePathStyle, true);
});

test("S3_FORCE_PATH_STYLE=false opts back out of path-style even with an endpoint", () => {
  const cfg = s3ClientConfig({
    S3_ENDPOINT: "https://s3.example.com",
    S3_FORCE_PATH_STYLE: "false",
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.endpoint, "https://s3.example.com");
  assert.equal(cfg.forcePathStyle, false);
});
