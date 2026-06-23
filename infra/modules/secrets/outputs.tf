# Only ARNs are exported: the ECS task reads each secret's *value* from
# Secrets Manager at runtime via valueFrom, so Terraform never needs to
# hand the plaintext to a consumer. Exporting the raw value as an output
# put a second plaintext copy in state for no consumer — removed.
output "jwt_secret_arn" {
  value = aws_secretsmanager_secret.jwt_secret.arn
}

output "encryption_key_arn" {
  value = aws_secretsmanager_secret.encryption_key.arn
}

output "db_app_password_arn" {
  value = aws_secretsmanager_secret.db_app_password.arn
}
