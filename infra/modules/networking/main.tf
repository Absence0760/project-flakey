data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = { Name = "${var.app_name}-${var.environment}-vpc" }
}

# VPC Flow Logs - captures REJECT traffic to a CloudWatch log group so
# unexpected egress / ingress is forensically auditable. Resolves
# Trivy AWS-0178. REJECT-only keeps the log volume bounded.
#
# Cost-gated: ~$5-15/mo at low volume on top of the CloudWatch log
# group + KMS API charges. Off by default; flip via
# var.enable_flow_logs when a security-investigation cadence
# justifies it.
resource "aws_cloudwatch_log_group" "vpc_flow" {
  count             = var.enable_flow_logs ? 1 : 0
  name              = "/vpc/${var.app_name}-${var.environment}/flow"
  retention_in_days = 30
  kms_key_id        = data.aws_kms_alias.cloudwatch[0].target_key_arn
}

data "aws_kms_alias" "cloudwatch" {
  count = var.enable_flow_logs ? 1 : 0
  name  = "alias/aws/logs"
}

resource "aws_iam_role" "vpc_flow" {
  count = var.enable_flow_logs ? 1 : 0
  name  = "${var.app_name}-${var.environment}-vpc-flow-logs"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "vpc_flow" {
  count = var.enable_flow_logs ? 1 : 0
  role  = aws_iam_role.vpc_flow[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams",
      ]
      Resource = "${aws_cloudwatch_log_group.vpc_flow[0].arn}:*"
    }]
  })
}

resource "aws_flow_log" "main" {
  count                = var.enable_flow_logs ? 1 : 0
  iam_role_arn         = aws_iam_role.vpc_flow[0].arn
  log_destination      = aws_cloudwatch_log_group.vpc_flow[0].arn
  log_destination_type = "cloud-watch-logs"
  traffic_type         = "REJECT"
  vpc_id               = aws_vpc.main.id
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.app_name}-${var.environment}-igw" }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.${count.index + 1}.0/24"
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = { Name = "${var.app_name}-${var.environment}-public-${count.index + 1}" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.${count.index + 10}.0/24"
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = { Name = "${var.app_name}-${var.environment}-private-${count.index + 1}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.app_name}-${var.environment}-public-rt" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# NAT gateway for private subnets (ECS tasks need outbound internet)
resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${var.app_name}-${var.environment}-nat-eip" }
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = "${var.app_name}-${var.environment}-nat" }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.app_name}-${var.environment}-private-rt" }
}

resource "aws_route" "private_nat" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main.id
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# ─── VPC endpoints ─────────────────────────────────────────────────────
#
# Route AWS-API traffic from the ECS tasks privately to the AWS
# backbone instead of out through the NAT gateway and back in over the
# public internet. Three wins:
#
#   1. Latency (NAT GW + public hop is replaced by a private ENI hop).
#   2. NAT data-processing cost ($0.045/GB) drops for the AWS-API
#      portion of the traffic; ECR image pulls in particular are the
#      biggest line item on this stack.
#   3. Surface area: the ECS SG's 443 egress no longer has to reach
#      every AWS-region IP block for these services. The residual 443
#      egress is the third-party webhook / GitHub / Jira / PagerDuty
#      traffic that has to stay open (tenant-configured destinations).
#
# S3 is a Gateway endpoint — free, attached to the private route
# table directly. The others are Interface endpoints — they create
# ENIs in each private subnet ($0.01/AZ/hr per endpoint, ~$7/AZ/month
# at usage, plus $0.01/GB through them which is cheaper than NAT).

# Cost-gated: 5 Interface endpoints × 2 AZs = ~$72/mo, net win only
# when NAT data charges exceed ~1.5 TB/mo of AWS-API traffic. Off by
# default; flip via var.enable_vpc_endpoints when traffic justifies.
resource "aws_security_group" "vpc_endpoints" {
  count       = var.enable_vpc_endpoints ? 1 : 0
  name_prefix = "${var.app_name}-${var.environment}-vpce-"
  description = "Allow HTTPS from inside the VPC to the AWS API VPC endpoints."
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "TLS from anything in the VPC (ECS tasks, RDS clients, etc.)."
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.main.cidr_block]
  }

  egress {
    description = "Replies on ephemeral ports back into the VPC."
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [aws_vpc.main.cidr_block]
  }

  tags = { Name = "${var.app_name}-${var.environment}-vpce-sg" }
}

# S3 Gateway endpoint — free. Gated alongside the Interface endpoints
# (it's nominally free, but on its own the gateway endpoint without
# interface endpoints for the other services makes the bill split
# confusing; toggle them together).
resource "aws_vpc_endpoint" "s3" {
  count             = var.enable_vpc_endpoints ? 1 : 0
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]

  tags = { Name = "${var.app_name}-${var.environment}-s3-endpoint" }
}

locals {
  interface_endpoints = var.enable_vpc_endpoints ? toset([
    # ECR pull path: both api + dkr endpoints are required for
    # `docker pull <accountId>.dkr.ecr.${region}.amazonaws.com/<image>`
    # to succeed without leaving the VPC.
    "ecr.api",
    "ecr.dkr",
    # Backend reads JWT_SECRET + DB_PASSWORD on container start.
    "secretsmanager",
    # awslogs log driver streams stdout/stderr to CloudWatch.
    "logs",
    # IAM auth for RDS (when iam_database_authentication_enabled fires
    # the connect path) uses STS to generate the auth token.
    "sts",
  ]) : toset([])
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = local.interface_endpoints
  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.aws_region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.vpc_endpoints[0].id]
  private_dns_enabled = true

  tags = { Name = "${var.app_name}-${var.environment}-${replace(each.key, ".", "-")}-endpoint" }
}
