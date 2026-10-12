import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({
  db: null as unknown,
  allowed: new Set<string>(),
  client: null as unknown,
  principals: new Map<string, unknown>(),
  startHook: null as null | (() => Promise<void>),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/db", () => ({ get db() { return state.db; } }));
vi.mock("@/lib/workspaces/locks", () => ({ withWorkspaceUserLock: async (_userId: string, run: (database: unknown) => Promise<unknown>) => run(state.db) }));
vi.mock("@/lib/auth/groups", () => ({ loadPrincipal: async (userId: string) => state.principals.get(userId) ?? null }));
vi.mock("@/lib/authz", () => ({
  HttpError: class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } },
  getUsableBot: async (principal: { user: { id: string } }, botId: string) => {
    if (!state.allowed.has(`${principal.user.id}:${botId}`)) throw new Error("bot access denied");
    return { id: botId, enabled: true };
  },
}));
vi.mock("@/lib/settings", () => ({ getSetting: async () => ({ enabled: true, access: "everyone", allowRunc: true, deleteAfterDays: 30 }) }));
vi.mock("@/lib/sandbox/policy", () => ({ userMayUseWorkspace: () => true, requiredIsolation: () => "any" }));
vi.mock("@/lib/sandbox/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sandbox/client")>()),
  sandboxd: () => state.client,
}));

type Volume = { profileKey: string; files: Record<string, string> };

function fakeDaemon(volumes: Map<string, Volume>, unavailable: { profile: string | null }) {
  const running = new Set<string>();
  return {
    start: vi.fn(async (ref: string, _isolation: string, profileKey = "legacy") => {
      if (unavailable.profile === profileKey) {
        const { SandboxError } = await import("@/lib/sandbox/client");
        throw new SandboxError("image_missing", `missing ${profileKey}`);
      }
      const existing = volumes.get(ref);
      if (existing && existing.profileKey !== profileKey) throw new Error("profile mismatch");
      if (!existing) volumes.set(ref, { profileKey, files: {} });
      running.add(ref);
      if (state.startHook) await state.startHook();
      return { ref, state: "running", runtime: "runc", drift: false, createdAt: null, lastUsedAt: null, activeExecs: 0 };
    }),
    stop: vi.fn(async (ref: string) => { running.delete(ref); return { ref, state: "stopped" }; }),
    destroy: vi.fn(async (ref: string) => { running.delete(ref); volumes.delete(ref); return { destroyed: true }; }),
    list: vi.fn(async () => [...volumes.keys()].map((ref) => ({
      ref, state: running.has(ref) ? "running" : "stopped", runtime: "runc", drift: false,
      createdAt: new Date(Date.now() - 10_000).toISOString(), lastUsedAt: null, activeExecs: 0,
    }))),
    running,
  };
}

