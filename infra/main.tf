module "networking" {
  source               = "./modules/networking"
  app_name             = var.app_name
  environment          = var.environment
  aws_region           = var.aws_region
  enable_vpc_endpoints = var.enable_vpc_endpoints
  enable_flow_logs     = var.enable_flow_logs
}

module "ecr" {
  source      = "./modules/ecr"
  app_name    = var.app_name
  environment = var.environment
}

# Opt-in: source the three app secrets from a sops-encrypted file instead of
# generating them. Count-gated to 0 when var.sops_secrets_file is empty (the
# default), so a self-hoster who doesn't use sops never invokes the provider.
# Decryption happens in-memory at plan/apply via the AWS credential chain —
# nothing is written to disk. The encrypted file lives in the private
# infra-secrets repo; see docs/operations/secrets-sops.md.
data "sops_file" "secrets" {
  count       = var.sops_secrets_file != "" ? 1 : 0
  source_file = var.sops_secrets_file
}

locals {
  # Flat top-level keys only — sops flattens nested maps into dotted keys.
  sops_secrets = var.sops_secrets_file != "" ? data.sops_file.secrets[0].data : {}
}

module "secrets" {
  source      = "./modules/secrets"
  app_name    = var.app_name
  environment = var.environment
  # Empty string ⇒ the module generates the secret with random_* (default).
  jwt_secret_override      = try(local.sops_secrets["jwt_secret"], "")
  encryption_key_override  = try(local.sops_secrets["encryption_key"], "")
  db_app_password_override = try(local.sops_secrets["db_app_password"], "")
}

module "s3" {
  source          = "./modules/s3"
  app_name        = var.app_name
  environment     = var.environment
  enable_waf      = var.enable_waf
  csp_connect_src = var.csp_connect_src
  # img-src/media-src default to the connect-src origin inside the module
  # (artifacts served from the API origin in the standard deploy); set these
  # only when artifacts live elsewhere.
  csp_img_src                    = var.csp_img_src
  csp_media_src                  = var.csp_media_src
  cloudfront_acm_certificate_arn = var.cloudfront_acm_certificate_arn
  cloudfront_aliases             = var.cloudfront_aliases
  artifact_retention_days        = var.artifact_retention_days
  artifact_ia_transition_days    = var.artifact_ia_transition_days
  # CloudFront WAFv2 must be created in us-east-1; pass the aliased
  # provider in via the `aws.us_east_1` configuration alias the module
  # declares in its required_providers block.
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }
}

module "rds" {
  source                      = "./modules/rds"
  app_name                    = var.app_name
  environment                 = var.environment
  vpc_id                      = module.networking.vpc_id
  private_subnet_ids          = module.networking.private_subnet_ids
  db_instance_class           = var.db_instance_class
  ecs_security_group_id       = module.ecs.ecs_security_group_id
  enable_performance_insights = var.enable_performance_insights
  rds_multi_az                = var.rds_multi_az
  alerts_topic_arn            = module.ecs.alerts_topic_arn
}

module "budget" {
  source             = "./modules/budget"
  app_name           = var.app_name
  environment        = var.environment
  budget_limit       = var.budget_limit
  budget_alert_email = var.budget_alert_email
}

module "ecs" {
  source             = "./modules/ecs"
  app_name           = var.app_name
  environment        = var.environment
  aws_region         = var.aws_region
  vpc_id             = module.networking.vpc_id
  vpc_cidr           = module.networking.vpc_cidr
  public_subnet_ids  = module.networking.public_subnet_ids
  private_subnet_ids = module.networking.private_subnet_ids
  backend_image      = "${module.ecr.backend_repository_url}:latest"
  # CORS_ORIGINS + FRONTEND_URL must match the origin the browser actually
  # loads the SPA from. module.s3.cloudfront_domain is the *.cloudfront.net
  # name; when the dashboard is served from a custom domain (cloudfront_aliases)
  # the browser's Origin header is that alias, so default the API's allowed
  # origin to public_app_url when set, falling back to the CloudFront domain.
  frontend_url        = var.public_app_url != "" ? var.public_app_url : "https://${module.s3.cloudfront_domain}"
  db_host             = module.rds.db_host
  db_port             = module.rds.db_port
  db_name             = module.rds.db_name
  db_username         = module.rds.db_username
  db_password_arn     = module.rds.master_user_secret_arn
  db_app_password_arn = module.secrets.db_app_password_arn
  jwt_secret_arn      = module.secrets.jwt_secret_arn
  encryption_key_arn  = module.secrets.encryption_key_arn
  s3_bucket           = module.s3.bucket_name
  allow_registration  = var.allow_registration
  acm_certificate_arn = var.acm_certificate_arn
  alert_email         = var.budget_alert_email
  cpu_architecture    = var.cpu_architecture
}
