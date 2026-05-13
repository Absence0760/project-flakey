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
  description = "Additional connect-src origins for the CloudFront response-headers CSP. The frontend always has 'self'. Add the API origin(s) here so the SPA can fetch from them (e.g. [\"https://api.flakey.io\"]). Empty = SPA only fetches same-origin."
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
