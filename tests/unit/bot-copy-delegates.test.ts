import { readFileSync, readdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Principal } from "@/lib/auth/groups";
const fixture = vi.hoisted(() => ({ client: null as PGlite | null, principal: null as Principal | null, failDelegate: "" }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath() {} }));
vi.mock("@/lib/session", () => ({ requirePrincipal: async () => fixture.principal! }));
vi.mock("@/lib/authz", async original => {
  const actual = await original<typeof import("@/lib/authz")>();
  return { ...actual, getAccessibleBot: async (...args: Parameters<typeof actual.getAccessibleBot>) => {
    if (args[1] === fixture.failDelegate) throw new Error("Synthetic database failure");
    return actual.getAccessibleBot(...args);
  } };
});
vi.mock("@/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@/db/schema");
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client, { schema }), schema };
});
import { db, schema as s } from "@/db";
import { loadPrincipal } from "@/lib/auth/groups";
import { createBot, duplicateBot, updateBot, type BotInput } from "@/app/(chat)/bots/actions";

beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync("src/db/migrations").filter(f => f.endsWith(".sql")).sort())
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, "utf8").replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]"));
}, 45_000);
beforeEach(async () => {
  fixture.failDelegate = "";
  await fixture.client!.exec("TRUNCATE users, ai_apps, settings CASCADE");
  await db.insert(s.users).values(["owner", "copier"].map(id => ({ id, name: id, upn: `${id}@fixture.invalid`, identityRealm: "local" as const, authSource: "local" as const })));
  await db.insert(s.aiApps).values([
    { id: "model", name: "Synthetic model", provider: "openai-compatible", baseUrl: "https://unused.invalid/v1", model: "fixture", isPublic: true, supportsTools: true },
    { id: "remote", name: "Remote Hermes", provider: "hermes", baseUrl: "https://unused.invalid/api", model: "fixture", isPublic: true },
    { id: "local", name: "Local Hermes", provider: "hermes", baseUrl: "https://unused.invalid/api", model: "fixture", isPublic: true, providerConfig: { local: {} } },
  ]);
  await db.insert(s.bots).values([
    { id: "source", ownerId: "owner", appId: "model", name: "Shared bot", visibility: "org", instructions: "Keep these instructions", starters: ["Hello"] },
    { id: "public", ownerId: "owner", appId: "model", name: "Public delegate", visibility: "org" },
    { id: "own", ownerId: "copier", appId: "model", name: "Own delegate", visibility: "private" },
    { id: "hidden", ownerId: "owner", appId: "model", name: "Private delegate", visibility: "private" },
    { id: "local", ownerId: "owner", appId: "local", name: "Local delegate", visibility: "org" },
    { id: "remote", ownerId: "owner", appId: "remote", name: "Portable Hermes", visibility: "org" },
    { id: "service", ownerId: "owner", appId: "model", name: "Service delegate", visibility: "org", executionMode: "service" },
    { id: "team", ownerId: "owner", appId: "model", name: "Team delegate", visibility: "org", hermesTeam: true },
    { id: "no-model", ownerId: "owner", appId: null, name: "Codex delegate", visibility: "org" },
  ]);
  fixture.principal = (await loadPrincipal("copier"))!;
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Network access is prohibited in bot-copy fixture"); }));
});
afterAll(async () => { vi.unstubAllGlobals(); await fixture.client!.close(); });
const relations = async (id: string) => (await db.select().from(s.botDelegates).where(eq(s.botDelegates.botId, id))).map(row => row.delegateBotId).sort();
async function link(ids: string[]) { await db.insert(s.botDelegates).values(ids.map(delegateBotId => ({ botId: "source", delegateBotId }))); }
const input = (id: string): BotInput => ({ name: "New bot", appId: "model", visibility: "private", groupIds: [], maxSteps: 5, starters: [], tools: [], delegateIds: [id], executionMode: "caller" });

describe("copied bot delegates (production actions and embedded PostgreSQL)", () => {
  it("omits the owner's private delegate while retaining public and copier-owned delegates", async () => {
    await link(["hidden", "public", "own"]);
    const before = await relations("source"), copy = await duplicateBot("source");
    expect(await relations(copy.id)).toEqual(["own", "public"]);
    expect(await relations("source")).toEqual(before);
    expect((await db.select().from(s.bots).where(eq(s.bots.id, copy.id)))[0]).toMatchObject({ name: "Shared bot copy", ownerId: "copier", visibility: "private", appId: "model", instructions: "Keep these instructions", starters: ["Hello"] });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("omits local, model-less, Team and service delegates while retaining portable remote Hermes", async () => {
    await link(["local", "no-model", "team", "service", "remote", "public"]);
    const copy = await duplicateBot("source");
    expect(await relations(copy.id)).toEqual(["public", "remote"]);
    expect(await relations("source")).toEqual(["local", "no-model", "public", "remote", "service", "team"]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("retains a private delegate when the copier has an explicit user grant", async () => {
    await db.update(s.bots).set({ visibility: "groups" }).where(eq(s.bots.id, "hidden"));
    await db.insert(s.botUserAccess).values({ botId: "hidden", userId: "copier" });
    await link(["hidden", "public"]);
    expect(await relations((await duplicateBot("source")).id)).toEqual(["hidden", "public"]);
  });
  it("copies without delegates when every original delegate is unavailable", async () => {
    await link(["hidden", "service"]);
    expect(await relations((await duplicateBot("source")).id)).toEqual([]);
  });
  it.each(["hidden", "local", "no-model", "team", "service"])("keeps explicit create and edit validation strict for %s", async delegate => {
    await expect(createBot(input(delegate))).rejects.toMatchObject({ status: delegate === "hidden" ? 403 : 400 });
    await expect(updateBot("own", input(delegate))).rejects.toMatchObject({ status: delegate === "hidden" ? 403 : 400 });
    expect(await relations("own")).toEqual([]);
  });
  it("still requires access to the source and its original connection", async () => {
    await expect(duplicateBot("hidden")).rejects.toMatchObject({ status: 403 });
    await db.update(s.aiApps).set({ enabled: false }).where(eq(s.aiApps.id, "model"));
    await expect(duplicateBot("source")).rejects.toThrow("source bot connection is unavailable");
    expect((await db.select().from(s.bots)).length).toBe(9);
  });
  it("does not turn a delegate database failure into a successful partial copy", async () => {
    await link(["public"]); fixture.failDelegate = "public";
    await expect(duplicateBot("source")).rejects.toThrow("Synthetic database failure");
    expect((await db.select().from(s.bots)).length).toBe(9);
  });
  it("still enforces bot creation policy", async () => {
    await db.insert(s.settings).values({ key: "tools", value: { botCreation: "admins" } });
    await expect(duplicateBot("source")).rejects.toMatchObject({ status: 403 });
    expect((await db.select().from(s.bots)).length).toBe(9);
  });
});
