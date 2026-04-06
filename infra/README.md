# Flakey — AWS Infrastructure

Terraform configuration for deploying Flakey to AWS.

## Architecture

```
                    Internet
                       │
              ┌────────┴────────┐
              │                 │
        CloudFront (HTTPS)   ALB (HTTP)
              │                 │
        S3 (frontend)    ECS Fargate (backend)
        static files          │
                         RDS PostgreSQL
                              │
                         S3 (artifacts)
```

- **Frontend** — Static files in S3, served via CloudFront CDN with HTTPS
- **Backend** — ECS Fargate container (512 CPU, 1GB RAM)
- **Database** — RDS PostgreSQL 16 (db.t4g.micro, encrypted, 7-day backups)
- **Artifacts** — S3 bucket for screenshots, videos, snapshots (encrypted, lifecycle policies)
- **Networking** — VPC with 2 public subnets (ALB), 2 private subnets (ECS, RDS), NAT gateway

## Prerequisites

1. AWS CLI configured with credentials
2. Terraform >= 1.5
3. Create S3 bucket and DynamoDB table for Terraform state:

```bash
aws s3 mb s3://flakey-terraform-state --region ap-southeast-2

aws dynamodb create-table \
  --table-name flakey-terraform-locks \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region ap-southeast-2
```

## Setup

### 1. Configure variables

```bash
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars — set db_password and jwt_secret
```

### 2. Initialize and deploy

```bash
cd infra
terraform init
terraform plan
terraform apply
```

### 3. Run database migrations

Connect to RDS and run all migrations in order:

```bash
PGHOST=$(terraform output -raw db_host) \
PGUSER=flakey PGPASSWORD=<your-password> PGDATABASE=flakey \
psql -f ../backend/migrations/001_initial.sql

# Repeat for all migration files (002 through 009)
```

### 4. Get Terraform outputs

After `terraform apply`, get the values you'll need:

```bash
terraform output alb_dns_name              # Backend API URL
terraform output frontend_url              # Frontend URL (CloudFront)
terraform output frontend_bucket           # S3 bucket name for frontend
terraform output cloudfront_distribution_id # For cache invalidation
terraform output -raw db_host              # RDS endpoint (sensitive)
```

### 5. Set up GitHub Actions

Add these secrets to your GitHub repository (Settings > Secrets > Actions):

| Secret | Value | How to get it |
|---|---|---|
| `AWS_ROLE_ARN` | IAM role ARN for GitHub OIDC | Create in AWS IAM (see below) |
| `API_URL` | `http://<alb-dns>` | `terraform output alb_dns_name` |
| `FRONTEND_BUCKET` | S3 bucket name | `terraform output frontend_bucket` |
| `CLOUDFRONT_DISTRIBUTION_ID` | CloudFront dist ID | `terraform output cloudfront_distribution_id` |
| `NPM_TOKEN` | npm access token | https://www.npmjs.com/settings/tokens |

### 6. Deploy

Push to `main` — GitHub Actions will:
- Build backend Docker image → push to ECR → deploy to ECS
- Build frontend static files → sync to S3 → invalidate CloudFront cache

```bash
git push origin main
```

### 7. Access the app

```bash
terraform output frontend_url    # Frontend (CloudFront)
terraform output alb_dns_name    # Backend API (ALB)
```

## Environment Variables

### What you configure (in `terraform.tfvars`)

| Variable | How to generate |
|---|---|
| `db_password` | `openssl rand -base64 24` |
| `jwt_secret` | `openssl rand -hex 32` |
| `allow_registration` | `false` for invite-only, `true` for open |

### What Terraform handles automatically

These are injected into the ECS task definition — you don't set them manually:

| Env Var | Value | Source |
|---|---|---|
| `DB_HOST` | RDS endpoint | `module.rds.db_host` |
| `DB_PORT` | `5432` | `module.rds.db_port` |
| `DB_NAME` | `flakey` | `module.rds.db_name` |
| `DB_USER` | `flakey_app` | Hardcoded (created by migration) |
| `DB_PASSWORD` | From tfvars | `var.db_password` |
| `JWT_SECRET` | From tfvars | `var.jwt_secret` |
| `NODE_ENV` | `production` | Hardcoded |
| `PORT` | `3000` | Hardcoded |
| `CORS_ORIGINS` | CloudFront URL | `module.s3.cloudfront_domain` |
| `ALLOW_REGISTRATION` | From tfvars | `var.allow_registration` |

### Frontend (build-time)

Set `VITE_API_URL` as the GitHub Actions secret `API_URL`. It's baked into the static build.

### CLI (for uploading results)

Users set these in their CI pipeline or locally:

| Env Var | How to get |
|---|---|
| `FLAKEY_API_URL` | `terraform output alb_dns_name` (prefix with `http://`) |
| `FLAKEY_API_KEY` | Create in the app: Profile > API Keys |

### Local development

For local dev, copy the `.env.example` files — no changes needed:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
cp cli/.env.example cli/.env
```

The defaults connect to the Docker Compose PostgreSQL and use localhost ports.

## CI/CD Pipelines

| Workflow | Triggers on | What it does |
|---|---|---|
| `deploy.yml` | `backend/**` or `frontend/**` changes | Backend: Docker → ECR → ECS. Frontend: build → S3 → CloudFront |
| `publish.yml` | `cli/**` or `packages/**` changes | Publishes npm packages (`@flakey/cli`, `@flakey/cypress-snapshots`) |

Both workflows use `dorny/paths-filter` to only build what changed.

## Estimated Cost

| Resource | Monthly Cost |
|---|---|
| RDS db.t4g.micro | ~$15 |
| ECS Fargate (1 task) | ~$10 |
| NAT Gateway | ~$30 |
| ALB | ~$16 |
| S3 + CloudFront | ~$1 |
| **Total** | **~$72/month** |

### Reducing costs

- Replace NAT Gateway with a NAT Instance (~$4/month, saves ~$26)
- Use ECS on EC2 spot instances instead of Fargate
- Single EC2 instance with Docker Compose + Caddy for HTTPS (~$10/month total)

## Adding a custom domain

1. Register or transfer your domain to Route53
2. Request an ACM certificate (us-east-1 for CloudFront, your region for ALB)
3. Add the certificate ARN to the CloudFront distribution and ALB listener
4. Create Route53 alias records pointing to CloudFront and ALB

## Terraform modules

| Module | Resources |
|---|---|
| `networking` | VPC, subnets, IGW, NAT gateway, route tables |
| `ecr` | Backend ECR repository with lifecycle policy |
| `s3` | Artifacts bucket + frontend static hosting bucket + CloudFront CDN |
| `rds` | PostgreSQL 16 instance, security group, subnet group |
| `ecs` | Fargate cluster, task definition, service, ALB, IAM roles, CloudWatch logs |
