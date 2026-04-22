# Review: examples/ + infra/

## Scope
- Files reviewed: 38 (READMEs, package.json, config files, Terraform root + 7 modules, bootstrap, scripts)
- Focus: general audit — docs vs reality, env vars, scripts, Terraform declarations
- Reviewer confidence: high — every file was opened; cross-referenced scripts against READMEs and Terraform against module sources

---

## examples/README.md

### Priority: high

#### H1. `pnpm test` doesn't exist — Cypress, Playwright, WebdriverIO all missing the script
- **File(s)**: `examples/README.md:107`, `examples/README.md:111`, `examples/README.md:124`
- **Category**: bug
- **Problem**: The "Run an example" section tells users to run `pnpm test` for Cypress, Playwright, and WebdriverIO. None of those three `package.json` files define a `test` script. The commands will fail with `ERR_PNPM_NO_SCRIPT`.
- **Evidence**:
  ```
  README line 107:  FLAKEY_API_KEY=fk_your_key pnpm test
  README line 111:  FLAKEY_API_KEY=fk_your_key pnpm test
  README line 124:  FLAKEY_API_KEY=fk_your_key pnpm test

  examples/cypress/package.json scripts: test:smoke, test:sanity, test:regression, test:live, test:all, open
  examples/playwright/package.json scripts: test:smoke, test:sanity, test:regression, test:all
  examples/webdriverio/package.json scripts: test:smoke, test:sanity, test:regression, test:all
  ```
- **Proposed change**:
  ```diff
  - FLAKEY_API_KEY=fk_your_key pnpm test
  + FLAKEY_API_KEY=fk_your_key pnpm test:smoke
  ```
  Apply the same substitution for the Playwright and WebdriverIO blocks. Alternatively add a `"test": "pnpm test:smoke"` alias to each package.json; if so the README is already correct.
- **Risk if applied**: None — these are docs-only or additive script changes.
- **Verification**: `cd examples/cypress && pnpm test:smoke --dry-run` should resolve without ERR_PNPM_NO_SCRIPT.

#### H2. Selenium CLI snippet uses wrong reporter and wrong report-dir
- **File(s)**: `examples/README.md:241-249`
- **Category**: bug
- **Problem**: The manual CLI upload snippet tells readers to pass `--reporter junit` and `--report-dir test-results`. The actual `selenium/scripts/upload.js` passes `--reporter mochawesome` and `--report-dir reports`, because `selenium/package.json` runs Mocha with `mochawesome`, not JUnit.
- **Evidence**:
  ```
  README lines 246-249:
    --report-dir test-results \
    --suite integration-selenium \
    --reporter junit \

  scripts/upload.js lines 47-53:
    "--report-dir", reportDir,          // "reports"
    "--suite", `selenium-example-${suite}`,
    "--reporter", "mochawesome",
    "--screenshots-dir", "screenshots",
  ```
- **Proposed change**:
  ```diff
  - npx tsx ../../packages/flakey-cli/src/index.ts \
  -   --report-dir test-results \
  -   --suite integration-selenium \
  -   --reporter junit \
  -   --api-key $FLAKEY_API_KEY
  + # upload is handled automatically by scripts/upload.js via pnpm test:smoke etc.
  + # To upload manually:
  + npx tsx ../../packages/flakey-cli/src/index.ts \
  +   --report-dir reports \
  +   --suite selenium-example-smoke \
  +   --reporter mochawesome \
  +   --screenshots-dir screenshots \
  +   --api-key $FLAKEY_API_KEY
  ```
- **Risk if applied**: None.
- **Verification**: Confirm `scripts/upload.js` continues to use `reportDir = "reports"` and `--reporter mochawesome`.

---

### Priority: medium

#### M1. `newman-reporter-junitfull` installed but not used; `--reporters junit` uses built-in instead
- **File(s)**: `examples/postman/package.json:9,15`
- **Category**: inconsistency
- **Problem**: `devDependencies` includes `newman-reporter-junitfull` (registers as `junitfull`). The `test:smoke` script passes `--reporters cli,junit`, which invokes Newman's built-in `junit` reporter — not `junitfull`. The `junitfull` package is never used. Either the script should use `--reporters cli,junitfull` or the dependency should be removed.
- **Evidence**:
  ```json
  "test:smoke": "newman run ... --reporters cli,junit --reporter-junit-export reports/results.xml",
  "newman-reporter-junitfull": "^2.0.0"
  ```
- **Proposed change**: Remove the unused dependency and document the choice:
  ```diff
  - "newman-reporter-junitfull": "^2.0.0",
  ```
  If richer JUnit output (classnames, timestamps) is desired, switch the script:
  ```diff
  - --reporters cli,junit --reporter-junit-export reports/results.xml
  + --reporters cli,junitfull --reporter-junitfull-export reports/results.xml
  ```
- **Risk if applied**: Low. The built-in reporter already produces valid JUnit XML that the CLI accepts.
- **Verification**: `pnpm install` in `examples/postman` should have no extraneous packages; the `reports/results.xml` file should be non-empty after a run.

---

## examples/cypress

