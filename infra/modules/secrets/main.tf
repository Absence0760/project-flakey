resource "random_password" "jwt" {
  length  = 64
  special = false
}

# Note: db_password is no longer managed here. RDS now uses
# `manage_master_user_password = true` and emits its own rotated
# secret — see modules/rds/outputs.tf:master_user_secret_arn.

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
