terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
      # The module receives two aws provider configurations from the caller:
      # the default (regional, ap-southeast-2) and an aws.us_east_1 alias
      # used to create the CloudFront WAFv2 web ACL.
      configuration_aliases = [aws.us_east_1]
    }
  }
}
