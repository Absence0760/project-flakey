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

# FLAKEY_ENCRYPTION_KEY — 32 raw bytes encoding integration secrets (Jira
# tokens, PagerDuty keys) at rest. The backend refuses to boot in production
# without it (index.ts). random_id.hex yields 64 lowercase hex chars = 32
# bytes, which crypto.ts's parseKey accepts via its /^[0-9a-f]{64}$/ branch.
resource "random_id" "encryption_key" {
  byte_length = 32
}

resource "aws_secretsmanager_secret" "encryption_key" {
  name                    = "${var.app_name}-${var.environment}/encryption-key"
  recovery_window_in_days = 7
  kms_key_id              = data.aws_kms_alias.secretsmanager.target_key_arn
}

resource "aws_secretsmanager_secret_version" "encryption_key" {
  secret_id     = aws_secretsmanager_secret.encryption_key.id
  secret_string = random_id.encryption_key.hex
}

# Dedicated password for the non-superuser app role (flakey_app). The app
# connects as flakey_app with this secret; entrypoint.sh ALTERs the role's
# password to match on boot. Kept separate from the RDS master secret so a
# leak of the app credential never also exposes the superuser (which bypasses
# RLS).
resource "random_password" "db_app" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "db_app_password" {
  name                    = "${var.app_name}-${var.environment}/db-app-password"
  recovery_window_in_days = 7
  kms_key_id              = data.aws_kms_alias.secretsmanager.target_key_arn
}

resource "aws_secretsmanager_secret_version" "db_app_password" {
  secret_id     = aws_secretsmanager_secret.db_app_password.id
  secret_string = random_password.db_app.result
}
