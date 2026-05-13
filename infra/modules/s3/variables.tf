variable "app_name" { type = string }
variable "environment" { type = string }
variable "enable_waf" {
  description = "Toggle the WAFv2 web ACL on the CloudFront distribution."
  type        = bool
  default     = false
}
variable "csp_connect_src" {
  description = "Additional connect-src values for the CloudFront response-headers CSP. The frontend always gets `'self'`. List the API origin(s) the SPA needs to fetch from (e.g. [\"https://api.flakey.io\"]). Empty list keeps connect-src tight to `'self'` only."
  type        = list(string)
  default     = []
}
