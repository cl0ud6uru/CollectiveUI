import { beforeEach, expect, it, vi } from "vitest";
import { InvalidCredentialsError, NoSuchObjectError, SizeLimitExceededError } from "ldapts";

const fixture = vi.hoisted(() => ({ serviceBind: vi.fn(), userBind: vi.fn(), search: vi.fn(), unbind: vi.fn(), count: 0 }));
vi.mock("ldapts", async importOriginal => ({ ...await importOriginal<typeof import("ldapts")>(), Client: class {
  bind: typeof fixture.serviceBind;
  search = fixture.search;
  unbind = fixture.unbind;
  constructor() { this.bind = fixture.count++ === 0 ? fixture.serviceBind : fixture.userBind; }
} }));
import { authenticateLdap, authenticateLdapAtBinding, ldapEntryIdentity, readLdapIdentity, logLdapUnavailable, LdapUnavailableError, type LdapConfig } from "@/lib/auth/ldap";

const cfg: LdapConfig = { url: "ldaps://fixture.invalid", bindDn: "cn=service", bindPassword: "synthetic-secret", baseDn: "dc=fixture",
  groupBaseDn: "dc=fixture", userFilter: "(uid={{username}})", upnSuffix: "fixture.invalid", groupMode: "memberOf", rejectUnauthorized: true, timeoutMs: 100 };
const entry = { dn: "uid=alice,dc=fixture", uid: "alice", cn: "Alice", entryUUID: "fixture-alice", memberOf: [] };
beforeEach(() => {
  vi.resetAllMocks(); fixture.count = 0;
  fixture.serviceBind.mockResolvedValue(undefined); fixture.userBind.mockResolvedValue(undefined);
  fixture.search.mockResolvedValue({ searchEntries: [entry] }); fixture.unbind.mockResolvedValue(undefined);
});

it("distinguishes a service-account credential failure from a user's rejected credentials", async () => {
  fixture.serviceBind.mockRejectedValueOnce(new InvalidCredentialsError("service private detail"));
  await expect(authenticateLdap("alice", "password", cfg)).rejects.toMatchObject({ stage: "service_bind" });
  fixture.count = 0;
  fixture.userBind.mockRejectedValueOnce(new InvalidCredentialsError("user private detail"));
  expect(await authenticateLdap("alice", "wrong", cfg)).toBeNull();
  expect(fixture.unbind).toHaveBeenCalledTimes(3);
});

it.each(["ECONNRESET", "ETIMEDOUT", "ERR_TLS_CERT_ALTNAME_INVALID"])("classifies user-bind %s as an outage and releases both clients", async code => {
  fixture.userBind.mockRejectedValueOnce(Object.assign(new Error("private connection detail"), { code }));
  await expect(authenticateLdap("alice", "password", cfg)).rejects.toMatchObject({ stage: "user_bind", cause: { code } });
  expect(fixture.unbind).toHaveBeenCalledTimes(2);
});

it("does not label an ambiguous size-limited search as an outage or bind as a user", async () => {
  fixture.search.mockRejectedValueOnce(new SizeLimitExceededError());
  expect(await authenticateLdap("alice", "password", cfg)).toBeNull();
  expect(fixture.userBind).not.toHaveBeenCalled();
});

it("classifies status/group failures and refuses unreadable AD status", async () => {
  fixture.search.mockResolvedValueOnce({ searchEntries: [entry] }).mockRejectedValueOnce(new Error("status failure"));
  await expect(authenticateLdap("alice", "password", { ...cfg, groupMode: "ad" })).rejects.toMatchObject({ stage: "account_status" });
  fixture.count = 0;
  fixture.search.mockResolvedValueOnce({ searchEntries: [entry] }).mockRejectedValueOnce(new Error("group failure"));
  await expect(authenticateLdap("alice", "password", { ...cfg, groupMode: "member" })).rejects.toMatchObject({ stage: "group_search" });
  fixture.count = 0;
  expect(await authenticateLdap("alice", "password", { ...cfg, groupMode: "ad" })).toBeNull();
});

it("preserves typed outage errors during passkey/ticket reads and password recovery", async () => {
  const identity = ldapEntryIdentity(entry, cfg)!;
  fixture.search.mockRejectedValueOnce(new Error("directory unavailable"));
  await expect(readLdapIdentity(entry.dn, identity, cfg)).rejects.toBeInstanceOf(LdapUnavailableError);
  fixture.count = 0;
  fixture.userBind.mockRejectedValueOnce(new Error("recovery transport failure"));
  await expect(authenticateLdapAtBinding(entry.dn, identity, "password", cfg)).rejects.toMatchObject({ stage: "user_bind" });
  fixture.count = 0;
  fixture.userBind.mockRejectedValueOnce(new InvalidCredentialsError());
  expect(await authenticateLdapAtBinding(entry.dn, identity, "wrong", cfg)).toBeNull();
  fixture.count = 0;
  expect(await readLdapIdentity(entry.dn, "replaced-identity", cfg)).toBeNull();
  expect(await authenticateLdapAtBinding(entry.dn, identity, "", cfg)).toBeNull();
});

it("keeps deleted bound accounts generic while treating a missing configured search base as an outage", async () => {
  fixture.search.mockRejectedValueOnce(new NoSuchObjectError());
  expect(await readLdapIdentity(entry.dn, ldapEntryIdentity(entry, cfg)!, cfg)).toBeNull();
  fixture.count = 0;
  fixture.search.mockRejectedValueOnce(new NoSuchObjectError());
  await expect(authenticateLdap("alice", "password", cfg)).rejects.toMatchObject({ stage: "identity_search" });
});

it("logs fixed operations and allowlisted codes without directory messages, credentials or injected codes", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  logLdapUnavailable(new LdapUnavailableError(Object.assign(new Error("synthetic-secret alice@fixture.invalid\nFORGED"), { code: "ECONNRESET" }), "user_bind"));
  expect(warn).toHaveBeenLastCalledWith("[auth] LDAP directory unavailable (user_bind; ECONNRESET)");
  logLdapUnavailable(new LdapUnavailableError(new InvalidCredentialsError("synthetic-secret"), "service_bind"));
  expect(warn).toHaveBeenLastCalledWith("[auth] LDAP directory unavailable (service_bind; LDAP_RESULT_49)");
  logLdapUnavailable(new LdapUnavailableError({ code: "injected-secret\nFORGED" }));
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(/synthetic-secret|alice@|FORGED|injected-secret/);
  warn.mockRestore();
});
