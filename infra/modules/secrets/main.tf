resource "random_password" "db" {
  length  = 32
  special = false
}

resource "random_password" "jwt" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "db_password" {
  name                    = "${var.app_name}-${var.environment}/db-password"
  recovery_window_in_days = 7
  # AWS-managed Secrets Manager key (alias/aws/secretsmanager). Beats
  # the per-account "default key" since aws/secretsmanager has its own
  # CloudTrail data-plane logging. Resolves Trivy AWS-0098.
  kms_key_id = data.aws_kms_alias.secretsmanager.target_key_arn
}

resource "aws_secretsmanager_secret_version" "db_password" {
  secret_id     = aws_secretsmanager_secret.db_password.id
  secret_string = random_password.db.result
}

resource "aws_secretsmanager_secret" "jwt_secret" {
  name                    = "${var.app_name}-${var.environment}/jwt-secret"
  recovery_window_in_days = 7
  kms_key_id              = data.aws_kms_alias.secretsmanager.target_key_arn
}

data "aws_kms_alias" "secretsmanager" {
  name = "alias/aws/secretsmanager"
}

resource "aws_secretsmanager_secret_version" "jwt_secret" {
  secret_id     = aws_secretsmanager_secret.jwt_secret.id
  secret_string = random_password.jwt.result
}
