# ECS Cluster
resource "aws_ecs_cluster" "main" {
  name = "${var.app_name}-${var.environment}"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# IAM - Execution role (pull images, read secrets)
resource "aws_iam_role" "ecs_execution" {
  name = "${var.app_name}-${var.environment}-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "ecs_execution_secrets" {
  name = "${var.app_name}-${var.environment}-secrets-access"
  role = aws_iam_role.ecs_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action   = ["secretsmanager:GetSecretValue"]
      Effect   = "Allow"
      Resource = [var.db_password_arn, var.jwt_secret_arn]
    }]
  })
}

# IAM - Task role (S3 access at runtime)
resource "aws_iam_role" "ecs_task" {
  name = "${var.app_name}-${var.environment}-ecs-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "ecs_task_s3" {
  name = "${var.app_name}-${var.environment}-s3-access"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
      Effect   = "Allow"
      Resource = ["arn:aws:s3:::${var.s3_bucket}", "arn:aws:s3:::${var.s3_bucket}/*"]
    }]
  })
}

# CloudWatch
resource "aws_cloudwatch_log_group" "backend" {
  name              = "/ecs/${var.app_name}-${var.environment}/backend"
  retention_in_days = 30
  # CloudWatch Logs are server-side encrypted by default with an
  # AWS-owned key. Use the AWS-managed key for the account so log data
  # is protected by a key whose audit trail we own (resolves AWS-0017
  # without bringing the cost / lifecycle of a CMK).
  kms_key_id = data.aws_kms_alias.cloudwatch.target_key_arn
}

data "aws_kms_alias" "cloudwatch" {
  name = "alias/aws/logs"
}

# Security groups
resource "aws_security_group" "alb" {
  name_prefix = "${var.app_name}-${var.environment}-alb-"
  description = "Internet-facing ALB for the Flakey API; allows 80/443 in from anywhere, forwards to the ECS target group on TCP 3000."
  vpc_id      = var.vpc_id

  ingress {
    description = "Inbound HTTP from the public internet - redirected to HTTPS by aws_lb_listener.http."
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "Inbound HTTPS from the public internet - terminated at the ALB, forwarded to ECS over HTTP/3000 inside the VPC."
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Egress is declared as a standalone aws_security_group_rule below so
  # the ALB SG can reference the ECS SG without a create-time cycle
  # (ECS SG already references ALB SG for ingress).

  tags = { Name = "${var.app_name}-${var.environment}-alb-sg" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group_rule" "alb_to_ecs_egress" {
  description              = "ALB to ECS task egress on TCP/3000 (single hop inside the VPC)."
  type                     = "egress"
  from_port                = 3000
  to_port                  = 3000
  protocol                 = "tcp"
  security_group_id        = aws_security_group.alb.id
  source_security_group_id = aws_security_group.ecs.id
}

resource "aws_security_group" "ecs" {
  name_prefix = "${var.app_name}-${var.environment}-ecs-"
  description = "ECS task security group for the Flakey backend; ingress from the ALB on the container port, narrowed egress for AWS API + DNS only."
  vpc_id      = var.vpc_id

  ingress {
    description     = "From ALB on the container port. ALB SG is the only allowed source."
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    description = "Outbound HTTPS for AWS APIs (ECR pull, Secrets Manager, S3, CloudWatch Logs) and any third-party HTTPS the backend needs (Jira, PagerDuty, GitHub, etc.)."
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Outbound DNS so VPC resolver lookups + DoT egress work for the AWS API endpoints above."
    from_port   = 53
    to_port     = 53
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    # Hard-coded 5432 (not var.db_port from the RDS output) to avoid a
    # cycle: rds depends on ecs_security_group_id, and pulling
    # db_port back into the ECS SG would close the loop. Postgres is
    # the only engine here and 5432 is its fixed default.
    description = "Outbound to RDS Postgres on the private subnet - explicit cidr keeps this VPC-local."
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    description = "Outbound SMTP (587) for transactional email + scheduled reports."
    from_port   = 587
    to_port     = 587
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.app_name}-${var.environment}-ecs-sg" }
}

# ALB
resource "aws_lb" "main" {
  name               = "${var.app_name}-${var.environment}"
  internal           = false # Internet-facing by design - fronts the public Flakey API.
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.public_subnet_ids
  # Drop ambiguous / smuggling-prone headers (multiple Content-Length,
  # whitespace before colons, etc.) before they reach the targets.
  # Resolves Trivy AWS-0052.
  drop_invalid_header_fields = true

  tags = { Name = "${var.app_name}-${var.environment}-alb" }
}

resource "aws_lb_target_group" "backend" {
  name        = "${var.app_name}-${var.environment}-api"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    path                = "/health"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.backend.arn
  }
}

# Task definition - secrets via Secrets Manager, not plaintext
#
# The image tag here is the bootstrap value used when Terraform first
# creates the task definition. deploy.yml registers a NEW task
# definition revision on every release (with the per-SHA image URI) and
# tells ECS to roll the service onto it. The lifecycle.ignore_changes
# below stops `terraform apply` from clobbering whichever revision
# deploy.yml most recently rolled to, so the two control planes don't
# fight over container_definitions.
resource "aws_ecs_task_definition" "backend" {
  family                   = "${var.app_name}-${var.environment}-backend"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  # Graviton (ARM64) Fargate is ~20% cheaper for Node workloads. The
  # deploy pipeline pushes a linux/arm64 image to match (see
  # deploy.yml's docker buildx invocation). Flip to X86_64 via
  # var.cpu_architecture if some native dependency loses ARM support.
  runtime_platform {
    cpu_architecture        = var.cpu_architecture
    operating_system_family = "LINUX"
  }

  lifecycle {
    ignore_changes = [container_definitions]
  }

  container_definitions = jsonencode([{
    name      = "backend"
    image     = var.backend_image
    essential = true

    portMappings = [{
      containerPort = 3000
      protocol      = "tcp"
    }]

    environment = [
      { name = "PORT", value = "3000" },
      { name = "NODE_ENV", value = "production" },
      { name = "DB_HOST", value = var.db_host },
      { name = "DB_PORT", value = tostring(var.db_port) },
      { name = "DB_NAME", value = var.db_name },
      { name = "DB_USER", value = "flakey_app" },
      { name = "DB_MIGRATION_USER", value = var.db_username },
      { name = "CORS_ORIGINS", value = var.frontend_url },
      { name = "FRONTEND_URL", value = var.frontend_url },
      { name = "ALLOW_REGISTRATION", value = tostring(var.allow_registration) },
      { name = "STORAGE", value = "s3" },
      { name = "S3_BUCKET", value = var.s3_bucket },
      { name = "S3_REGION", value = var.aws_region },
    ]

    secrets = [
      # `:password::` is the JMESPath fragment that plucks the `password`
      # key out of the RDS-managed master secret JSON
      # ({"username":"...","password":"..."}). The DB_USER env var above
      # is the read/write app role, distinct from the master user.
      { name = "DB_PASSWORD", valueFrom = "${var.db_password_arn}:password::" },
      { name = "DB_MIGRATION_PASSWORD", valueFrom = "${var.db_password_arn}:password::" },
      { name = "JWT_SECRET", valueFrom = var.jwt_secret_arn },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.backend.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "backend"
      }
    }
  }])
}

