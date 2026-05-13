variable "app_name" { type = string }
variable "environment" { type = string }
variable "vpc_id" { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "db_instance_class" { type = string }
variable "ecs_security_group_id" { type = string }
variable "rds_multi_az" {
  description = "Enable Multi-AZ RDS deployment. Recommended true for production."
  type        = bool
  default     = true
}
variable "enable_performance_insights" {
  description = "Enable RDS Performance Insights with the AWS-managed RDS KMS key. ~$7/mo on a small instance."
  type        = bool
  default     = false
}
variable "alerts_topic_arn" {
  description = "SNS topic ARN for CloudWatch alarms (CPU, free storage, connections). Wired from module.ecs.alerts_topic_arn so DB alarms land in the same email subscription as ALB alarms."
  type        = string
}
