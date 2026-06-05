output "jwt_secret" {
  value     = random_password.jwt.result
  sensitive = true
}

output "jwt_secret_arn" {
  value = aws_secretsmanager_secret.jwt_secret.arn
}

output "encryption_key_arn" {
  value = aws_secretsmanager_secret.encryption_key.arn
}

output "db_app_password_arn" {
  value = aws_secretsmanager_secret.db_app_password.arn
}
