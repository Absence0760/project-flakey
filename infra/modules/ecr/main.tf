data "aws_caller_identity" "current" {}

# Customer-managed KMS key for ECR image-layer encryption. Trivy
# AWS-0033 wanted a CMK; the AWS-managed alias/aws/ecr earlier got us
# partway there but Trivy still flagged "not a CMK". ~$1/month per key.
resource "aws_kms_key" "ecr" {
  description             = "${var.app_name} CMK for ECR image-layer encryption"
  deletion_window_in_days = 7
  enable_key_rotation     = true
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "EnableRootAccess"
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }
      Action    = "kms:*"
      Resource  = "*"
    }]
  })
}

resource "aws_kms_alias" "ecr" {
  name          = "alias/${var.app_name}-ecr"
  target_key_id = aws_kms_key.ecr.key_id
}

resource "aws_ecr_repository" "backend" {
  name = "${var.app_name}-backend"
  # IMMUTABLE prevents a compromised OIDC role from overwriting an
  # already-deployed image digest under an existing tag. deploy.yml is
  # paired with this: it pushes a single per-SHA tag (never the same
  # tag twice) and the ECS task definition is updated out-of-band via
  # register-task-definition with the SHA image URI. Resolves AWS-0031.
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.ecr.arn
  }
}

resource "aws_ecr_lifecycle_policy" "backend" {
  repository = aws_ecr_repository.backend.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images beyond 20"
        selection = {
          tagStatus   = "untagged"
          countType   = "imageCountMoreThan"
          countNumber = 20
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep last 10 semver-tagged release images"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["v*"]
          countType      = "imageCountMoreThan"
          countNumber    = 10
        }
        action = { type = "expire" }
      }
    ]
  })
}
