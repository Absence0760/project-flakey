/**
 * Strip CR/LF from an unknown value before it goes into a log line so
 * an attacker-controlled message (e.g. a Postgres error referencing
 * a user-supplied parameter) can't inject a fake log entry by smuggling
 * "\nfake.line=..." through the formatter. Covers CWE-117 / CodeQL
 * js/log-injection.
 */
export function safeLog(value: unknown): string {
  const str =
    value instanceof Error
      ? (value.stack ?? value.message)
      : typeof value === "string"
        ? value
        : (() => {
            try {
              return JSON.stringify(value);
            } catch {
              return String(value);
            }
          })();
  return (str ?? "").replace(/[\r\n]+/g, " | ");
}
