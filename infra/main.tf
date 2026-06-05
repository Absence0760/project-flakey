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

module "secrets" {
  source      = "./modules/secrets"
  app_name    = var.app_name
  environment = var.environment
}

module "s3" {
  source                         = "./modules/s3"
  app_name                       = var.app_name
  environment                    = var.environment
  enable_waf                     = var.enable_waf
  csp_connect_src                = var.csp_connect_src
  cloudfront_acm_certificate_arn = var.cloudfront_acm_certificate_arn
  cloudfront_aliases             = var.cloudfront_aliases
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
  source              = "./modules/ecs"
  app_name            = var.app_name
  environment         = var.environment
  aws_region          = var.aws_region
  vpc_id              = module.networking.vpc_id
  vpc_cidr            = module.networking.vpc_cidr
  public_subnet_ids   = module.networking.public_subnet_ids
  private_subnet_ids  = module.networking.private_subnet_ids
  backend_image       = "${module.ecr.backend_repository_url}:latest"
  frontend_url        = "https://${module.s3.cloudfront_domain}"
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
