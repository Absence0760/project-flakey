# Centralised access-log destination for both S3 server-access logs
# and CloudFront standard logs. Kept in this module so the lifecycle
# is colocated with the buckets it logs. ACL ownership is required for
# S3 server-access logging; CloudFront writes via the legacy log
# delivery service (`awslogsdelivery` canonical user).
resource "aws_s3_bucket" "logs" {
  bucket        = "${var.app_name}-${var.environment}-logs"
  force_destroy = false
  tags          = { Name = "${var.app_name}-${var.environment}-logs" }
}

# Versioning on the logs bucket. S3 + CloudFront access-log delivery
# overwrites the per-object key on partial-day rollups, so versioning
# preserves the audit trail through those overwrites. Resolves AWS-0090.
resource "aws_s3_bucket_versioning" "logs" {
  bucket = aws_s3_bucket.logs.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_ownership_controls" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    # BucketOwnerPreferred lets CloudFront / S3 logging deliver objects
    # under the bucket owner's account. Required for the log-delivery
    # ACL grants that CloudFront uses (otherwise objects land under the
    # delivery service principal and are unreadable).
    object_ownership = "BucketOwnerPreferred"
  }
}

resource "aws_s3_bucket_acl" "logs" {
  depends_on = [aws_s3_bucket_ownership_controls.logs]
  bucket     = aws_s3_bucket.logs.id
  acl        = "log-delivery-write"
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket                  = aws_s3_bucket.logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    # SSE-S3 (AES256) rather than aws:kms — the S3 server-access-log
    # delivery service can't write to a bucket that's encrypted with a
    # customer-managed or aws:kms key. AES256 is still encrypted at
    # rest. CloudFront log delivery has the same constraint.
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    id     = "expire-logs"
    status = "Enabled"
    # 90 days covers a typical security-investigation window; beyond
    # that the storage cost grows faster than the audit value.
    expiration { days = 90 }
    # Filter applies the rule to all objects in the bucket without
    # imposing a prefix constraint.
    filter {}
  }
}

resource "aws_s3_bucket" "artifacts" {
  bucket        = "${var.app_name}-${var.environment}-artifacts"
  force_destroy = false
  tags          = { Name = "${var.app_name}-${var.environment}-artifacts" }
}

# Resolves Trivy AWS-0089 for the artifacts bucket.
resource "aws_s3_bucket_logging" "artifacts" {
  bucket        = aws_s3_bucket.artifacts.id
  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "s3-access/artifacts/"
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    # aws:kms with the account-default S3 KMS key. Beats AES256 (SSE-S3)
    # because the AWS-managed key has its own audit trail in
    # CloudTrail; the cost difference at this scale is rounding-error.
    # Resolves Trivy AWS-0132.
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = "alias/aws/s3"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration { status = "Enabled" }
}

# Artifact lifecycle. This is a storage-cost BACKSTOP, not the primary cleanup:
# the backend deletes a run's artifacts the moment per-org retention prunes the
# run (backend/src/retention.ts -> storage.deleteRun). The expiration here only
# catches orphans that delete misses (interrupted writes, manual S3 drops).
# Expiration + IA-transition are configurable so operators can match their
# compliance window — keep `artifact_retention_days` >= the largest per-org
# retention_days, or this cap deletes artifacts ahead of the per-org policy.
# See docs/operations/backup-and-dr.md.
resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    id     = "cleanup-old-artifacts"
    status = "Enabled"
    # Apply to the whole bucket. (An empty filter is required in the AWS
    # provider v4+ lifecycle schema for a bucket-wide rule.)
    filter {}
    transition {
      days          = var.artifact_ia_transition_days
      storage_class = "STANDARD_IA"
    }
    expiration { days = var.artifact_retention_days }
    # Versioning is enabled to protect against silent overwrites on key
    # collisions (e.g. re-runs that emit the same screenshot path). Without
    # this, old versions would accumulate forever.
    noncurrent_version_expiration { noncurrent_days = 30 }
    # Reclaim storage from interrupted multipart uploads (large videos that
    # never finished). S3 otherwise bills for these parts indefinitely.
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}

# --- Frontend static hosting ---
resource "aws_s3_bucket" "frontend" {
  bucket = "${var.app_name}-${var.environment}-frontend"
  # force_destroy=false matches the artifacts bucket. A terraform
  # destroy will refuse to drop the bucket while it contains the
  # built frontend, which is the desired behaviour in prod. Empty
  # the bucket manually or flip this temporarily for a tear-down.
  force_destroy = false
  tags          = { Name = "${var.app_name}-${var.environment}-frontend" }
}

# Resolves Trivy AWS-0089 for the frontend bucket.
resource "aws_s3_bucket_logging" "frontend" {
  bucket        = aws_s3_bucket.frontend.id
  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "s3-access/frontend/"
}

# aws:kms encryption for the frontend bucket too. Resolves AWS-0132.
resource "aws_s3_bucket_server_side_encryption_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = "alias/aws/s3"
    }
    bucket_key_enabled = true
  }
}

# Versioning lets us roll back a bad deploy without re-uploading.
# Resolves Trivy AWS-0090.
resource "aws_s3_bucket_versioning" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  versioning_configuration { status = "Enabled" }
}

