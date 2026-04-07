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
