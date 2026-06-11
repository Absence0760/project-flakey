# Structural guard for the CloudFront CSP assembled in this module — the
# Terraform counterpart of frontend/svelte.config.test.ts. Artifacts are
# served from the API / bucket origin (a different origin from the SPA), so
# img-src and media-src must carry that origin or the browser silently
# blocks every screenshot / video. This is the exact bug class fixed in
# 7375c69 (connect-src) and d962133 (img-src/media-src).
#
# mock_provider keeps the run hermetic — no AWS account, no real resources;
# the CSP local is pure from variables, so `plan` resolves output.csp.

mock_provider "aws" {}
mock_provider "aws" {
  alias = "us_east_1"
}

variables {
  app_name        = "flakey"
  environment     = "test"
  csp_connect_src = ["https://api.example.com"]
}

# Default: img-src/media-src unset → fall back to the connect-src origin, so
# a deploy that only declares the API origin still renders screenshots/video.
run "artifact_directives_default_to_api_origin" {
  command = plan

  assert {
    condition     = strcontains(output.csp, "img-src 'self' data: blob: https://api.example.com")
    error_message = "img-src must include the API origin when csp_img_src is unset (artifacts stream from the API)."
  }
  assert {
    condition     = strcontains(output.csp, "media-src 'self' blob: https://api.example.com")
    error_message = "media-src must include the API origin when csp_media_src is unset."
  }
  assert {
    condition     = strcontains(output.csp, "connect-src 'self' https://api.example.com")
    error_message = "connect-src must include the API origin."
  }
}

# Override: a separate artifact origin is honoured per-directive.
run "artifact_directives_honour_overrides" {
  command = plan

  variables {
    csp_img_src   = ["https://cdn.example.com"]
    csp_media_src = ["https://media.example.com"]
  }

  assert {
    condition     = strcontains(output.csp, "img-src 'self' data: blob: https://cdn.example.com")
    error_message = "img-src must use the explicit csp_img_src origin when set."
  }
  assert {
    condition     = strcontains(output.csp, "media-src 'self' blob: https://media.example.com")
    error_message = "media-src must use the explicit csp_media_src origin when set."
  }
}
