#!/usr/bin/env bash
#
# seed-first-image.sh — build + push the first backend image and roll the
# ECS service onto it.
#
# WHY THIS EXISTS
# ---------------
# `infra/main.tf` registers the ECS task definition pointing at
# `<ecr-repo>:latest`. The ECR repo is IMMUTABLE and the deploy pipeline
# (`.github/workflows/deploy.yml`) only ever pushes a per-SHA tag — it never
# pushes `:latest`. So on a brand-new account, the very first `terraform apply`
# creates a service whose task can't pull an image: ECS sits in a
# CannotPullContainerError loop and the unhealthy-host alarm fires, with nothing
# in the docs explaining the noise. It self-heals on the first GitHub release,
# but the window between "apply" and "first release" is ugly.
#
# This script closes that window: run it once, right after the first
# `terraform apply`, to build the backend image, push a real tag, and register
# a task-definition revision pointing at it — exactly the same describe→swap→
# register→update→wait dance deploy.yml does, but runnable from a laptop before
# you've wired up the release flow. After this, the service is healthy and every
# subsequent deploy goes through `app@<version>` releases as normal.
#
# It is idempotent: re-running just ships another revision.
#
# USAGE
#   infra/scripts/seed-first-image.sh [--region R] [--app-name N] \
#                                     [--environment E] [--tag T]
#
# Defaults mirror infra/variables.tf: region ap-southeast-2, app-name flakey,
# environment production. --tag defaults to the current git short SHA (falling
# back to "bootstrap" outside a git tree).
#
# Requires: aws cli v2 (authenticated), docker with buildx, jq, git.
set -euo pipefail

REGION="ap-southeast-2"
APP_NAME="flakey"
ENVIRONMENT="production"
TAG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --region)      REGION="$2"; shift 2 ;;
    --app-name)    APP_NAME="$2"; shift 2 ;;
    --environment) ENVIRONMENT="$2"; shift 2 ;;
    --tag)         TAG="$2"; shift 2 ;;
    -h|--help)     grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

for bin in aws docker jq; do
  command -v "$bin" >/dev/null || { echo "ERROR: '$bin' not found on PATH." >&2; exit 1; }
done

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKEND_DIR="$REPO_DIR/backend"
[ -f "$BACKEND_DIR/Dockerfile" ] || { echo "ERROR: $BACKEND_DIR/Dockerfile not found." >&2; exit 1; }

if [ -z "$TAG" ]; then
  TAG="$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo bootstrap)"
fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
ECR_REPO="${APP_NAME}-backend"
CLUSTER="${APP_NAME}-${ENVIRONMENT}"
SERVICE="${APP_NAME}-${ENVIRONMENT}-backend"
TASK_FAMILY="${APP_NAME}-${ENVIRONMENT}-backend"
IMAGE_URI="${REGISTRY}/${ECR_REPO}:${TAG}"

# Match the runtime architecture the task definition declares (ARM64 by
# default, see var.cpu_architecture). Pull it straight from the registered
# task def so the pushed image can't drift from what Fargate will run.
CPU_ARCH="$(aws ecs describe-task-definition --task-definition "$TASK_FAMILY" --region "$REGION" \
  --query 'taskDefinition.runtimePlatform.cpuArchitecture' --output text 2>/dev/null || echo ARM64)"
case "$CPU_ARCH" in
  ARM64|arm64) PLATFORM="linux/arm64" ;;
  X86_64|x86_64|amd64) PLATFORM="linux/amd64" ;;
  *) PLATFORM="linux/arm64" ;;
esac

echo "==> Account     : $ACCOUNT_ID"
echo "==> Region      : $REGION"
echo "==> Image       : $IMAGE_URI"
echo "==> Platform    : $PLATFORM (from task def cpuArchitecture=$CPU_ARCH)"
echo "==> Cluster/Svc : $CLUSTER / $SERVICE"
echo

echo "==> Logging in to ECR..."
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

echo "==> Building + pushing $PLATFORM image..."
docker buildx build --platform "$PLATFORM" --tag "$IMAGE_URI" --push "$BACKEND_DIR"

echo "==> Registering a new task-definition revision with the seeded image..."
aws ecs describe-task-definition --task-definition "$TASK_FAMILY" --region "$REGION" \
  --query 'taskDefinition' \
  | jq --arg img "$IMAGE_URI" '
      .containerDefinitions[0].image = $img
      | del(.taskDefinitionArn, .revision, .status, .requiresAttributes,
            .compatibilities, .registeredAt, .registeredBy)
    ' > /tmp/flakey-seed-td.json
NEW_TD="$(aws ecs register-task-definition --region "$REGION" \
  --cli-input-json file:///tmp/flakey-seed-td.json \
  --query 'taskDefinition.taskDefinitionArn' --output text)"
rm -f /tmp/flakey-seed-td.json

echo "==> Rolling the service onto $NEW_TD ..."
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" \
  --task-definition "$NEW_TD" --region "$REGION" >/dev/null

echo "==> Waiting for the service to stabilize (this also runs DB migrations)..."
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION"

echo
echo "Done. The service is live on the seeded image."
echo "From here, deploy normally by publishing a GitHub release tagged app@<version>."
