variable "app_name" { type = string }
variable "environment" { type = string }
variable "enable_waf" {
  description = "Toggle the WAFv2 web ACL on the CloudFront distribution."
  type        = bool
  default     = false
}
