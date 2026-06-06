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

# --- First-admin bootstrap (optional) ---
# No default credentials ship; the old admin@example.com/admin seed was
# removed. Set these to have entrypoint.sh create the first admin on a
# fresh database. Both are rendered into the task definition only when set.
variable "bootstrap_admin_email" {
  description = "Optional first-admin email (FLAKEY_BOOTSTRAP_ADMIN_EMAIL). Empty = no bootstrap admin is injected."
  type        = string
  default     = ""
}
variable "bootstrap_admin_password_arn" {
  description = "Optional ARN of a Secrets Manager secret holding the first-admin password (FLAKEY_BOOTSTRAP_ADMIN_PASSWORD). Empty = no bootstrap password is injected. Use a secret rather than a plaintext variable so the password never lands in state or the task-definition environment."
  type        = string
  default     = ""
}
