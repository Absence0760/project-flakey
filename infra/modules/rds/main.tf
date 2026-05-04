resource "aws_db_subnet_group" "main" {
  name       = "${var.app_name}-${var.environment}-db"
  subnet_ids = var.private_subnet_ids
  tags       = { Name = "${var.app_name}-${var.environment}-db-subnet-group" }
}

resource "aws_security_group" "rds" {
  name_prefix = "${var.app_name}-${var.environment}-rds-"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [var.ecs_security_group_id]
  }

  # No egress block — RDS does not initiate outbound connections, so the
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
  password = var.db_password

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  backup_retention_period   = 7
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.app_name}-${var.environment}-final"
  deletion_protection       = true
  storage_encrypted         = true
  multi_az                  = var.rds_multi_az
  publicly_accessible       = false

  tags = { Name = "${var.app_name}-${var.environment}-db" }
}
