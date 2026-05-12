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
    tags = {
      Project     = "flakey"
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
      Project     = "flakey"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
