import { login, validateEmail, parseToken } from "../../src/auth.js";

describe("auth — smoke", () => {
  describe("login()", () => {
    it("succeeds with valid credentials", () => {
      const result = login({ email: "admin@test.com", password: "password" });
      expect(result.success).toBe(true);
    });

    it("returns a token on success", () => {
      const result = login({ email: "admin@test.com", password: "password" });
      expect(result.success).toBe(true);
      if (result.success) expect(result.token).toMatch(/^stub-token-/);
    });

    it("rejects wrong password", () => {
      const result = login({ email: "admin@test.com", password: "wrong" });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toBeTruthy();
    });

    it("rejects unknown email", () => {
      const result = login({ email: "other@test.com", password: "password" });
      expect(result.success).toBe(false);
    });

    it("rejects empty email", () => {
      const result = login({ email: "", password: "password" });
      expect(result.success).toBe(false);
    });

    it("rejects empty password", () => {
      const result = login({ email: "admin@test.com", password: "" });
      expect(result.success).toBe(false);
    });
  });

  describe("validateEmail()", () => {
    it("accepts valid email addresses", () => {
      expect(validateEmail("admin@test.com")).toBe(true);
      expect(validateEmail("user+tag@example.org")).toBe(true);
    });

    it("rejects invalid email addresses", () => {
      expect(validateEmail("notanemail")).toBe(false);
      expect(validateEmail("missing@tld")).toBe(false);
      expect(validateEmail("@no-local.com")).toBe(false);
    });
  });

  describe("parseToken()", () => {
    it("parses a valid stub token", () => {
      const parsed = parseToken("stub-token-admin@test.com");
      expect(parsed).toEqual({ email: "admin@test.com" });
    });

    it("returns null for invalid token", () => {
      expect(parseToken("not-a-token")).toBeNull();
      expect(parseToken("")).toBeNull();
    });
  });
});
