variable "app_name" { type = string }
variable "environment" { type = string }
variable "aws_region" { type = string }
variable "enable_vpc_endpoints" {
  description = "Toggle S3 gateway + Interface VPC endpoints for AWS APIs."
  type        = bool
  default     = false
}
variable "enable_flow_logs" {
  description = "Toggle VPC Flow Logs to a KMS-encrypted CloudWatch group."
  type        = bool
  default     = false
}
