variable "app_name" { type = string }
variable "environment" { type = string }
variable "aws_region" { type = string }
variable "vpc_id" { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "private_subnet_ids" { type = list(string) }
variable "backend_image" { type = string }
variable "frontend_url" { type = string }
variable "db_host" { type = string }
variable "db_port" { type = number }
variable "db_name" { type = string }
variable "db_username" { type = string }
variable "db_password_arn" { type = string }
variable "jwt_secret_arn" { type = string }
variable "s3_bucket" { type = string }
variable "allow_registration" { type = bool }
variable "acm_certificate_arn" { type = string }
variable "alert_email" {
  description = "Email address to receive CloudWatch alarm notifications via SNS."
  type        = string
}
