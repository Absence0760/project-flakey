variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "ap-southeast-2"
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "production"
}

variable "app_name" {
  description = "Application name"
  type        = string
  default     = "flakey"
}

variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t4g.micro"
}

variable "allow_registration" {
  description = "Allow open user registration"
  type        = bool
  default     = false
}

variable "budget_limit" {
  description = "Monthly AWS budget limit in USD"
  type        = string
  default     = "150"
}

variable "budget_alert_email" {
  description = "Email address for budget alerts"
  type        = string
}

variable "acm_certificate_arn" {
  description = "ARN of the ACM certificate for the ALB HTTPS listener. Must be in the same region as the ALB."
  type        = string
}

# ─── Optional cost-incurring features ──────────────────────────────────
#
# Every one of these flags adds a real monthly cost. They all default
# false so the baseline stack is the minimum-viable production
# footprint. Flip them per-env via terraform.tfvars as scale + threat
# model justify the additional spend.

variable "enable_vpc_endpoints" {
  description = "S3 gateway + Interface endpoints (ECR, Secrets Manager, CloudWatch Logs, STS). ~$72/mo at 2 AZs; net win only above ~1.5 TB/mo of AWS-API NAT traffic."
  type        = bool
  default     = false
}

variable "enable_waf" {
  description = "WAFv2 web ACL on the CloudFront distribution. ~$9/mo + $0.60/M requests; worth it for public-facing SaaS, overkill for auth-gated dashboards."
  type        = bool
  default     = false
}

variable "enable_performance_insights" {
  description = "RDS Performance Insights with the AWS-managed RDS KMS key. ~$7/mo on a t3/t4g.micro; pays off when slow-query debugging is a regular need."
  type        = bool
  default     = false
}

variable "rds_multi_az" {
  description = "Enable Multi-AZ RDS deployment. Recommended true for production (synchronous standby + failover); false for staging/dev to halve the instance cost."
  type        = bool
  default     = true
}

variable "csp_connect_src" {
  description = "Additional connect-src origins for the CloudFront response-headers CSP. The SPA fetches the API from a different origin (CloudFront vs ALB), so this MUST include the API origin or every fetch from the dashboard fails with a CSP error and the dashboard renders blank. e.g. [\"https://api.your-domain.com\"]."
  type        = list(string)
  validation {
    condition     = length(var.csp_connect_src) > 0
    error_message = "csp_connect_src must include at least one API origin — without it, the SvelteKit SPA can't reach the API and the dashboard renders blank. See terraform.tfvars.example."
  }
  validation {
    # Reject the `<...>` placeholder text that terraform.tfvars.example
    # ships with — forces self-hosters to actually edit the file before
    # `terraform apply` succeeds.
    condition     = alltrue([for s in var.csp_connect_src : !can(regex("<", s)) && !can(regex(">", s))])
    error_message = "csp_connect_src contains a `<placeholder>` value from terraform.tfvars.example — replace it with your real API origin (e.g. \"https://api.acme.com\")."
  }
}

variable "cloudfront_acm_certificate_arn" {
  description = "ACM certificate ARN in us-east-1 for a custom CloudFront domain. When set, enforces minimum_protocol_version=TLSv1.2_2021 + SNI. Default null = CloudFront's default `*.cloudfront.net` cert (can't pin a min TLS version). REQUIRED before going to prod on a real domain. Note: ACM cert for CloudFront MUST live in us-east-1, regardless of the rest of the stack."
  type        = string
  default     = null
}

variable "cloudfront_aliases" {
  description = "DNS aliases (CNAMEs) for the CloudFront distribution. Required when cloudfront_acm_certificate_arn is set so SNI matches the cert. e.g. [\"app.your-domain.com\"]."
  type        = list(string)
  default     = []
}

variable "enable_flow_logs" {
  description = "VPC Flow Logs (REJECT-only) to CloudWatch with KMS encryption. ~$5-15/mo at low volume; needed for security-investigation cadence, otherwise audit-trail bloat."
  type        = bool
  default     = false
}

variable "cpu_architecture" {
  description = "ECS Fargate runtime architecture. ARM64 (Graviton) is ~20% cheaper compute than X86_64 for Node workloads; requires the deploy pipeline to build linux/arm64 images."
  type        = string
  default     = "ARM64"
  validation {
    condition     = contains(["ARM64", "X86_64"], var.cpu_architecture)
    error_message = "cpu_architecture must be ARM64 or X86_64."
  }
}

variable "artifact_retention_days" {
  description = "Hard cap (days) after which the S3 lifecycle expires test artifacts (screenshots/videos/snapshots) — a storage-cost backstop, NOT the primary cleanup. The backend already deletes a run's artifacts when per-org retention (organizations.retention_days) prunes it (backend/src/retention.ts); this catches anything that delete misses (orphans from interrupted writes). Set this >= the largest org retention_days you allow, or this cap will delete artifacts before the per-org policy intends. See docs/operations/backup-and-dr.md."
  type        = number
  default     = 365
  validation {
    condition     = var.artifact_retention_days >= 7 && var.artifact_retention_days <= 3650
    error_message = "artifact_retention_days must be between 7 and 3650."
  }
}

variable "artifact_ia_transition_days" {
  description = "Days before test artifacts transition to S3 STANDARD_IA (cheaper, slower-access). Must be < artifact_retention_days. 30 is the S3 minimum for IA."
  type        = number
  default     = 30
  validation {
    condition     = var.artifact_ia_transition_days >= 30
    error_message = "artifact_ia_transition_days must be at least 30 (S3 STANDARD_IA minimum)."
  }
}
