variable "app_name" {
  type = string
}

variable "environment" {
  type = string
}

variable "budget_limit" {
  description = "Monthly budget limit in USD"
  type        = string
}

variable "budget_alert_email" {
  description = "Email address for budget alerts"
  type        = string
}
