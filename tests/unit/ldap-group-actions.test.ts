import { beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";

const fixture = vi.hoisted(() => ({ admin: vi.fn(), find: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireAdmin: fixture.admin }));
vi.mock("@/lib/admin/groups", () => ({ findLdapGroupMember: fixture.find }));
vi.mock("@/app/admin/actions", () => ({ saveGroup: fixture.save }));
vi.mock("@/lib/authz", () => ({ HttpError: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
import { HttpError } from "@/lib/authz";
import { findLdapUserForGroup, saveGroupWithFeedback } from "@/app/admin/groups/ldap-actions";
const input = { name: "Helpdesk", isAdmin: false, canCreateBots: true, mappings: [], memberIds: [], ldapUsernames: ["alice"] };
beforeEach(() => { vi.resetAllMocks(); fixture.admin.mockResolvedValue({ user: { id: "admin" } }); });

it("returns serializable preview/save feedback for expected errors instead of production-masked exceptions", async () => {
  fixture.find.mockRejectedValueOnce(new HttpError(400, "No unique active LDAP user found. Use their exact username or UPN."));
  expect(await findLdapUserForGroup("alice")).toEqual({ ok: false, error: "No unique active LDAP user found. Use their exact username or UPN." });
  fixture.save.mockRejectedValueOnce(new HttpError(502, "LDAP lookup failed. Check directory settings."));
  expect(await saveGroupWithFeedback(input)).toEqual({ ok: false, error: "LDAP lookup failed. Check directory settings." });
  fixture.find.mockRejectedValueOnce(z.string().min(1).safeParse("").error);
  expect(await findLdapUserForGroup("")).toMatchObject({ ok: false, error: expect.stringContaining("exact LDAP username") });
});

it("returns approved preview fields and reuses the existing save/audit path", async () => {
  const member = { username: "alice", upn: "alice@fixture.invalid", name: "Alice", email: null };
  fixture.find.mockResolvedValueOnce(member);
  expect(await findLdapUserForGroup("alice")).toEqual({ ok: true, member });
  expect(await saveGroupWithFeedback(input)).toEqual({ ok: true });
  expect(fixture.save).toHaveBeenCalledExactlyOnceWith(input);
});

it("authorizes before lookup or mutation, and never serializes unexpected exception details", async () => {
  fixture.admin.mockRejectedValueOnce(new Error("forbidden"));
  await expect(findLdapUserForGroup("alice")).rejects.toThrow("forbidden");
  expect(fixture.find).not.toHaveBeenCalled();
  fixture.admin.mockRejectedValueOnce(new Error("forbidden"));
  await expect(saveGroupWithFeedback(input)).rejects.toThrow("forbidden");
  expect(fixture.save).not.toHaveBeenCalled();
  fixture.find.mockRejectedValueOnce(new Error("private SQL detail"));
  await expect(findLdapUserForGroup("alice")).rejects.toThrow("private SQL detail");
});
