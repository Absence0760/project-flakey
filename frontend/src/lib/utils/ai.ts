// Friendly labels for the failure classifications the AI analysis returns.
// Shared so the aggregated /errors view and the per-test analysis comment
// render the same wording for a given classification key.
export const classificationLabels: Record<string, string> = {
  product_bug: "Product Bug",
  automation_bug: "Automation Bug",
  environment_issue: "Environment Issue",
  flaky_test: "Flaky Test",
  data_issue: "Data Issue",
  timeout: "Timeout",
  unknown: "Unknown",
};

export function classificationLabel(classification: string): string {
  return classificationLabels[classification] ?? classification;
}
