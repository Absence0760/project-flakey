variable "app_name" { type = string }
variable "environment" { type = string }
variable "aws_region" { type = string }
variable "vpc_id" { type = string }
variable "vpc_cidr" {
  description = "VPC CIDR — used to confine ECS task egress to the RDS Postgres port to VPC-local traffic only."
  type        = string
}
variable "public_subnet_ids" { type = list(string) }
variable "private_subnet_ids" { type = list(string) }
variable "backend_image" { type = string }
variable "frontend_url" { type = string }
variable "db_host" { type = string }
variable "db_port" { type = number }
variable "db_name" { type = string }
variable "db_username" { type = string }
variable "db_password_arn" {
  description = "ARN of the RDS-managed master user secret (JSON; migrations + the app-role password ALTER run as this superuser)."
  type        = string
}
variable "db_app_password_arn" {
  description = "ARN of the dedicated non-superuser app-role (flakey_app) password secret. The app authenticates with this; kept separate from the master secret so an app-credential leak never exposes the superuser."
  type        = string
}
variable "jwt_secret_arn" { type = string }
variable "encryption_key_arn" {
  description = "ARN of the FLAKEY_ENCRYPTION_KEY secret (32-byte hex). The backend refuses to boot in production without it."
  type        = string
}
variable "s3_bucket" { type = string }
variable "allow_registration" { type = bool }
variable "acm_certificate_arn" { type = string }
variable "alert_email" {
  description = "Email address to receive CloudWatch alarm notifications via SNS."
  type        = string
}
variable "cpu_architecture" {
  description = "Fargate runtime CPU architecture. ARM64 (Graviton) is ~20% cheaper for Node workloads; requires the deploy pipeline to push linux/arm64 images."
  type        = string
  default     = "ARM64"
}
