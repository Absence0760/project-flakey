// Shared run-statistics helpers. Kept structural (not tied to the Run /
// RunDetail types) so any object carrying a total + passed count works —
// the runs list, run detail, and dashboard all call this.

/** Pass rate as a whole-number percentage (0–100). Returns 0 for empty runs. */
export function passRate(r: { total: number; passed: number }): number {
  return r.total > 0 ? Math.round((r.passed / r.total) * 100) : 0;
}