# Block all direct public access - content is served exclusively via CloudFront OAC.
resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket                  = aws_s3_bucket.frontend.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Origin Access Control (current AWS recommendation over OAI).
resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${var.app_name}-${var.environment}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Allow only CloudFront (scoped to this distribution) to read from the bucket.
resource "aws_s3_bucket_policy" "frontend" {
  bucket     = aws_s3_bucket.frontend.id
  depends_on = [aws_s3_bucket_public_access_block.frontend]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontOAC"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.frontend.arn}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.frontend.arn
        }
      }
    }]
  })
}

# WAFv2 web ACL for the CloudFront distribution. Lives in us-east-1
# (where CloudFront reads its ACLs) regardless of the rest of the
# stack's region. Two AWS-managed rule groups give us OWASP common +
# known-bad-input coverage at the CloudFront edge before traffic ever
# reaches the ALB. Resolves Trivy AWS-0011 when enabled.
#
# Cost-gated: $5/mo per web ACL + $1/mo per managed rule group +
# $0.60 per million inspected requests. Off by default — the bulk of
# the dashboard's surface is auth-gated, so the WAF mostly defends
# the /badge/* + /login routes. Flip on via var.enable_waf when the
# app starts serving meaningful public traffic.
resource "aws_wafv2_web_acl" "frontend" {
  count       = var.enable_waf ? 1 : 0
  provider    = aws.us_east_1
  name        = "${var.app_name}-${var.environment}-frontend"
  scope       = "CLOUDFRONT"
  description = "OWASP common + known-bad inputs for the public CloudFront distribution."

  default_action {
    allow {}
  }

  rule {
    name     = "AWS-AWSManagedRulesCommonRuleSet"
    priority = 0
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.app_name}-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWS-AWSManagedRulesKnownBadInputsRuleSet"
    priority = 1
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.app_name}-badinputs"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.app_name}-${var.environment}-frontend-acl"
    sampled_requests_enabled   = true
  }
}

# Strict response headers for the SPA. HSTS gives the browser a
# year of HTTPS pinning, the X-* headers re-state defences that
# helmet sets on the backend (frame-ancestors, sniffing, referrer
# leakage), and CSP is permissive only for the origin's own assets
# plus inline styles SvelteKit emits during hydration.
#
# `style-src 'unsafe-inline'`: SvelteKit emits hydration `<style>`
# blocks at runtime; switching to nonce/hash mode requires SSR
# coordination this static-site adapter doesn't provide. Future
# tightening: pre-compute hashes of every emitted inline-style block at
# build time and inject them here.
#
# `connect-src` is `'self'` plus whatever is in var.csp_connect_src.
# The previous wildcard `https:` allowed exfiltration to any HTTPS
# host; tighten to the API origin via `csp_connect_src = ["https://..."]`
# in the root tfvars.
locals {
  csp_connect_src = trimspace(join(" ", concat(["'self'"], var.csp_connect_src)))
  csp = join("; ", [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src ${local.csp_connect_src}",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ])
}

resource "aws_cloudfront_response_headers_policy" "frontend" {
  name = "${var.app_name}-${var.environment}-frontend-headers"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }
    content_type_options { override = true }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    content_security_policy {
      content_security_policy = local.csp
      override                = true
    }
  }
}

# CloudFront for HTTPS + caching
resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  # Attach the WAF only when var.enable_waf is on; otherwise leave
  # web_acl_id null so the distribution doesn't reference a count=0
  # resource. one() returns null for an empty list.
  web_acl_id = one(aws_wafv2_web_acl.frontend[*].arn)

  # CloudFront standard access logs — written to the same logs bucket
  # under a cloudfront/ prefix so the access-log lifecycle policy
  # covers it too. Resolves Trivy AWS-0010.
  logging_config {
    bucket          = aws_s3_bucket.logs.bucket_domain_name
    prefix          = "cloudfront/"
    include_cookies = false
  }

  origin {
    # Use the regional S3 domain (not the website endpoint) for OAC.
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "s3-frontend"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  default_cache_behavior {
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    target_origin_id           = "s3-frontend"
    viewer_protocol_policy     = "redirect-to-https"
    compress                   = true
    response_headers_policy_id = aws_cloudfront_response_headers_policy.frontend.id

    forwarded_values {
      query_string = false
      cookies { forward = "none" }
    }

    min_ttl     = 0
    default_ttl = 3600
    max_ttl     = 86400
  }

  # SPA: serve index.html for all 404s (client-side routing)
  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  # When a custom ACM cert is supplied, enforce TLS 1.2_2021 at the
  # edge. The default `*.cloudfront.net` cert can't carry a minimum
  # protocol version — CloudFront falls back to its global default
  # (TLSv1 at time of writing), so the only way to pin a floor is via
  # an explicit ACM cert. Aliases are required so SNI can match.
  dynamic "viewer_certificate" {
    for_each = var.cloudfront_acm_certificate_arn == null ? [1] : []
    content {
      cloudfront_default_certificate = true
    }
  }
  dynamic "viewer_certificate" {
    for_each = var.cloudfront_acm_certificate_arn == null ? [] : [1]
    content {
      acm_certificate_arn      = var.cloudfront_acm_certificate_arn
      ssl_support_method       = "sni-only"
      minimum_protocol_version = "TLSv1.2_2021"
    }
  }

  aliases = var.cloudfront_aliases

  tags = { Name = "${var.app_name}-${var.environment}-cdn" }
}
