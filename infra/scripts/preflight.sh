#!/usr/bin/env bash
#
# preflight.sh — read-only deploy-readiness checks for the Flakey AWS stack.
#
# Run this before `terraform apply` (and before cutting an app@ release) to
# catch the things that otherwise fail halfway through a deploy: missing/invalid
# tfvars, ACM certs that aren't ISSUED or live in the wrong region, an
# unauthenticated AWS CLI, and (if `gh` is available) GitHub secrets/vars the
# deploy workflow reads. It changes NOTHING — every check is a describe/read.
#
# Exit code is non-zero if any hard check FAILs; WARNs don't fail the run.
#
# USAGE
#   infra/scripts/preflight.sh                 # uses infra/terraform.tfvars
#   infra/scripts/preflight.sh path/to.tfvars
#
# Requires: terraform, aws cli v2 (authenticated). Optional: gh, jq.
set -uo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TFVARS="${1:-$INFRA_DIR/terraform.tfvars}"
FAIL=0

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=1; }

# Pull a "key = value" scalar out of the tfvars file (best-effort; ignores
# list/heredoc values). Returns empty if absent.
tfvar() {
  [ -f "$TFVARS" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$TFVARS" | head -1
}

echo "== Tooling =="
command -v terraform >/dev/null && pass "terraform present ($(terraform version | head -1))" || fail "terraform not on PATH"
command -v aws       >/dev/null && pass "aws cli present"                                    || fail "aws cli not on PATH"
command -v gh        >/dev/null && pass "gh present (GitHub checks enabled)"                 || warn "gh not on PATH — skipping GitHub secret/var checks"
command -v jq        >/dev/null || warn "jq not on PATH — some checks degrade"

echo
echo "== Terraform fmt + validate =="
for stack in "$INFRA_DIR" "$INFRA_DIR/bootstrap"; do
  name="$(basename "$stack")"
  if terraform -chdir="$stack" fmt -check -recursive >/dev/null 2>&1; then
    pass "fmt clean ($name)"
  else
    fail "terraform fmt would reformat ($name) — run: terraform -chdir=$stack fmt -recursive"
  fi
  if terraform -chdir="$stack" init -backend=false -input=false >/dev/null 2>&1 \
     && terraform -chdir="$stack" validate >/dev/null 2>&1; then
    pass "validate ok ($name)"
  else
    fail "terraform validate failed ($name) — run it directly to see why"
  fi
done

echo
echo "== AWS identity =="
if IDENT="$(aws sts get-caller-identity --output text --query '[Account,Arn]' 2>/dev/null)"; then
  pass "authenticated: $IDENT"
  ACCOUNT_ID="$(echo "$IDENT" | awk '{print $1}')"
else
  fail "aws sts get-caller-identity failed — not authenticated (run your SSO login)"
  ACCOUNT_ID=""
fi

echo
echo "== Required tfvars =="
if [ ! -f "$TFVARS" ]; then
  warn "no tfvars at $TFVARS — required vars (acm_certificate_arn, budget_alert_email, csp_connect_src) must come from somewhere"
else
  pass "tfvars file: $TFVARS"
  for key in acm_certificate_arn budget_alert_email; do
    v="$(tfvar "$key")"
    [ -n "$v" ] && pass "$key set" || fail "$key missing in tfvars (no default — apply will fail)"
  done
  grep -q 'csp_connect_src' "$TFVARS" && pass "csp_connect_src present" || fail "csp_connect_src missing (SPA can't reach the API without it)"
  # Placeholder guard mirrors the validation in variables.tf.
  if grep -qE '<[^>]*>' "$TFVARS"; then
    fail "tfvars still contains <placeholder> text — replace it before apply"
  fi
fi

echo
echo "== ACM certificates =="
REGION="$(tfvar aws_region)"; REGION="${REGION:-ap-southeast-2}"
alb_cert="$(tfvar acm_certificate_arn)"
cf_cert="$(tfvar cloudfront_acm_certificate_arn)"
check_cert() { # arn, expected-region, label
  local arn="$1" want="$2" label="$3" got st
  [ -n "$arn" ] || { warn "$label: not set"; return; }
  got="$(echo "$arn" | cut -d: -f4)"
  if [ "$got" != "$want" ]; then fail "$label is in $got but must be in $want"; return; fi
  st="$(aws acm describe-certificate --certificate-arn "$arn" --region "$want" \
        --query 'Certificate.Status' --output text 2>/dev/null || echo UNKNOWN)"
  [ "$st" = "ISSUED" ] && pass "$label ISSUED in $want" || fail "$label status=$st (must be ISSUED before apply)"
}
check_cert "$alb_cert" "$REGION"   "ALB cert (acm_certificate_arn)"
check_cert "$cf_cert"  "us-east-1" "CloudFront cert (cloudfront_acm_certificate_arn)"

if command -v gh >/dev/null; then
  echo
  echo "== GitHub deploy secrets/vars (repo of cwd) =="
  have_secret() { gh secret list 2>/dev/null | awk '{print $1}' | grep -qx "$1"; }
  for s in AWS_ROLE_ARN API_URL FRONTEND_BUCKET CLOUDFRONT_DISTRIBUTION_ID; do
    have_secret "$s" && pass "secret $s set" || fail "secret $s missing (deploy.yml reads it)"
  done
fi

echo
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32mPreflight passed.\033[0m\n'
else
  printf '\033[31mPreflight found blocking issues (see FAILs above).\033[0m\n'
fi
exit "$FAIL"
