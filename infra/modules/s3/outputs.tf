output "bucket_name" { value = aws_s3_bucket.artifacts.bucket }
output "bucket_arn" { value = aws_s3_bucket.artifacts.arn }
output "frontend_bucket_name" { value = aws_s3_bucket.frontend.bucket }
output "cloudfront_domain" { value = aws_cloudfront_distribution.frontend.domain_name }
output "cloudfront_distribution_id" { value = aws_cloudfront_distribution.frontend.id }
# Exposed for tests/csp.tftest.hcl (and handy for debugging the deployed
# header) — the full Content-Security-Policy string applied at CloudFront.
output "csp" { value = local.csp }
