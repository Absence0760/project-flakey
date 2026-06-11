variable "app_name" { type = string }
variable "environment" { type = string }
variable "artifact_retention_days" {
  description = "Hard cap (days) for the artifacts-bucket lifecycle expiration. Storage-cost backstop behind the backend's per-org retention delete (backend/src/retention.ts)."
  type        = number
  default     = 365
}
variable "artifact_ia_transition_days" {
  description = "Days before artifacts transition to STANDARD_IA (S3 minimum 30)."
  type        = number
  default     = 30
}
variable "enable_waf" {
  description = "Toggle the WAFv2 web ACL on the CloudFront distribution."
  type        = bool
  default     = false
}
variable "csp_connect_src" {
  description = "Additional connect-src values for the CloudFront response-headers CSP. The frontend always gets `'self'`. List the API origin(s) the SPA needs to fetch from (e.g. [\"https://api.your-domain.com\"]). Empty list keeps connect-src tight to `'self'` only."
  type        = list(string)
  default     = []
}
variable "csp_img_src" {
  description = "Additional img-src values for the CloudFront response-headers CSP. The frontend always gets `'self' data: blob:`. Test SCREENSHOTS are <img> elements served from the API origin (and, under STORAGE=s3, from the artifact bucket/CDN origin via presigned URLs), so this MUST include those origin(s) or every screenshot is blocked with a CSP img-src violation. Typically the same value as csp_connect_src plus any artifact-bucket origin."
  type        = list(string)
  default     = []
}
variable "csp_media_src" {
  description = "Additional media-src values for the CloudFront response-headers CSP. The frontend always gets `'self' blob:`. Failure VIDEOS are <video> elements served from the same origin(s) as screenshots; without this they fall back to default-src 'self' and won't play. Typically the same value as csp_img_src."
  type        = list(string)
  default     = []
}

variable "cloudfront_acm_certificate_arn" {
  description = "ACM certificate ARN (in us-east-1) for a custom domain on CloudFront. When set, the viewer is configured with minimum_protocol_version=TLSv1.2_2021 + SNI. When null (default), CloudFront uses the default `*.cloudfront.net` cert which cannot enforce a min TLS version. Set this before exposing the dashboard on a real domain."
  type        = string
  default     = null
}

variable "cloudfront_aliases" {
  description = "DNS aliases for the CloudFront distribution. Required when cloudfront_acm_certificate_arn is set so SNI can match the cert's CN. e.g. [\"app.your-domain.com\"]."
  type        = list(string)
  default     = []
}
