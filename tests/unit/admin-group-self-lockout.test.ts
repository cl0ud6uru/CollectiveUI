import { readFileSync, readdirSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const fixture = vi.hoisted(() => ({ client: null as PGlite | null, lookup: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@/db/schema");
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client, { schema }), schema };
});
vi.mock("@/lib/auth/ldap", async original => ({ ...await original<typeof import("@/lib/auth/ldap")>(), ldapEnabled: () => true, lookupLdapUser: fixture.lookup }));
import { db, schema } from "@/db";
import { deletePortalGroup, savePortalGroup, type GroupInput } from "@/lib/admin/groups";
import { loadPrincipal } from "@/lib/auth/groups";

const input: GroupInput = { id: "only-admins", name: "Only admins", isAdmin: true, canCreateBots: true, mappings: [], memberIds: ["actor"] };
const group = (id: string, isAdmin = true) => ({ id, name: id, isAdmin, canCreateBots: false });
async function snapshot() {
  return { groups: await db.select().from(schema.groups).orderBy(schema.groups.id),
    members: await db.select().from(schema.groupMembers).orderBy(schema.groupMembers.groupId, schema.groupMembers.userId),
    mappings: await db.select().from(schema.groupMappings).orderBy(schema.groupMappings.groupId) };
}
type Change = "role" | "members" | "mappings" | "delete";
async function change(kind: Change, actor = "actor") {
  if (kind === "delete") return deletePortalGroup(input.id!, actor);
  return savePortalGroup({ ...input, name: "Changed", ...(kind === "role" ? { isAdmin: false } : kind === "members" ? { memberIds: [] } : { mappings: [] }) }, actor);
}
async function mapped(source: "ldap" | "entra" = "ldap") {
  await db.delete(schema.groupMembers);
  await db.insert(schema.userExternalGroups).values({ userId: "actor", source, externalId: "fixture-admins" });
  await db.insert(schema.groupMappings).values({ groupId: input.id!, source, externalId: "fixture-admins" });
}
beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync("src/db/migrations").filter(file => file.endsWith(".sql")).sort()) {
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, "utf8").replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]"));
  }
}, 60000);
beforeEach(async () => {
  vi.stubEnv("ADMIN_UPNS", ""); vi.stubEnv("ADMIN_GROUPS", ""); vi.stubEnv("HERMES_TEAM_BOTS_ENABLED", "false");
  fixture.lookup.mockReset().mockResolvedValue({ upn: "new@fixture.invalid", name: "New fixture" });
  await fixture.client!.exec("TRUNCATE users, groups CASCADE");
  await db.insert(schema.users).values([
    { id: "actor", upn: "actor@fixture.invalid", name: "Actor", authSource: "ldap" },
    { id: "other-admin", upn: "other@fixture.invalid", name: "Other admin", authSource: "ldap", isAdmin: true },
  ]);
  await db.insert(schema.groups).values(group(input.id!));
  await db.insert(schema.groupMembers).values({ groupId: input.id!, userId: "actor" });
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await fixture.client!.close(); });

