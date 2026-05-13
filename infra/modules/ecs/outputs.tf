output "alb_dns_name" { value = aws_lb.main.dns_name }
output "ecs_security_group_id" { value = aws_security_group.ecs.id }
# SNS topic for cross-module alarms (RDS reuses this so all alerts
# land in the same email subscription).
output "alerts_topic_arn" { value = aws_sns_topic.alerts.arn }