# ECS Service
resource "aws_ecs_service" "backend" {
  name            = "${var.app_name}-${var.environment}-backend"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.backend.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.backend.arn
    container_name   = "backend"
    container_port   = 3000
  }

  depends_on = [aws_lb_listener.https]
}

# --- Auto-scaling ---
resource "aws_appautoscaling_target" "backend" {
  max_capacity       = 4
  min_capacity       = 1
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.backend.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "backend_cpu" {
  name               = "${var.app_name}-${var.environment}-cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.backend.resource_id
  scalable_dimension = aws_appautoscaling_target.backend.scalable_dimension
  service_namespace  = aws_appautoscaling_target.backend.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 70.0
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

data "aws_caller_identity" "current" {}

# --- Monitoring & alerts ---
#
# Customer-managed KMS key for the alerts SNS topic. Trivy AWS-0136
# requires a CMK rather than the AWS-managed alias/aws/sns — the audit
# trail (key-policy + CloudTrail) is account-local rather than shared
# across every AWS-managed-key user. ~$1/month per CMK; alarm volume
# keeps API-call charges negligible.
#
# Key policy grants:
#   - account root: full kms:* (the standard "let IAM manage it" grant)
#   - cloudwatch.amazonaws.com: Decrypt + GenerateDataKey so CloudWatch
#     Alarms can publish encrypted notifications to the topic.
resource "aws_kms_key" "alerts" {
  description             = "${var.app_name}-${var.environment} CMK for SNS alerts topic"
  deletion_window_in_days = 7
  enable_key_rotation     = true
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "EnableRootAccess"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "CloudWatchAlarmsPublish"
        Effect    = "Allow"
        Principal = { Service = "cloudwatch.amazonaws.com" }
        Action    = ["kms:Decrypt", "kms:GenerateDataKey*"]
        Resource  = "*"
      },
    ]
  })
}

resource "aws_kms_alias" "alerts" {
  name          = "alias/${var.app_name}-${var.environment}-alerts"
  target_key_id = aws_kms_key.alerts.key_id
}

resource "aws_sns_topic" "alerts" {
  name = "${var.app_name}-${var.environment}-alerts"
  # CMK reference (full ARN, not the alias). Resolves Trivy AWS-0136
  # (CMK preferred over AWS-managed alias/aws/sns from AWS-0095).
  kms_master_key_id = aws_kms_key.alerts.arn
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_hosts" {
  alarm_name          = "${var.app_name}-${var.environment}-unhealthy-hosts"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "UnHealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  alarm_actions       = [aws_sns_topic.alerts.arn]
  dimensions = {
    TargetGroup  = aws_lb_target_group.backend.arn_suffix
    LoadBalancer = aws_lb.main.arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "high_5xx" {
  alarm_name          = "${var.app_name}-${var.environment}-5xx-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 300
  statistic           = "Sum"
  threshold           = 10
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
  }
}

resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}