describe("workspace bindings (isolated PostgreSQL + fake sandbox client)", () => {
  let pg: PGlite;
  let folder: string;
  let assignTemplate: typeof import("@/lib/workspaces/instances")["assignTemplate"];
  let resolveWorkspace: typeof import("@/lib/workspaces/instances")["resolveWorkspace"];
  let listOwnInstances: typeof import("@/lib/workspaces/instances")["listOwnInstances"];
  const volumes = new Map<string, Volume>();
  const unavailable = { profile: null as string | null };
  const aliceLegacyRef = "legacyabcdefghijklmn"; // 20 lower-case characters
  const alice = { user: { id: "alice", upn: "alice@example.invalid", name: "Alice", disabled: false, sessionVersion: 1 }, groupIds: [], isAdmin: false } as never;
  const bob = { user: { id: "bob", upn: "bob@example.invalid", name: "Bob", disabled: false, sessionVersion: 1 }, groupIds: [], isAdmin: false } as never;

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`CREATE TABLE users(id text PRIMARY KEY, disabled boolean NOT NULL DEFAULT false, session_version integer NOT NULL DEFAULT 1);
      CREATE TABLE bots(id text PRIMARY KEY, owner_id text REFERENCES users(id) ON DELETE CASCADE);
      CREATE TABLE sandboxes(user_id text PRIMARY KEY REFERENCES users(id), ref text UNIQUE NOT NULL,
        last_used_at timestamptz, delete_after timestamptz, created_at timestamptz NOT NULL);
      INSERT INTO users VALUES ('alice'), ('bob');
      INSERT INTO bots VALUES ('shared-bot','alice'), ('alice-bot','alice'), ('unbound-bot','alice'), ('alice-revoked-bot','alice'), ('bob-unbound-bot','bob'), ('bob-reservation-bot','bob');
      INSERT INTO sandboxes VALUES ('alice','${aliceLegacyRef}','2026-10-01Z',NULL,'2026-09-01Z');`);
    folder = await mkdtemp(path.join(tmpdir(), "workspace-bindings-"));
    await mkdir(path.join(folder, "meta"));
    const sql = await readFile("src/db/migrations/0054_workspace_contract_foundation.sql", "utf8");
    await writeFile(path.join(folder, "0054_workspace_contract_foundation.sql"), sql);
    const journal = JSON.parse(await readFile("src/db/migrations/meta/_journal.json", "utf8"));
    await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify({
      ...journal,
      entries: [journal.entries.find((entry: { tag: string }) => entry.tag === "0054_workspace_contract_foundation")],
    }));
    await migrate(drizzle(pg), { migrationsFolder: folder });
    state.db = drizzle(pg);
    state.principals.set("alice", alice);
    state.principals.set("bob", bob);
    state.allowed.add("alice:shared-bot");
    state.allowed.add("bob:shared-bot");
    state.allowed.add("alice:alice-bot");
    state.allowed.add("alice:unbound-bot");
    state.allowed.add("alice:alice-revoked-bot");
    state.allowed.add("bob:bob-unbound-bot");
    state.allowed.add("bob:bob-reservation-bot");
    state.client = fakeDaemon(volumes, unavailable);
    const service = await import("@/lib/workspaces/instances");
    assignTemplate = service.assignTemplate;
    resolveWorkspace = service.resolveWorkspace;
    listOwnInstances = service.listOwnInstances;

    const { db } = await import("@/db");
    const { workspaceTemplates, workspaceTemplateVersions } = await import("@/db/schema");
    await db.insert(workspaceTemplates).values([
      { id: "office", slug: "knowledge-work", name: "Knowledge Work", description: "Office" },
      { id: "dotnet", slug: "dotnet-linux", name: ".NET Linux", description: "Offline SDK" },
    ]);
    const { WORKSPACE_PROFILES } = await import("@/sandboxd/profiles");
    WORKSPACE_PROFILES["knowledge-work-v1"].imageRef = `sha256:${"a".repeat(64)}`;
    WORKSPACE_PROFILES["dotnet-linux-v1"].imageRef = `sha256:${"b".repeat(64)}`;
    const officeRecipe = { schemaVersion: 1, runtimeProfileKey: "knowledge-work-v1", seedBundleKey: "knowledge-work-v1", networkPolicy: "none", capabilities: { shell: true, officeHeadless: true, dotnet: false, agentBrowserView: false } } as const;
    const dotnetRecipe = { schemaVersion: 1, runtimeProfileKey: "dotnet-linux-v1", seedBundleKey: "dotnet-linux-v1", networkPolicy: "none", capabilities: { shell: true, officeHeadless: false, dotnet: true, agentBrowserView: false } } as const;
    await db.insert(workspaceTemplateVersions).values([
      { id: "office-v1", templateId: "office", version: 1, recipe: officeRecipe, recipeHash: "a".repeat(64), publishedAt: new Date("2026-10-01Z") },
      { id: "office-v2", templateId: "office", version: 2, recipe: officeRecipe, recipeHash: "b".repeat(64), publishedAt: new Date("2026-10-02Z") },
      { id: "dotnet-v1", templateId: "dotnet", version: 1, recipe: dotnetRecipe, recipeHash: "c".repeat(64), publishedAt: new Date("2026-10-03Z") },
    ]);
    volumes.set(aliceLegacyRef, { profileKey: "legacy", files: { "legacy.txt": "old personal files" } });
  }, 30_000);

  beforeEach(() => { unavailable.profile = null; state.startHook = null; });

  afterAll(async () => {
    const { WORKSPACE_PROFILES } = await import("@/sandboxd/profiles");
    WORKSPACE_PROFILES["knowledge-work-v1"].imageRef = null;
    WORKSPACE_PROFILES["dotnet-linux-v1"].imageRef = null;
    await pg?.close();
    if (folder) await rm(folder, { recursive: true, force: true });
  });

  it("keeps each shared-bot user and each same-user bot on a different ref", async () => {
    const aliceInstance = await assignTemplate({ principal: alice, botId: "shared-bot", templateVersionId: "office-v1" });
    const aliceResolved = await resolveWorkspace({ principal: alice, botId: "shared-bot", createIfMissing: false });
    expect(aliceResolved?.instanceId).toBe(aliceInstance.id);
    expect(aliceResolved?.sandboxRef).toBeTruthy();

    const bobInstance = await assignTemplate({ principal: bob, botId: "shared-bot", templateVersionId: "office-v1" });
    const bobResolved = await resolveWorkspace({ principal: bob, botId: "shared-bot", createIfMissing: false });
    expect(bobResolved?.instanceId).toBe(bobInstance.id);
    expect(bobResolved?.sandboxRef).not.toBe(aliceResolved?.sandboxRef);

    const secondAliceBot = await assignTemplate({ principal: alice, botId: "alice-bot", templateVersionId: "office-v1" });
    expect(secondAliceBot.id).not.toBe(aliceInstance.id);
    expect((await resolveWorkspace({ principal: alice, botId: "alice-bot", createIfMissing: false }))?.sandboxRef).not.toBe(aliceResolved?.sandboxRef);
    await expect(assignTemplate({ principal: bob, botId: "alice-bot", templateVersionId: "office-v1" })).rejects.toThrow(/access denied/);
  });

  it("is idempotent for concurrent same-version assignments", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => assignTemplate({
      principal: alice, botId: "shared-bot", templateVersionId: "office-v1",
    })));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(new Set(results.map((r) => r.state))).toEqual(new Set(["ready"]));
  });

  it("commits a provisioning reservation before daemon volume creation so orphan sweep preserves it", async () => {
    const { db } = await import("@/db");
    const { workspaceInstances } = await import("@/db/schema");
    const daemon = state.client as ReturnType<typeof fakeDaemon>;
    let announceStarted!: () => void;
    let releaseStart!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseStart = resolve; });
    state.startHook = async () => { announceStarted(); await blocked; };

    const pending = assignTemplate({ principal: bob, botId: "bob-reservation-bot", templateVersionId: "office-v1" });
    await started;
    const [reservation] = await db.select().from(workspaceInstances)
      .where(and(eq(workspaceInstances.ownerUserId, "bob"), eq(workspaceInstances.provisionState, "provisioning")));
    expect(reservation?.provisionState).toBe("provisioning");

    const { sweepSandboxes } = await import("@/lib/sandbox/lifecycle");
    const sweep = await sweepSandboxes(new Date());
    expect(sweep.orphans).toBe(0);
    expect(daemon.destroy).not.toHaveBeenCalledWith(reservation?.sandboxRef);
    releaseStart();
    await pending;
  });

  it("rechecks disabled state and session version after provisioning before keeping a bot binding", async () => {
    const { db } = await import("@/db");
    const { users, workspaceInstances, workspaceBotBindings } = await import("@/db/schema");
    let announceStarted!: () => void;
    let releaseStart!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseStart = resolve; });
    state.startHook = async () => { announceStarted(); await blocked; };

    const pending = assignTemplate({ principal: alice, botId: "unbound-bot", templateVersionId: "office-v1" });
    await started;
    await db.update(users).set({ disabled: true, sessionVersion: 2 }).where(eq(users.id, "alice"));
    releaseStart();
    await expect(pending).rejects.toMatchObject({ status: 401 });

    expect(await db.select().from(workspaceBotBindings).where(eq(workspaceBotBindings.botId, "unbound-bot"))).toHaveLength(0);
    const reservations = await db.select().from(workspaceInstances).where(and(eq(workspaceInstances.ownerUserId, "alice"), eq(workspaceInstances.templateVersionId, "office-v1")));
    expect(reservations.some((row) => row.provisionState === "unavailable" && row.deleteAfter !== null)).toBe(true);
    await db.update(users).set({ disabled: false, sessionVersion: 1 }).where(eq(users.id, "alice"));
  });

  it("rechecks bot access after provisioning and removes a revoked provisional binding", async () => {
    const { db } = await import("@/db");
    const { workspaceBotBindings } = await import("@/db/schema");
    let announceStarted!: () => void;
    let releaseStart!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseStart = resolve; });
    state.startHook = async () => { announceStarted(); await blocked; };

    const pending = assignTemplate({ principal: alice, botId: "alice-revoked-bot", templateVersionId: "office-v1" });
    await started;
    state.allowed.delete("alice:alice-revoked-bot");
    releaseStart();
    await expect(pending).rejects.toThrow(/access denied/);
    expect(await db.select().from(workspaceBotBindings).where(eq(workspaceBotBindings.botId, "alice-revoked-bot"))).toHaveLength(0);
    state.allowed.add("alice:alice-revoked-bot");
  });

  it("persists files through stop and daemon restart, and keeps replaced versions intact", async () => {
    const first = await resolveWorkspace({ principal: alice, botId: "shared-bot", createIfMissing: false });
    expect(first).not.toBeNull();
    volumes.get(first!.sandboxRef)!.files["project.txt"] = "kept across replacement";
    const oldRef = first!.sandboxRef;
    const daemon = state.client as ReturnType<typeof fakeDaemon>;
    await daemon.stop(oldRef);
    state.client = fakeDaemon(volumes, unavailable); // new daemon process, same persistent volumes
    await assignTemplate({ principal: alice, botId: "shared-bot", templateVersionId: "office-v1" });
    expect(volumes.get(oldRef)?.files["project.txt"]).toBe("kept across replacement");

    const replacement = await assignTemplate({ principal: alice, botId: "shared-bot", templateVersionId: "office-v2" });
    const current = await resolveWorkspace({ principal: alice, botId: "shared-bot", createIfMissing: false });
    expect(current?.sandboxRef).not.toBe(oldRef);
    expect(replacement.templateVersionId).toBe("office-v2");
    expect(volumes.get(oldRef)?.files["project.txt"]).toBe("kept across replacement");
  });

  it("leaves the old binding intact when a replacement image is unavailable", async () => {
    const current = await resolveWorkspace({ principal: alice, botId: "shared-bot", createIfMissing: false });
    expect(current?.templateVersionId).toBe("office-v2");
    volumes.get(current!.sandboxRef)!.files["safe.txt"] = "still bound";
    unavailable.profile = "dotnet-linux-v1";
    await expect(assignTemplate({ principal: alice, botId: "shared-bot", templateVersionId: "dotnet-v1" })).rejects.toMatchObject({ code: "image_missing" });
    const after = await resolveWorkspace({ principal: alice, botId: "shared-bot", createIfMissing: false });
    expect(after?.instanceId).toBe(current?.instanceId);
    expect(after?.templateVersionId).toBe("office-v2");
    expect(volumes.get(current!.sandboxRef)?.files["safe.txt"]).toBe("still bound");
  });

  it("keeps the migrated legacy ref and files for unbound bots and never provisions on read", async () => {
    const { db } = await import("@/db");
    const { workspaceInstances, workspaceBotBindings } = await import("@/db/schema");
    const startsBeforeRead = (state.client as ReturnType<typeof fakeDaemon>).start.mock.calls.length;
    const legacy = await resolveWorkspace({ principal: alice, botId: "unbound-bot", createIfMissing: false });
    expect(legacy?.sandboxRef).toBe(aliceLegacyRef);
    expect(volumes.get(aliceLegacyRef)?.files["legacy.txt"]).toBe("old personal files");
    const bindings = await db.select().from(workspaceBotBindings).where(and(eq(workspaceBotBindings.userId, "alice"), eq(workspaceBotBindings.botId, "unbound-bot")));
    expect(bindings).toHaveLength(0);
    const instance = (await db.select().from(workspaceInstances).where(eq(workspaceInstances.id, legacy!.instanceId)))[0];
    expect(instance).toMatchObject({ origin: "legacy_personal", sandboxRef: aliceLegacyRef, runtimeProfileKey: "legacy" });
    expect((state.client as ReturnType<typeof fakeDaemon>).start).toHaveBeenCalledTimes(startsBeforeRead);
    const { touchWorkspaceInstance } = await import("@/lib/sandbox/store");
    await touchWorkspaceInstance(instance.id, "alice");
    const { sandboxes } = await import("@/db/schema");
    const [legacyRow] = await db.select().from(sandboxes).where(eq(sandboxes.userId, "alice"));
    expect(legacyRow.ref).toBe(aliceLegacyRef);
    expect(legacyRow.lastUsedAt?.getTime()).toBeGreaterThanOrEqual(new Date("2026-10-01Z").getTime());

    const noWorkspace = await resolveWorkspace({ principal: bob, botId: "bob-unbound-bot", createIfMissing: false });
    expect(noWorkspace).toBeNull();
  });

  it("reconciles old-binary legacy timestamps, disable deadlines, and re-enable clears", async () => {
    const { db } = await import("@/db");
    const { sandboxes, workspaceInstances, users } = await import("@/db/schema");
    const { ensureLegacyInstance } = await import("@/lib/sandbox/store");
    const { sweepSandboxes } = await import("@/lib/sandbox/lifecycle");
    await resolveWorkspace({ principal: alice, botId: "unbound-bot", createIfMissing: false });
    const lastUsedAt = new Date("2026-10-05T00:00:00Z");
    const deleteAfter = new Date("2026-10-20T00:00:00Z");
    await db.update(sandboxes).set({ lastUsedAt, deleteAfter }).where(eq(sandboxes.userId, "alice"));
    const legacy = await ensureLegacyInstance("alice", aliceLegacyRef);
    expect(legacy?.lastUsedAt?.getTime()).toBe(lastUsedAt.getTime());
    expect(legacy?.deleteAfter?.getTime()).toBe(deleteAfter.getTime());

    await db.update(users).set({ disabled: true }).where(eq(users.id, "alice"));
    await db.update(workspaceInstances).set({ deleteAfter: new Date("2026-10-15T00:00:00Z") }).where(eq(workspaceInstances.ownerUserId, "alice"));
    await sweepSandboxes(new Date("2026-10-10T00:00:00Z"));
    const disabledRows = await db.select().from(workspaceInstances).where(eq(workspaceInstances.ownerUserId, "alice"));
    expect(disabledRows.every((row) => row.deleteAfter?.getTime() === deleteAfter.getTime())).toBe(true);

    await db.update(sandboxes).set({ deleteAfter: null }).where(eq(sandboxes.userId, "alice"));
    await db.update(users).set({ disabled: false }).where(eq(users.id, "alice"));
    await sweepSandboxes(new Date("2026-10-10T00:00:00Z"));
    const enabledRows = await db.select().from(workspaceInstances).where(eq(workspaceInstances.ownerUserId, "alice"));
    expect(enabledRows.every((row) => row.deleteAfter === null)).toBe(true);
  });

  it("enforces the owner/instance composite foreign key and returns only owner DTOs", async () => {
    const { db } = await import("@/db");
    const { workspaceBotBindings } = await import("@/db/schema");
    const aliceResolved = await resolveWorkspace({ principal: alice, botId: "shared-bot", createIfMissing: false });
    await expect(db.insert(workspaceBotBindings).values({ userId: "bob", botId: "alice-bot", instanceId: aliceResolved!.instanceId })).rejects.toThrow();
    const bobInstances = await listOwnInstances(bob);
    expect(bobInstances.every((instance) => !("sandboxRef" in instance) && !("runtimeProfileKey" in instance))).toBe(true);
    expect(bobInstances.some((instance) => instance.id === aliceResolved!.instanceId)).toBe(false);
  });
});
