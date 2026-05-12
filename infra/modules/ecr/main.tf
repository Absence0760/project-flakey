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
    # KMS-encrypted layers (defaults to the AWS-managed key for ECR).
    # Resolves Trivy AWS-0033 without bringing the cost / lifecycle of
    # a CMK.
    encryption_type = "KMS"
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
