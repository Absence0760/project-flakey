output "db_host" { value = aws_db_instance.main.address }
output "db_port" { value = aws_db_instance.main.port }
output "db_name" { value = aws_db_instance.main.db_name }
output "db_username" { value = aws_db_instance.main.username }

# Secrets Manager ARN of the AWS-managed master password. Wire this to
# the ECS task as DB_PASSWORD's `valueFrom` so the application reads
# the current rotated value. The secret stores a JSON object
# {"username":"...","password":"..."}; the task can read either field
# via the `:password::` JMESPath suffix.
output "master_user_secret_arn" {
  value = aws_db_instance.main.master_user_secret[0].secret_arn
}
