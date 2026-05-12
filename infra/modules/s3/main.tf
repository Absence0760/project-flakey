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

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    id     = "cleanup-old-artifacts"
    status = "Enabled"
    transition {
      days          = 90
      storage_class = "STANDARD_IA"
    }
    expiration { days = 365 }
    # Versioning is enabled to protect against silent overwrites on key
    # collisions (e.g. re-runs that emit the same screenshot path).  Without
    # this expiration, old versions would accumulate forever.
    noncurrent_version_expiration { noncurrent_days = 30 }
  }
}

# --- Frontend static hosting ---
resource "aws_s3_bucket" "frontend" {
  bucket        = "${var.app_name}-${var.environment}-frontend"
  force_destroy = true
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
# reaches the ALB. Resolves Trivy AWS-0011.
resource "aws_wafv2_web_acl" "frontend" {
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

# CloudFront for HTTPS + caching
resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  web_acl_id          = aws_wafv2_web_acl.frontend.arn

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
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "s3-frontend"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

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

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = { Name = "${var.app_name}-${var.environment}-cdn" }
}