No issues. Scripts match the README table, env vars (`FLAKEY_API_URL`, `FLAKEY_API_KEY`, `SUITE`) match what `cypress.config.ts` reads, and the `live` suite exists under `cypress/e2e/live/`.

---

## examples/cypress-cucumber

No issues. Config, feature files, and support file are consistent. The comment in the config about `import "@flakeytesting/cypress-snapshots/cucumber"` matches the guidance in the top-level README.

---

## examples/playwright

No issues. Config reads `FLAKEY_API_URL`, `FLAKEY_API_KEY`, `SUITE` consistently. Suite-to-directory mapping in `playwright.config.ts` matches the test directories present on disk.

---

## examples/selenium

The code is correct; the only issue is the README snippet (H2 above).

---

## examples/webdriverio

No issues. `wdio.conf.ts` reads `FLAKEY_API_URL`, `FLAKEY_API_KEY`, `SUITE` consistently with `.env.example`.

---

## examples/postman

One issue logged (M1 above). Upload flow itself is correct: `convert.js` is not involved here; `scripts/upload.js` expects `reports/results.xml` which is where `--reporter-junit-export` writes it.

---

## examples/zap

No issues. `scripts/convert.js` writes `results/zap-results.xml`; `scripts/upload.js` checks for `results/zap-results.xml` and passes `--report-dir results`. The `test:api` script pipes through convert then upload in the right order.

---

## infra

### Priority: high

#### H3. `hashicorp/random` provider used but not declared in `required_providers`
- **File(s)**: `infra/modules/secrets/main.tf:1-9`, `infra/versions.tf:4-9`
- **Category**: bug
- **Problem**: `modules/secrets/main.tf` uses `random_password` resources, which require the `hashicorp/random` provider. The root `versions.tf` only declares `hashicorp/aws`. There is no `versions.tf` in the `secrets` module either. `terraform init` will attempt to auto-install `random` without a version constraint, which is non-reproducible and will warn (or fail with strict lockfiles).
- **Evidence**:
  ```hcl
  # infra/modules/secrets/main.tf
  resource "random_password" "db" {
    length  = 32
    special = false
  }

  # infra/versions.tf — random is absent
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  ```
- **Proposed change**:
  ```diff
  # infra/versions.tf
    required_providers {
      aws = {
        source  = "hashicorp/aws"
        version = "~> 5.0"
      }
  +   random = {
  +     source  = "hashicorp/random"
  +     version = "~> 3.0"
  +   }
    }
  ```
- **Risk if applied**: None functionally; run `terraform init -upgrade` afterward to write the lockfile entry.
- **Verification**: `terraform validate` in `infra/` must pass with no warnings about missing provider requirements.

---

### Priority: medium

#### M2. Infra README title and SNS topic name use old "Flakey" brand
- **File(s)**: `infra/README.md:1`, `infra/README.md:137`
- **Category**: inconsistency
- **Problem**: The README heading is "Flakey — AWS Infrastructure" and line 137 tells operators to subscribe to `flakey-production-alerts`. The heading should use the "Better Testing" product name. The SNS topic name itself is generated from Terraform variables (`app_name=flakey`, `environment=production`) so `flakey-production-alerts` is what Terraform actually produces — the doc is technically accurate to the resource, but the heading is stale.
- **Evidence**:
  ```markdown
  # Flakey — AWS Infrastructure        ← line 1
  Subscribe to the SNS topic `flakey-production-alerts`   ← line 137
  ```
- **Proposed change**:
  ```diff
  - # Flakey — AWS Infrastructure
  + # Better Testing — AWS Infrastructure
  ```
  The SNS name reference on line 137 is correct as-is (matches the Terraform output with defaults) so leave it unless `app_name` is ever renamed.
- **Risk if applied**: None.
- **Verification**: Visual check only.

---

### Priority: low

#### L1. `infra/README.md` does not mention the `budget` module in the architecture diagram
- **File(s)**: `infra/README.md:6-21` (architecture diagram)
- **Category**: inconsistency
- **Problem**: The ASCII architecture diagram omits the `budget` module entirely, even though `main.tf` instantiates it and the Terraform modules table at the bottom does list it. A reader scanning the diagram only gets an incomplete picture.
- **Evidence**:
  ```
  # Diagram shows: CloudFront, ALB, ECS, RDS, S3
  # main.tf line 37: module "budget" { source = "./modules/budget" ... }
  # Modules table line 170: budget | State bucket, DynamoDB locks...
  ```
  (The modules table entry is also wrong — it lists "State bucket, DynamoDB locks, GitHub OIDC provider, IAM role" for `budget`, which is the description for `bootstrap`. The budget module manages cost alerts only.)
- **Proposed change**:
  Fix the modules table description:
  ```diff
  - | `budget` | State bucket, DynamoDB locks, GitHub OIDC provider, IAM role |
  + | `budget` | Monthly AWS budget with 80%/100%/forecasted email alerts |
  ```
  Optionally add a note to the architecture section that budget alerts sit outside the request path.
- **Risk if applied**: None.
- **Verification**: Visual check only.
