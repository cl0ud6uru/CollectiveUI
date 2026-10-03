import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";
import type { Principal } from "@/lib/auth/groups";
import { startMockLlm } from "./helpers/mock-llm";

const session = vi.hoisted(() => ({ principal: null as Principal | null }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/session", () => ({ requirePrincipal: async () => session.principal! }));
vi.mock("@/lib/jobs", () => ({ enqueue: vi.fn(), QUEUES: {}, enqueueRun: vi.fn(), scheduleMemoryExtraction: vi.fn() }));

const run = process.env.DATABASE_URL ? describe : describe.skip;
run("Draft my bot (issue #18, #32) against the mock model", () => {
  let mock: Awaited<ReturnType<typeof startMockLlm>>;
  let originalTools: Awaited<ReturnType<typeof import("@/lib/settings").getSetting<"tools">>>;
  const userIds: string[] = [], appIds: string[] = [];
  const stamp = `draft-${process.pid}-${Date.now()}`;

  beforeAll(async () => {
    mock = await startMockLlm();
    const { db, schema } = await import("@/db");
    const { getSetting } = await import("@/lib/settings");
    const { loadPrincipal } = await import("@/lib/auth/groups");
    originalTools = await getSetting("tools");
    const [user] = await db.insert(schema.users).values({ id: `${stamp}-user`, upn: `${stamp}@test.invalid`, name: "Draft Tester", authSource: "ldap" }).returning();
    userIds.push(user.id);
    session.principal = (await loadPrincipal(user.id))!;
    const [app] = await db.insert(schema.aiApps).values({ name: `${stamp} utility`, provider: "openai-compatible", baseUrl: `${mock.url}/v1`, model: "mock-gpt", isPublic: true }).returning();
    appIds.push(app.id);
  });

  afterAll(async () => {
    const { db, schema, pool } = await import("@/db");
    const { setSetting } = await import("@/lib/settings");
    await setSetting("tools", originalTools);
    if (appIds.length) await db.delete(schema.aiApps).where(inArray(schema.aiApps.id, appIds));
    if (userIds.length) await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    mock?.stop();
    await pool.end();
  });

  const useUtility = async (utilityAppId: string | undefined) => {
    const { setSetting } = await import("@/lib/settings");
    await setSetting("tools", { ...originalTools, utilityAppId });
  };

  it("explains a missing utility model instead of throwing (no silent fallback)", async () => {
    const { draftBotFromDescription } = await import("@/app/(chat)/bots/actions");
    const { NO_UTILITY_MODEL } = await import("@/lib/bots/draft");
    await useUtility(undefined);
    await expect(draftBotFromDescription("A bot that triages the support inbox")).resolves.toEqual({ ok: false, error: NO_UTILITY_MODEL });
    await useUtility("missing-app-id");
    await expect(draftBotFromDescription("A bot that triages the support inbox")).resolves.toEqual({ ok: false, error: NO_UTILITY_MODEL });
    await expect(draftBotFromDescription("   ")).resolves.toMatchObject({ ok: false, error: "Describe the bot first." });
  });

  it("drafts a bot whose starters are user requests and whose tools are available", async () => {
    const { draftBotFromDescription } = await import("@/app/(chat)/bots/actions");
    const { availableBuiltinKeys } = await import("@/lib/bots/available-tools");
    await useUtility(appIds[0]);
    const result = await draftBotFromDescription("Support inbox triage for the help desk");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.name).toMatch(/Support inbox triage/);
    expect(result.draft.starters).toEqual(["Help me draft an email.", "Summarize this and list the action items."]);
    const available = await availableBuiltinKeys(session.principal!);
    for (const key of result.draft.tools) expect(available.has(key)).toBe(true);
  });

  it("returns safe messages for provider rejections and malformed output", async () => {
    const { draftBotFromDescription } = await import("@/app/(chat)/bots/actions");
    const { INCOMPLETE_DRAFT, PROVIDER_REJECTED } = await import("@/lib/bots/draft");
    await useUtility(appIds[0]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const rejected = await draftBotFromDescription("A bot [draft:reject]");
      expect(rejected).toMatchObject({ ok: false });
      if (rejected.ok) return;
      expect(rejected.error.startsWith(PROVIDER_REJECTED)).toBe(true);
      expect(rejected.error).not.toContain("sk-mock-provider-detail");
      const malformed = await draftBotFromDescription("A bot [draft:malformed]");
      expect(malformed).toMatchObject({ ok: false });
      if (malformed.ok) return;
      expect(malformed.error.startsWith(INCOMPLETE_DRAFT)).toBe(true);
      expect(JSON.stringify(errors.mock.calls)).not.toContain("sk-mock-provider-detail");
    } finally {
      errors.mockRestore();
    }
  });
});
