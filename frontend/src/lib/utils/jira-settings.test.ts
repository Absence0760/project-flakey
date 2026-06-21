import { describe, it, expect } from "vitest";
import { buildJiraSettingsBody, type JiraSettingsForm } from "./jira-settings";

const form: JiraSettingsForm = {
  base_url: "https://acme.atlassian.net",
  email: "ci@acme.test",
  project_key: "FLAKE",
  issue_type: "Bug",
  auto_create: true,
  resolve_transition: "Done",
  reopen_transition: "To Do",
};

describe("buildJiraSettingsBody", () => {
  it("always includes the non-secret config fields", () => {
    const body = buildJiraSettingsBody(form, "", "");
    expect(body).toMatchObject({
      base_url: "https://acme.atlassian.net",
      email: "ci@acme.test",
      project_key: "FLAKE",
      issue_type: "Bug",
      auto_create: true,
    });
  });

  it("always sends both transition names (editable plain config)", () => {
    const body = buildJiraSettingsBody(form, "", "");
    expect(body.resolve_transition).toBe("Done");
    expect(body.reopen_transition).toBe("To Do");
  });

  it("sends a cleared transition as an empty string (so the backend resets to default)", () => {
    const body = buildJiraSettingsBody({ ...form, reopen_transition: "" }, "", "");
    expect(body.reopen_transition).toBe("");
    // Empty string is present (cleared), not omitted — an omitted field would
    // leave the stored value untouched.
    expect("reopen_transition" in body).toBe(true);
  });

  it("omits api_token and webhook_secret when their inputs are blank (leave-as-is)", () => {
    const body = buildJiraSettingsBody(form, "", "");
    expect("api_token" in body).toBe(false);
    expect("webhook_secret" in body).toBe(false);
  });

  it("includes api_token only when the user typed one (rotate)", () => {
    const body = buildJiraSettingsBody(form, "new-api-token", "");
    expect(body.api_token).toBe("new-api-token");
    expect("webhook_secret" in body).toBe(false);
  });

  it("includes webhook_secret only when the user typed one (rotate)", () => {
    const body = buildJiraSettingsBody(form, "", "s3cr3t-hmac");
    expect(body.webhook_secret).toBe("s3cr3t-hmac");
    expect("api_token" in body).toBe(false);
  });

  it("can rotate both secrets at once", () => {
    const body = buildJiraSettingsBody(form, "tok", "hmac");
    expect(body.api_token).toBe("tok");
    expect(body.webhook_secret).toBe("hmac");
  });
});
