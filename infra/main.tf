module "networking" {
  source      = "./modules/networking"
  app_name    = var.app_name
  environment = var.environment
  aws_region  = var.aws_region
}

module "ecr" {
  source      = "./modules/ecr"
  app_name    = var.app_name
  environment = var.environment
}

module "s3" {
  source      = "./modules/s3"
  app_name    = var.app_name
  environment = var.environment
}

module "rds" {
  source            = "./modules/rds"
  app_name          = var.app_name
  environment       = var.environment
  vpc_id            = module.networking.vpc_id
  private_subnet_ids = module.networking.private_subnet_ids
  db_instance_class = var.db_instance_class
  db_password       = var.db_password
  ecs_security_group_id = module.ecs.ecs_security_group_id
}

module "ecs" {
  source              = "./modules/ecs"
  app_name            = var.app_name
  environment         = var.environment
  aws_region          = var.aws_region
  vpc_id              = module.networking.vpc_id
  public_subnet_ids   = module.networking.public_subnet_ids
  private_subnet_ids  = module.networking.private_subnet_ids
  backend_image       = "${module.ecr.backend_repository_url}:latest"
  frontend_url        = "https://${module.s3.cloudfront_domain}"
  db_host             = module.rds.db_host
  db_port             = module.rds.db_port
  db_name             = module.rds.db_name
  db_username         = module.rds.db_username
  db_password         = var.db_password
  jwt_secret          = var.jwt_secret
  s3_bucket           = module.s3.bucket_name
  allow_registration  = var.allow_registration
}
