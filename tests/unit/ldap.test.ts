import { describe, expect, it } from "vitest";
import { authenticateLdap, cnFromDn, escapeFilterValue, normalizeUsername, ldapAccountActive, ldapEntryIdentity, ldapConfigFromEnv, LdapUnavailableError, type LdapConfig } from "@/lib/auth/ldap";

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

const memberConfig = { ...ldapConfigFromEnv(), url: "ldaps://fixture.invalid", baseDn: "dc=fixture", groupMode: "member" as const };
const adConfig = { ...memberConfig, groupMode: "ad" as const };
const now = Date.UTC(2026, 9, 6);
it("requires readable AD status and rejects disabled, locked and expired directory accounts", () => {
  const active = { dn: "cn=fixture", userAccountControl: "512", "msDS-User-Account-Control-Computed": "0" };
  expect(ldapAccountActive(active, adConfig, now)).toBe(true);
  const changes: Record<string, string>[] = [
    { userAccountControl: "514" }, { "msDS-User-Account-Control-Computed": "16" }, { userAccountControl: "invalid" },
    { accountExpires: "1" }, { accountExpires: "invalid" }, { pwdAccountLockedTime: "000001010000Z" },
    { pwdStartTime: "20271006000000Z" }, { pwdEndTime: "20251006000000Z" },
  ];
  for (const change of changes) expect(ldapAccountActive({ ...active, ...change }, adConfig, now)).toBe(false);
  expect(ldapAccountActive({ dn: "cn=fixture" }, adConfig, now)).toBe(false);
  expect(ldapAccountActive({ dn: "cn=fixture", objectGUID: Buffer.alloc(16, 4) }, { ...adConfig, groupMode: "memberOf" }, now)).toBe(false);
  expect(ldapAccountActive({ dn: "cn=fixture", userAccountControl: "512" }, adConfig, now)).toBe(false);
  for (const expires of ["0", "9223372036854775807"]) expect(ldapAccountActive({ ...active, accountExpires: expires }, adConfig, now)).toBe(true);
  expect(ldapAccountActive({ dn: "uid=fixture", entryUUID: "synthetic" }, memberConfig, now)).toBe(true);
});
it("binds passkeys to a stable GUID/UUID and configured directory rather than a reusable DN", () => {
  const entry = { dn: "uid=fixture", entryUUID: "original-object" };
  const identity = ldapEntryIdentity(entry, memberConfig);
  expect(identity).toMatch(/^[a-f0-9]{64}$/);
  expect(ldapEntryIdentity({ ...entry, dn: "uid=renamed" }, memberConfig)).toBe(identity);
  expect(ldapEntryIdentity({ ...entry, entryUUID: "replacement-object" }, memberConfig)).not.toBe(identity);
  expect(ldapEntryIdentity(entry, { ...memberConfig, url: "ldaps://other.invalid" })).not.toBe(identity);
  expect(ldapEntryIdentity({ dn: entry.dn }, memberConfig)).toBeUndefined();
  expect(ldapEntryIdentity({ dn: entry.dn, objectGUID: Buffer.alloc(16, 4) }, adConfig)).toMatch(/^[a-f0-9]{64}$/);
});

describe("directory failures", () => {
  const cfg = (over: Partial<LdapConfig>): LdapConfig => ({ url: "ldap://127.0.0.1:1", bindDn: "cn=svc", bindPassword: "x", baseDn: "dc=x", groupBaseDn: "dc=x",
    userFilter: "(uid={{username}})", groupMode: "member", rejectUnauthorized: true, timeoutMs: 2000, ...over });
  it("reports an unreachable directory as unavailable, not as a wrong password", async () => {
    await expect(authenticateLdap("jdoe", "pw", cfg({}))).rejects.toBeInstanceOf(LdapUnavailableError);
  });
  it("reports a missing CA file as unavailable", async () => {
    await expect(authenticateLdap("jdoe", "pw", cfg({ url: "ldaps://127.0.0.1:1", caCertPath: "/nonexistent/ca.pem" })))
      .rejects.toBeInstanceOf(LdapUnavailableError);
  });
  it("still rejects empty credentials without contacting the directory", async () => {
    await expect(authenticateLdap("jdoe", "", cfg({}))).resolves.toBeNull();
  });
});
