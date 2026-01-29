import { describe, it, expect } from "vitest";
import { isEmailAllowed, parseEmailAddresses } from "./outbound-check.js";

describe("parseEmailAddresses", () => {
  describe("simple emails", () => {
    it("parses plain email address", () => {
      const result = parseEmailAddresses("user@example.com");
      expect(result).toEqual([{ email: "user@example.com" }]);
    });

    it("lowercases email addresses", () => {
      const result = parseEmailAddresses("User@Example.COM");
      expect(result).toEqual([{ email: "user@example.com" }]);
    });
  });

  describe("named addresses", () => {
    it("parses Name <email> format", () => {
      const result = parseEmailAddresses("John Doe <john@example.com>");
      expect(result).toEqual([{ name: "John Doe", email: "john@example.com" }]);
    });

    it("parses quoted name with special chars", () => {
      const result = parseEmailAddresses('"Last, First" <user@example.com>');
      expect(result).toEqual([{ name: "Last, First", email: "user@example.com" }]);
    });

    it("handles name with quotes", () => {
      const result = parseEmailAddresses('"John \\"Johnny\\" Doe" <john@example.com>');
      expect(result[0].email).toBe("john@example.com");
    });
  });

  describe("multiple addresses", () => {
    it("parses comma-separated addresses", () => {
      const result = parseEmailAddresses("a@example.com, b@example.com");
      expect(result).toHaveLength(2);
      expect(result[0].email).toBe("a@example.com");
      expect(result[1].email).toBe("b@example.com");
    });

    it("parses mixed formats", () => {
      const result = parseEmailAddresses("John <john@example.com>, jane@example.com");
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ name: "John", email: "john@example.com" });
      expect(result[1]).toEqual({ email: "jane@example.com" });
    });

    it("handles quoted names with commas among multiple addresses", () => {
      const result = parseEmailAddresses('"Last, First" <a@example.com>, b@example.com');
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("Last, First");
      expect(result[0].email).toBe("a@example.com");
      expect(result[1].email).toBe("b@example.com");
    });
  });

  describe("edge cases", () => {
    it("returns empty array for empty string", () => {
      expect(parseEmailAddresses("")).toEqual([]);
    });

    it("returns empty array for null/undefined", () => {
      expect(parseEmailAddresses(null as any)).toEqual([]);
      expect(parseEmailAddresses(undefined as any)).toEqual([]);
    });

    it("ignores malformed entries without @", () => {
      const result = parseEmailAddresses("not-an-email, valid@example.com");
      expect(result).toHaveLength(1);
      expect(result[0].email).toBe("valid@example.com");
    });

    it("handles extra whitespace", () => {
      const result = parseEmailAddresses("  user@example.com  ");
      expect(result).toEqual([{ email: "user@example.com" }]);
    });
  });
});

describe("isEmailAllowed", () => {
  describe("empty allowlist", () => {
    it("allows any email when allowlist is empty", () => {
      expect(isEmailAllowed("anyone@example.com", [])).toBe(true);
    });
  });

  describe("wildcard", () => {
    it("allows any email with * wildcard", () => {
      expect(isEmailAllowed("anyone@anywhere.com", ["*"])).toBe(true);
    });

    it("allows any email with * among other entries", () => {
      expect(isEmailAllowed("random@test.com", ["specific@example.com", "*"])).toBe(true);
    });
  });

  describe("exact match", () => {
    it("allows exact email match", () => {
      expect(isEmailAllowed("user@example.com", ["user@example.com"])).toBe(true);
    });

    it("matches case-insensitively", () => {
      expect(isEmailAllowed("User@Example.COM", ["user@example.com"])).toBe(true);
    });

    it("rejects non-matching email", () => {
      expect(isEmailAllowed("other@example.com", ["user@example.com"])).toBe(false);
    });
  });

  describe("domain wildcard", () => {
    it("allows email matching domain wildcard", () => {
      expect(isEmailAllowed("anyone@company.com", ["@company.com"])).toBe(true);
    });

    it("matches domain case-insensitively", () => {
      expect(isEmailAllowed("user@COMPANY.COM", ["@company.com"])).toBe(true);
    });

    it("rejects email from different domain", () => {
      expect(isEmailAllowed("user@other.com", ["@company.com"])).toBe(false);
    });

    it("does not match partial domain names", () => {
      // @company.com should not match @notcompany.com
      expect(isEmailAllowed("user@notcompany.com", ["@company.com"])).toBe(false);
    });

    it("matches subdomain when specified", () => {
      expect(isEmailAllowed("user@sub.company.com", ["@sub.company.com"])).toBe(true);
    });
  });

  describe("multiple entries", () => {
    it("allows if any entry matches", () => {
      const allowList = ["admin@example.com", "@trusted.com", "vip@special.org"];
      
      expect(isEmailAllowed("admin@example.com", allowList)).toBe(true);
      expect(isEmailAllowed("anyone@trusted.com", allowList)).toBe(true);
      expect(isEmailAllowed("vip@special.org", allowList)).toBe(true);
      expect(isEmailAllowed("random@other.com", allowList)).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("handles whitespace in allowlist entries", () => {
      expect(isEmailAllowed("user@example.com", ["  user@example.com  "])).toBe(true);
    });

    it("ignores empty entries", () => {
      expect(isEmailAllowed("user@example.com", ["", "  ", "user@example.com"])).toBe(true);
    });

    it("handles empty email gracefully", () => {
      expect(isEmailAllowed("", ["user@example.com"])).toBe(false);
    });
  });
});
