import { describe, expect, it } from "vitest";
import { cnFromDn, escapeFilterValue, normalizeUsername } from "@/lib/auth/ldap";

describe("ldap helpers", () => {
  it("escapes filter metacharacters (prevents LDAP injection)", () => {
    expect(escapeFilterValue("a*)(uid=*")).toBe("a\\2a\\29\\28uid=\\2a");
    expect(escapeFilterValue("back\\slash")).toBe("back\\5cslash");
  });
  it("normalises DOMAIN\\user and UPN forms", () => {
    expect(normalizeUsername("CORP\\jdoe")).toBe("jdoe");
    expect(normalizeUsername(" jdoe@corp.com ")).toBe("jdoe@corp.com");
  });
  it("extracts CN from a DN, honouring escaped commas", () => {
    expect(cnFromDn("CN=AI Users,OU=Groups,DC=corp,DC=com")).toBe("AI Users");
    expect(cnFromDn("CN=Doe\\, John,OU=People,DC=corp")).toBe("Doe, John");
    expect(cnFromDn("OU=Groups,DC=corp")).toBeUndefined();
  });
});