describe("acting admin group access protection on isolated SQL", () => {
  it.each(["role", "members", "delete"] as Change[])("rolls back a sole direct group's %s change with an actionable handoff error", async kind => {
    const before = await snapshot();
    await expect(change(kind)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/another administrator/i) });
    expect(await snapshot()).toEqual(before);
    expect((await loadPrincipal("actor"))?.isAdmin).toBe(true);
  });
  it.each(["ldap", "entra"] as const)("rolls back removing the sole %s admin mapping", async source => {
    await mapped(source);
    const before = await snapshot();
    await expect(savePortalGroup({ ...input, name: "Changed", memberIds: [], mappings: [] }, "actor")).rejects.toMatchObject({ status: 400 });
    expect(await snapshot()).toEqual(before);
  });
  it.each(["direct", "environment user", "environment group", "other direct group", "other mapped group"])("allows role, membership, mapping and deletion changes while retaining %s access", async grant => {
    if (grant === "direct") await db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.id, "actor"));
    if (grant === "environment user") vi.stubEnv("ADMIN_UPNS", "ACTOR@FIXTURE.INVALID");
    if (grant === "environment group" || grant === "other mapped group") {
      await db.insert(schema.userExternalGroups).values({ userId: "actor", source: "ldap", externalId: "backup-admins" });
      if (grant === "environment group") vi.stubEnv("ADMIN_GROUPS", "BACKUP-ADMINS");
    }
    if (grant.startsWith("other")) {
      await db.insert(schema.groups).values(group("backup"));
      if (grant === "other direct group") await db.insert(schema.groupMembers).values({ groupId: "backup", userId: "actor" });
      else await db.insert(schema.groupMappings).values({ groupId: "backup", source: "ldap", externalId: "backup-admins" });
    }
    for (const kind of ["role", "members", "mappings", "delete"] as Change[]) await change(kind);
    expect((await loadPrincipal("actor"))?.isAdmin).toBe(true);
    expect(await db.select().from(schema.groups).where(eq(schema.groups.id, input.id!))).toHaveLength(0);
  });
  it("allows removing direct membership when the same group's directory mapping still grants admin access", async () => {
    await db.insert(schema.userExternalGroups).values({ userId: "actor", source: "ldap", externalId: "fixture-admins" });
    await savePortalGroup({ ...input, memberIds: [], mappings: [{ source: "ldap", externalId: "fixture-admins" }] }, "actor");
    expect((await loadPrincipal("actor"))?.isAdmin).toBe(true);
  });
  it("allows removing a mapping while the same group's direct membership remains", async () => {
    await db.insert(schema.groupMappings).values({ groupId: input.id!, source: "ldap", externalId: "fixture-admins" });
    await change("mappings");
    expect((await loadPrincipal("actor"))?.isAdmin).toBe(true);
  });
  it("allows another administrator to perform an intentional handoff", async () => {
    await change("delete", "other-admin");
    expect((await loadPrincipal("actor"))?.isAdmin).toBe(false);
    expect((await loadPrincipal("other-admin"))?.isAdmin).toBe(true);
  });
  it("does not treat environment directory grants as a local account's fallback", async () => {
    await db.update(schema.users).set({ identityRealm: "local", authSource: "local" }).where(eq(schema.users.id, "actor"));
    vi.stubEnv("ADMIN_UPNS", "actor@fixture.invalid");
    vi.stubEnv("ADMIN_GROUPS", "fixture-admins");
    await db.insert(schema.userExternalGroups).values({ userId: "actor", source: "ldap", externalId: "fixture-admins" });
    await expect(change("delete")).rejects.toMatchObject({ status: 400 });
    expect((await loadPrincipal("actor"))?.isAdmin).toBe(true);
  });
  it("rolls back LDAP provisioning as well as group data when a save would remove the actor's last grant", async () => {
    await expect(savePortalGroup({ ...input, isAdmin: false, ldapUsernames: ["new"] }, "actor")).rejects.toMatchObject({ status: 400 });
    expect((await db.select().from(schema.users)).map(row => row.id).sort()).toEqual(["actor", "other-admin"]);
    expect((await loadPrincipal("actor"))?.isAdmin).toBe(true);
  });
  it.each(["revoked", "disabled", "missing"])("rejects a stale %s actor before mutation", async state => {
    if (state === "revoked") await db.delete(schema.groupMembers);
    if (state === "disabled") await db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, "actor"));
    const before = await snapshot();
    await expect(change("role", state === "missing" ? "absent" : "actor")).rejects.toMatchObject({ status: 403 });
    expect(await snapshot()).toEqual(before);
  });
  it("serializes competing removals and rolls back the change that would remove the final grant", async () => {
    await db.insert(schema.groups).values(group("backup"));
    await db.insert(schema.groupMembers).values({ groupId: "backup", userId: "actor" });
    const results = await Promise.allSettled([deletePortalGroup(input.id!, "actor"), deletePortalGroup("backup", "actor")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const failed = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ status: 400 });
    expect((await loadPrincipal("actor"))?.isAdmin).toBe(true);
  });
});
