output "jwt_secret" {
  value     = random_password.jwt.result
  sensitive = true
}

output "jwt_secret_arn" {
  value = aws_secretsmanager_secret.jwt_secret.arn
}
