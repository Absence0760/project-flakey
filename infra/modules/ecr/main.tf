resource "aws_ecr_repository" "backend" {
  name = "${var.app_name}-backend"
  # MUTABLE because deploy.yml pushes a per-SHA tag AND retags `:latest`
  # on every release; switching to IMMUTABLE would block the second
  # `:latest` push. Trivy AWS-0031 is dismissed with this rationale -
  # tag overwrite by a release pipeline is the deploy contract here,
  # not an attack surface (the GitHub OIDC role gates who can push).
  image_tag_mutability = "MUTABLE"
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
