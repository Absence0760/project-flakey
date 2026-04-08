/**
 * Converts OWASP ZAP JSON report to JUnit XML for ingestion by Flakey.
 *
 * Each ZAP alert becomes a test case:
 *   - riskcode 0 (Informational) → passed
 *   - riskcode 1+ (Low/Medium/High) → failed
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";

const RISK_LABELS = ["Informational", "Low", "Medium", "High"];

const zapPath = "zap-report.json";
let report;
try {
  report = JSON.parse(readFileSync(zapPath, "utf-8"));
} catch {
  console.error(`Could not read ${zapPath} — ZAP may not have produced output.`);
  // Write an empty JUnit file so the upload step doesn't fail
  mkdirSync("results", { recursive: true });
  writeFileSync(
    "results/zap-results.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<testsuites><testsuite name="OWASP ZAP" tests="1" failures="0">
  <testcase name="ZAP scan skipped — no report produced" classname="zap"/>
</testsuite></testsuites>`
  );
  process.exit(0);
}

const sites = report.site || [];
const testcases = [];
let failures = 0;

for (const site of sites) {
  const alerts = site.alerts || [];
  for (const alert of alerts) {
    const risk = Number(alert.riskcode) || 0;
    const name = alert.name || alert.alert || "Unknown alert";
    const desc = alert.desc?.replace(/<[^>]*>/g, "") || "";
    const solution = alert.solution?.replace(/<[^>]*>/g, "") || "";
    const instances = alert.instances?.length ?? 0;
    const riskLabel = RISK_LABELS[risk] || "Unknown";
    const classname = `zap.${riskLabel.toLowerCase()}`;

    if (risk >= 1) {
      failures++;
      const message = `[${riskLabel}] ${name} (${instances} instance${instances !== 1 ? "s" : ""})`;
      const detail = [desc, solution ? `Suggestion: ${solution}` : ""]
        .filter(Boolean)
        .join("\n\n");

      testcases.push(
        `    <testcase name="${esc(name)}" classname="${classname}">` +
          `\n      <failure message="${esc(message)}">${esc(detail)}</failure>` +
          `\n    </testcase>`
      );
    } else {
      testcases.push(
        `    <testcase name="${esc(name)}" classname="${classname}"/>`
      );
    }
  }
}

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="OWASP ZAP" tests="${testcases.length}" failures="${failures}" time="0">
${testcases.join("\n")}
  </testsuite>
</testsuites>`;

mkdirSync("results", { recursive: true });
writeFileSync("results/zap-results.xml", xml);
console.log(
  `Converted ${testcases.length} ZAP alert(s) (${failures} failure(s)) to results/zap-results.xml`
);

function esc(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
