import { beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ bind: vi.fn(), search: vi.fn(), unbind: vi.fn(), clients: vi.fn() }));
vi.mock("ldapts", () => ({ Client: class {
  bind = fixture.bind; search = fixture.search; unbind = fixture.unbind;
  constructor() { fixture.clients(); }
} }));
import { lookupLdapUser, ldapConfigFromEnv } from "@/lib/auth/ldap";
const cfg = { ...ldapConfigFromEnv(), url: "ldaps://fixture.invalid", baseDn: "dc=fixture", bindDn: "cn=service", bindPassword: "service-fixture", groupMode: "memberOf" as const, upnSuffix: "fixture.invalid" };
const entry = { dn: "uid=alice,dc=fixture", uid: "alice", cn: "Alice", entryUUID: "fixture-alice" };
beforeEach(() => {
  vi.clearAllMocks();
  fixture.bind.mockResolvedValue(undefined); fixture.unbind.mockResolvedValue(undefined);
  fixture.search.mockResolvedValue({ searchEntries: [entry] });
});
it("uses only the service bind and produces the same normalized sign-in UPN", async () => {
  expect(await lookupLdapUser("CORP\\alice", cfg)).toMatchObject({ upn: "alice@fixture.invalid", name: "Alice" });
  expect(fixture.clients).toHaveBeenCalledTimes(1);
  expect(fixture.bind).toHaveBeenCalledExactlyOnceWith(cfg.bindDn, cfg.bindPassword);
  expect(fixture.unbind).toHaveBeenCalledTimes(1);
});
it("escapes filter input and limits results to detect ambiguous identities", async () => {
  await lookupLdapUser("a*)(uid=*", cfg);
  expect(fixture.search).toHaveBeenCalledWith(cfg.baseDn, expect.objectContaining({ sizeLimit: 2, filter: cfg.userFilter.replaceAll("{{username}}", "a\\2a\\29\\28uid=\\2a") }));
  for (const entries of [[], [entry, entry]]) {
    fixture.search.mockResolvedValue({ searchEntries: entries });
    expect(await lookupLdapUser("alice", cfg)).toBeNull();
  }
});
it("reads constructed AD account status at the entry and denies disabled users", async () => {
  const adEntry = { ...entry, userAccountControl: "512", "msDS-User-Account-Control-Computed": "0" };
  fixture.search.mockResolvedValueOnce({ searchEntries: [entry] }).mockResolvedValueOnce({ searchEntries: [adEntry] });
  expect(await lookupLdapUser("alice", { ...cfg, groupMode: "ad" })).toMatchObject({ upn: "alice@fixture.invalid" });
  expect(fixture.search).toHaveBeenNthCalledWith(2, entry.dn, expect.objectContaining({ scope: "base" }));
  fixture.search.mockResolvedValue({ searchEntries: [{ ...entry, userAccountControl: "514" }] });
  expect(await lookupLdapUser("alice", cfg)).toBeNull();
});
it("unbinds on directory errors and avoids connecting for invalid input", async () => {
  fixture.search.mockRejectedValue(new Error("offline"));
  await expect(lookupLdapUser("alice", cfg)).rejects.toThrow("offline");
  expect(fixture.unbind).toHaveBeenCalledTimes(1);
  fixture.clients.mockClear();
  expect(await lookupLdapUser(" ", cfg)).toBeNull();
  expect(await lookupLdapUser("a".repeat(255), cfg)).toBeNull();
  expect(fixture.clients).not.toHaveBeenCalled();
});
