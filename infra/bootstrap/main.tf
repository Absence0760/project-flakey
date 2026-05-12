terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.44" }
  }
}

provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}

variable "aws_region" {
  default = "ap-southeast-2"
}

variable "github_repo" {
  description = "GitHub repo in format org/repo"
  type        = string
}

variable "app_name" {
  default = "flakey"
}

# --- Terraform state backend ---

resource "aws_s3_bucket" "state" {
  bucket = "${var.app_name}-terraform-state"
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    # aws:kms with alias/aws/s3 - same rationale as the artifacts /
    # frontend buckets (resolves Trivy AWS-0132 without bringing the
    # cost / lifecycle of a CMK).
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = "alias/aws/s3"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_dynamodb_table" "locks" {
  name         = "${var.app_name}-terraform-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  # PITR for the locks table - recovery from accidental delete or a
  # rogue terraform run; the table is tiny so the cost is negligible.
  # Resolves Trivy AWS-0024.
  point_in_time_recovery {
    enabled = true
  }

  # AWS-managed DynamoDB key. Resolves Trivy AWS-0025 with the same
  # cost/audit-trail rationale as the S3 + Secrets Manager defaults.
  server_side_encryption {
    enabled     = true
    kms_key_arn = data.aws_kms_alias.dynamodb.target_key_arn
  }
}

data "aws_kms_alias" "dynamodb" {
  name = "alias/aws/dynamodb"
}

# --- GitHub OIDC ---

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
  ]
}

resource "aws_iam_role" "github_actions" {
  name = "${var.app_name}-github-actions"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:*"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "github_actions" {
  name = "${var.app_name}-github-actions-deploy"
  role = aws_iam_role.github_actions.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # GetAuthorizationToken genuinely requires Resource: "*" per ECR docs.
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        # Minimum ECR permissions for push/pull - no ecr:* wildcard.
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage",
        ]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["ecs:UpdateService", "ecs:DescribeServices"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:GetObject"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["cloudfront:CreateInvalidation"]
        Resource = "*"
      },
      {
        # Scope PassRole to ECS task/execution roles only.
        # The bootstrap module cannot directly reference the ECS module outputs
        # (separate Terraform root), so we use a naming-convention ARN pattern.
        # If the app_name or environment variable changes, update these ARNs.
        Effect = "Allow"
        Action = ["iam:PassRole"]
        Resource = [
          "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.app_name}-production-ecs-execution",
          "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.app_name}-production-ecs-task",
        ]
      }
    ]
  })
}

output "github_actions_role_arn" {
  value       = aws_iam_role.github_actions.arn
  description = "Add this as AWS_ROLE_ARN secret in GitHub"
}

output "state_bucket" {
  value = aws_s3_bucket.state.bucket
}
