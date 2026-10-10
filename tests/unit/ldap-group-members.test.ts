import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, beforeEach, afterAll, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
const fixture = vi.hoisted(() => ({ client: null as PGlite | null, lookup: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@/db/schema");
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client, { schema }), schema };
});
vi.mock("@/lib/auth/ldap", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/auth/ldap")>(), ldapEnabled: () => process.env.LDAP_ENABLED === "true", lookupLdapUser: fixture.lookup }));
import { db, schema } from "@/db";
import { findLdapGroupMember, savePortalGroup } from "@/lib/admin/groups";
import { loadPrincipal, syncUserOnSignIn } from "@/lib/auth/groups";
import { listAccessibleBots } from "@/lib/authz";
import { eq } from "drizzle-orm";

const identity = { dn: "uid=alice,dc=fixture", upn: "alice@fixture.invalid", name: "Alice", email: "alice@fixture.invalid", groups: [] };
const input = { name: "Helpdesk", isAdmin: false, canCreateBots: true, mappings: [], memberIds: [], ldapUsernames: ["alice"] };
beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync("src/db/migrations").filter(f => f.endsWith(".sql")).sort()) {
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, "utf8").replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]"));
  }
}, 45000);
beforeEach(async () => {
  vi.stubEnv("LDAP_ENABLED", "true");
  vi.clearAllMocks();
  fixture.lookup.mockResolvedValue(identity);
  await fixture.client!.exec("TRUNCATE users, groups CASCADE");
});
afterAll(async () => { vi.unstubAllEnvs(); await fixture.client?.close(); });

it("previews without provisioning, then grants group permissions that survive first sign-in", async () => {
  expect(await findLdapGroupMember(" alice ")).toMatchObject({ username: "alice", upn: identity.upn });
  expect(await db.select().from(schema.users)).toHaveLength(0);
  const groupId = await savePortalGroup(input, "admin");
  const [staged] = await db.select().from(schema.users);
  expect(staged.lastLoginAt).toBeNull();
  expect(await loadPrincipal(staged.id)).toMatchObject({ groupIds: [groupId], canCreateBots: true });
  const signedIn = await syncUserOnSignIn({ ...identity, source: "ldap" });
  expect(signedIn.id).toBe(staged.id);
  expect(signedIn.lastLoginAt).toBeInstanceOf(Date);
  expect(await loadPrincipal(signedIn.id)).toMatchObject({ groupIds: [groupId], canCreateBots: true });
  expect(await db.select().from(schema.users)).toHaveLength(1);
  const [owner] = await db.insert(schema.users).values({ upn: "owner@fixture.invalid", name: "Owner", authSource: "ldap" }).returning();
  const [bot] = await db.insert(schema.bots).values({ name: "Helpdesk bot", ownerId: owner.id, visibility: "groups" }).returning();
  await db.insert(schema.botAccess).values({ botId: bot.id, groupId });
  const principal = (await loadPrincipal(signedIn.id))!;
  expect(await listAccessibleBots({ ...principal, groupIds: [] })).toHaveLength(0);
  expect((await listAccessibleBots(principal)).map(b => b.id)).toEqual([bot.id]);
});

it("reuses existing directory users, deduplicates membership and preserves disable/login state", async () => {
  const [existing] = await db.insert(schema.users).values({ upn: identity.upn, name: "Existing", authSource: "entra", disabled: true, lastLoginAt: new Date(0) }).returning();
  await savePortalGroup({ ...input, memberIds: [existing.id], ldapUsernames: ["alice", "alice@fixture.invalid"] }, "admin");
  expect(await db.select().from(schema.groupMembers)).toHaveLength(1);
  expect(await db.select().from(schema.users)).toEqual([existing]);
});

it("keeps local and directory accounts separate even when their UPNs match", async () => {
  await db.insert(schema.users).values({ upn: identity.upn, name: "Local", identityRealm: "local", authSource: "local" });
  await savePortalGroup(input, "admin");
  const [membership] = await db.select().from(schema.groupMembers);
  const [member] = await db.select().from(schema.users).where(eq(schema.users.id, membership.userId));
  expect(member.identityRealm).toBe("directory");
  expect(await db.select().from(schema.users)).toHaveLength(2);
});

it("rejects missing users, outages and disabled LDAP without committing changes", async () => {
  fixture.lookup.mockResolvedValue(null);
  await expect(savePortalGroup(input, "admin")).rejects.toThrow("No unique active LDAP user");
  fixture.lookup.mockRejectedValue(new Error("private connection detail"));
  await expect(savePortalGroup(input, "admin")).rejects.toThrow("LDAP lookup failed");
  vi.stubEnv("LDAP_ENABLED", "false");
  await expect(savePortalGroup(input, "admin")).rejects.toThrow("LDAP is not enabled");
  expect(await db.select().from(schema.users)).toHaveLength(0);
  expect(await db.select().from(schema.groups)).toHaveLength(0);
});

it("rolls back provisioning when the group no longer exists", async () => {
  await expect(savePortalGroup({ ...input, id: "missing" }, "admin")).rejects.toThrow("Group no longer exists");
  expect(await db.select().from(schema.users)).toHaveLength(0);
});

it("preserves existing membership for clients omitting memberIds", async () => {
  const groupId = await savePortalGroup(input, "admin");
  fixture.lookup.mockResolvedValue({ ...identity, upn: "bob@fixture.invalid", name: "Bob" });
  await savePortalGroup({ ...input, id: groupId, memberIds: undefined, ldapUsernames: ["bob"] }, "admin");
  expect(await db.select().from(schema.groupMembers)).toHaveLength(2);
});

it("rechecks a preview on save and preserves all existing group data if the directory account changes", async () => {
  const groupId = await savePortalGroup(input, "admin");
  expect(await findLdapGroupMember("alice")).toMatchObject({ upn: identity.upn });
  const before = await db.select().from(schema.groups);
  const members = await db.select().from(schema.groupMembers);
  fixture.lookup.mockResolvedValueOnce(null);
  await expect(savePortalGroup({ ...input, id: groupId, name: "Changed", memberIds: [] }, "admin")).rejects.toThrow("No unique active LDAP user");
  expect(await db.select().from(schema.groups)).toEqual(before);
  expect(await db.select().from(schema.groupMembers)).toEqual(members);
});

it("allows explicit direct removal while retaining permissions inherited from a mapped directory group", async () => {
  const groupId = await savePortalGroup({ ...input, mappings: [{ source: "ldap", externalId: "cn=helpdesk,dc=fixture" }] }, "admin");
  const signedIn = await syncUserOnSignIn({ ...identity, source: "ldap", groups: [{ externalId: "cn=helpdesk,dc=fixture" }] });
  await savePortalGroup({ ...input, id: groupId, mappings: [{ source: "ldap", externalId: "cn=helpdesk,dc=fixture" }], memberIds: [], ldapUsernames: [] }, "admin");
  expect(await db.select().from(schema.groupMembers)).toHaveLength(0);
  expect(await loadPrincipal(signedIn.id)).toMatchObject({ groupIds: [groupId] });
});
