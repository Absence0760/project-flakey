output "alb_dns_name" {
  description = "ALB DNS name — use this to access the app"
  value       = module.ecs.alb_dns_name
}

output "backend_ecr_url" {
  description = "ECR repository URL for backend"
  value       = module.ecr.backend_repository_url
}

output "frontend_url" {
  description = "CloudFront URL for the frontend"
  value       = "https://${module.s3.cloudfront_domain}"
}

output "frontend_bucket" {
  description = "S3 bucket for frontend static files"
  value       = module.s3.frontend_bucket_name
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID (for cache invalidation)"
  value       = module.s3.cloudfront_distribution_id
}

output "s3_bucket" {
  description = "S3 bucket for artifacts"
  value       = module.s3.bucket_name
}

output "db_host" {
  description = "RDS endpoint"
  value       = module.rds.db_host
  sensitive   = true
}
