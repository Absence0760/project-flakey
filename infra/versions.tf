terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.44"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
    # Optional: only exercised when var.sops_secrets_file is set (the opt-in
    # path that sources the app secrets from a sops-encrypted file instead of
    # generating them with random_*). `terraform init` downloads the plugin
    # either way, but the data source is count-gated to 0 when unused, so a
    # self-hoster who leaves sops off never invokes it. Pinned + hash-locked
    # in .terraform.lock.hcl since carlpett/sops is a community (non-HashiCorp)
    # provider.
    sops = {
      source  = "carlpett/sops"
      version = "~> 1.1"
    }
  }

  backend "s3" {
    bucket         = "flakey-terraform-state"
    key            = "infra/terraform.tfstate"
    region         = "ap-southeast-2"
    dynamodb_table = "flakey-terraform-locks"
    encrypt        = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    # Project MUST equal var.app_name: the bootstrap deploy role gates
    # cloudfront:CreateInvalidation on aws:ResourceTag/Project = app_name.
    # Hardcoding "flakey" here silently breaks every frontend cache
    # invalidation for any fork that picks a non-default app_name.
    tags = {
      Project     = var.app_name
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# Second provider pinned to us-east-1. WAFv2 web ACLs that attach to a
# CloudFront distribution must live in us-east-1 regardless of where
# the rest of the stack runs — CloudFront is a global service and only
# reads ACLs from that region.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project     = var.app_name
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
