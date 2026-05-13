variable "app_name" { type = string }
variable "environment" { type = string }
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
