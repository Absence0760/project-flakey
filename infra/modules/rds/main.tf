resource "aws_db_subnet_group" "main" {
  name       = "${var.app_name}-${var.environment}-db"
  subnet_ids = var.private_subnet_ids
  tags       = { Name = "${var.app_name}-${var.environment}-db-subnet-group" }
}

resource "aws_security_group" "rds" {
  name_prefix = "${var.app_name}-${var.environment}-rds-"
  description = "RDS Postgres security group; ingress from the ECS task SG only, no outbound."
  vpc_id      = var.vpc_id

  ingress {
    description     = "Postgres from the ECS task SG (single source)."
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [var.ecs_security_group_id]
  }

  # No egress block - RDS does not initiate outbound connections, so the
  # implicit deny-all-egress is correct.  (Reviewers: removing the previous
  # 0.0.0.0/0 rule does not affect ECS-to-RDS traffic, which is governed by
  # the ingress rule above.)

  tags = { Name = "${var.app_name}-${var.environment}-rds-sg" }
}

resource "aws_db_instance" "main" {
  identifier            = "${var.app_name}-${var.environment}"
  engine                = "postgres"
  engine_version        = "16.4"
  instance_class        = var.db_instance_class
  allocated_storage     = 20
  max_allocated_storage = 100

  db_name  = "flakey"
  username = "flakey"
  # AWS-managed master password: RDS rotates and stores in Secrets
  # Manager automatically (alias/aws/secretsmanager). The application
  # reads the rotated value from `master_user_secret_arn`. Replaces a
  # static random_password that previously had no rotation policy.
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  backup_retention_period   = 7
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.app_name}-${var.environment}-final"
  deletion_protection       = true
  storage_encrypted         = true
  multi_az                  = var.rds_multi_az
  publicly_accessible       = false
  # IAM DB auth lets us issue short-lived auth tokens for break-glass
  # access without provisioning a long-lived password - see AWS-0176.
  iam_database_authentication_enabled = true
  # Performance Insights — cost-gated (~$7/mo on small instances).
  # When off, AWS-0133 (Trivy "missing Performance Insights") fires
  # again. Re-enable per-env via var.enable_performance_insights when
  # slow-query / lock-contention investigation is a regular need.
  performance_insights_enabled    = var.enable_performance_insights
  performance_insights_kms_key_id = var.enable_performance_insights ? data.aws_kms_alias.rds[0].target_key_arn : null

  tags = { Name = "${var.app_name}-${var.environment}-db" }
}

data "aws_kms_alias" "rds" {
  count = var.enable_performance_insights ? 1 : 0
  name  = "alias/aws/rds"
}
