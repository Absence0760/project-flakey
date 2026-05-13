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

variable "environment" {
  description = "Environment suffix used in resource names the deploy role is allowed to touch. Bootstrap is run once per account; if you ever stand up a second env in the same account, re-apply with environment=staging (etc.) to widen the scope."
  type        = string
  default     = "production"
}

# Branches / tags that are allowed to assume the deploy role via the
# GitHub OIDC trust. deploy.yml fires on `release.published` (any
# tag) and `workflow_dispatch` (defaults to main on the default
# branch). Anything else — fork PRs, branch pushes, scheduled runs
# from feature branches — is denied at the trust level.
variable "github_deploy_subjects" {
  description = "List of token.actions.githubusercontent.com:sub patterns the deploy role accepts. Tightens OIDC trust from `repo:*:*` (any ref) to a deploy-only allow-list."
  type        = list(string)
  default = [
    "ref:refs/heads/main",
    "ref:refs/tags/*",
  ]
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

# State-bucket access logs land in a sibling logs bucket. The state
# bucket only sees terraform apply traffic, so this is mostly an
# audit trail rather than a high-volume firehose. Resolves AWS-0089.
resource "aws_s3_bucket" "state_logs" {
  bucket        = "${var.app_name}-terraform-state-logs"
  force_destroy = false
}

resource "aws_s3_bucket_versioning" "state_logs" {
  bucket = aws_s3_bucket.state_logs.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_ownership_controls" "state_logs" {
  bucket = aws_s3_bucket.state_logs.id
  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

resource "aws_s3_bucket_acl" "state_logs" {
  depends_on = [aws_s3_bucket_ownership_controls.state_logs]
  bucket     = aws_s3_bucket.state_logs.id
  acl        = "log-delivery-write"
}

resource "aws_s3_bucket_public_access_block" "state_logs" {
  bucket                  = aws_s3_bucket.state_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state_logs" {
  bucket = aws_s3_bucket.state_logs.id
  rule {
    # AES256, not aws:kms — see the matching note in modules/s3/main.tf
    # on aws_s3_bucket.logs: server-access-log delivery doesn't support
    # aws:kms-encrypted destinations.
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state_logs" {
  bucket = aws_s3_bucket.state_logs.id
  rule {
    id     = "expire-logs"
    status = "Enabled"
    expiration { days = 90 }
    filter {}
  }
}

resource "aws_s3_bucket_logging" "state" {
  bucket        = aws_s3_bucket.state.id
  target_bucket = aws_s3_bucket.state_logs.id
  target_prefix = "s3-access/state/"
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
        # Tighten OIDC trust to deploy-allowed refs only (default:
        # main + tags/*). Earlier `repo:${github_repo}:*` allowed any
        # branch / fork-PR / pull_request_target workflow to assume
        # the role. Override `github_deploy_subjects` if a second env
        # ever needs its own ref pattern.
        StringLike = {
          "token.actions.githubusercontent.com:sub" = [
            for s in var.github_deploy_subjects : "repo:${var.github_repo}:${s}"
          ]
        }
      }
    }]
  })
}

# Pre-computed ARNs for resources the deploy role is allowed to
# touch. Bootstrap cannot reference module outputs (separate TF
# root), so we mirror the naming convention used by the modules. If
# `var.app_name` or `var.environment` ever changes, both bootstrap
# and the matching module need to move together.
locals {
  account_id         = data.aws_caller_identity.current.account_id
  ecr_repo_arn       = "arn:aws:ecr:${var.aws_region}:${local.account_id}:repository/${var.app_name}-backend"
  ecs_cluster_arn    = "arn:aws:ecs:${var.aws_region}:${local.account_id}:cluster/${var.app_name}-${var.environment}"
  ecs_service_arn    = "arn:aws:ecs:${var.aws_region}:${local.account_id}:service/${var.app_name}-${var.environment}/${var.app_name}-${var.environment}-backend"
  ecs_taskdef_family = "arn:aws:ecs:${var.aws_region}:${local.account_id}:task-definition/${var.app_name}-${var.environment}-backend:*"
  s3_frontend_arn    = "arn:aws:s3:::${var.app_name}-${var.environment}-frontend"
  s3_artifacts_arn   = "arn:aws:s3:::${var.app_name}-${var.environment}-artifacts"
  iam_ecs_exec_arn   = "arn:aws:iam::${local.account_id}:role/${var.app_name}-${var.environment}-ecs-execution"
  iam_ecs_task_arn   = "arn:aws:iam::${local.account_id}:role/${var.app_name}-${var.environment}-ecs-task"
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
        # ECR push/pull narrowed to the project's single backend repo
        # — was Resource: "*" before, which allowed pushing to any
        # ECR repo in the account.
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
        Resource = local.ecr_repo_arn
      },
      {
        # ECS describe + register + roll-deploy narrowed to the
        # project's cluster, service, and task-definition family.
        # Was Resource: "*" before — allowed registering task defs
        # in any cluster in the account.
        # ListTaskDefinitions and DescribeTaskDefinition are
        # account-level reads; AWS doesn't support resource-level
        # scoping for them, so they stay on "*". The mutating actions
        # (RegisterTaskDefinition, UpdateService) are scoped.
        Effect = "Allow"
        Action = [
          "ecs:DescribeTaskDefinition",
          "ecs:ListTaskDefinitions",
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecs:UpdateService",
          "ecs:DescribeServices",
        ]
        Resource = local.ecs_service_arn
      },
      {
        # RegisterTaskDefinition is a Resource-* action by AWS API
        # design (you're creating a new revision, so the resource
        # doesn't exist yet) — gate via the `ecs:cluster` condition
        # instead.
        Effect   = "Allow"
        Action   = ["ecs:RegisterTaskDefinition"]
        Resource = "*"
        Condition = {
          ArnEquals = {
            "ecs:cluster" = local.ecs_cluster_arn
          }
        }
      },
      {
        # S3 narrowed to the project's frontend + artifacts buckets
        # — was Resource: "*", allowing PutObject/DeleteObject across
        # every bucket in the account.
        Effect = "Allow"
        Action = ["s3:PutObject", "s3:DeleteObject"]
        Resource = [
          "${local.s3_frontend_arn}/*",
          "${local.s3_artifacts_arn}/*",
        ]
      },
      {
        Effect = "Allow"
        Action = ["s3:ListBucket", "s3:GetObject", "s3:GetBucketLocation"]
        Resource = [
          local.s3_frontend_arn,
          "${local.s3_frontend_arn}/*",
          local.s3_artifacts_arn,
          "${local.s3_artifacts_arn}/*",
        ]
      },
      {
        # CloudFront CreateInvalidation doesn't support resource
        # ARNs that are predictable at bootstrap time (distribution
        # IDs are AWS-generated post-create), so scope by the
        # `Project` tag the provider's default_tags adds to every
        # resource in this account. Was Resource: "*".
        Effect   = "Allow"
        Action   = ["cloudfront:CreateInvalidation"]
        Resource = "*"
        Condition = {
          StringEquals = {
            "aws:ResourceTag/Project" = var.app_name
          }
        }
      },
      {
        # PassRole — already scoped (was the only correctly-scoped
        # statement in the old policy). Keep tight.
        Effect = "Allow"
        Action = ["iam:PassRole"]
        Resource = [
          local.iam_ecs_exec_arn,
          local.iam_ecs_task_arn,
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
