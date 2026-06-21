// Pure form→request mapping for the Jira integration settings section
// (settings/integrations). Kept here (not inline in the +page.svelte) so the
// secret-omission and transition-name rules are unit-testable without a
// component harness — frontend's testing convention for non-trivial logic.
//
// Backend contract (PATCH /jira/settings, backend/src/routes/jira.ts): the
// update is *partial* — a field that is `undefined` in the body is left
// untouched; a field sent as `""`/`null` is cleared. So:
//   - Write-only secrets (api_token, webhook_secret) are included ONLY when the
//     user typed a new value, exactly mirroring the existing api_token UX: an
//     empty box means "leave the stored secret as-is", a non-empty box rotates
//     it. There is intentionally no "clear secret" affordance (matches the rest
//     of the page).
//   - Transition names are plain config the user can edit or clear, so they are
//     always sent; an empty string clears the column and the outbound Jira
//     client then falls back to its "Done"/"To Do" defaults.

export interface JiraSettingsForm {
  base_url: string;
  email: string;
  project_key: string;
  issue_type: string;
  auto_create: boolean;
  resolve_transition: string;
  reopen_transition: string;
}

/**
 * Build the PATCH /jira/settings body from the form state plus the two
 * write-only secret inputs. `apiToken` / `webhookSecret` are the live values of
 * the (always-blank-on-load) password fields.
 */
export function buildJiraSettingsBody(
  form: JiraSettingsForm,
  apiToken: string,
  webhookSecret: string
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    base_url: form.base_url,
    email: form.email,
    project_key: form.project_key,
    issue_type: form.issue_type,
    auto_create: form.auto_create,
    // Always sent — editable plain config; "" clears → backend default.
    resolve_transition: form.resolve_transition,
    reopen_transition: form.reopen_transition,
  };
  // Write-only: only include when the user typed something (set / rotate).
  if (apiToken) body.api_token = apiToken;
  if (webhookSecret) body.webhook_secret = webhookSecret;
  return body;
}
