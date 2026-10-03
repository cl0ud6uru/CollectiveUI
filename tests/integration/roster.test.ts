import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "@/lib/auth/groups";

const run = process.env.DATABASE_URL ? describe : describe.skip;

/** Sidebar roster details and the bot panel's workspace "screen" only ever show the acting person's own work. */
run("bot roster and workspace preview (real Postgres)", () => {
  let alice: Principal;
  let bob: Principal;
  let botId: string;
  let appId: string;
  let previousSandbox: unknown;
  const userIds: string[] = [];

  beforeAll(async () => {
    const { db, schema } = await import("@/db");
    const { newId } = await import("@/lib/ids");
    const { getSetting } = await import("@/lib/settings");
    previousSandbox = await getSetting("sandbox");
    for (const name of ["Alice", "Bob"]) {
      const id = `it-roster-${newId()}`;
      const [user] = await db.insert(schema.users).values({ id, upn: `${id}@corp.local`, name, authSource: "ldap" }).returning();
      userIds.push(id);
      const principal = { user, groupIds: [], isAdmin: false, canCreateBots: true };
      if (name === "Alice") alice = principal;
      else bob = principal;
    }
    const [app] = await db.insert(schema.aiApps).values({ name: "IT Roster model", model: "mock", baseUrl: "http://localhost:4010/v1" }).returning();
    appId = app.id;
    const [bot] = await db.insert(schema.bots).values({ ownerId: alice.user.id, name: "IT Roster bot", appId, visibility: "org" }).returning();
    botId = bot.id;
  });

  afterAll(async () => {
    const { db, pool, schema } = await import("@/db");
    const { setSetting } = await import("@/lib/settings");
    await setSetting("sandbox", previousSandbox as never);
    await db.delete(schema.bots).where(eq(schema.bots.id, botId));
    await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    await db.delete(schema.aiApps).where(eq(schema.aiApps.id, appId));
    await pool.end();
  });

  async function home(p: Principal, lines: { role: "user" | "assistant"; text: string; parts?: unknown[] }[], isBotHome = true) {
    const { db, schema } = await import("@/db");
    const [c] = await db.insert(schema.conversations).values({ userId: p.user.id, botId, title: isBotHome ? "Home" : "Side chat", isBotHome }).returning();
    let t = Date.now() - lines.length * 1000;
    for (const [i, l] of lines.entries()) {
      await db.insert(schema.messages).values({
        id: `${c.id}-${i}`, conversationId: c.id, role: l.role, parts: l.parts ?? [{ type: "text", text: l.text }], searchText: l.text, createdAt: new Date((t += 1000)),
      });
    }
    return c;
  }

  it("previews each person's own home and marks only their own busy runs", async () => {
    const { db, schema } = await import("@/db");
    const { loadBotRoster } = await import("@/lib/chat/roster");
    const aliceHome = await home(alice, [{ role: "user", text: "find the owner" }, { role: "assistant", text: "**Payments** is owned by Dana." }]);
    const bobHome = await home(bob, [{ role: "user", text: "bob's private question" }]);
    await db.insert(schema.agentRuns).values({ userId: bob.user.id, conversationId: bobHome.id, messageId: `${bobHome.id}-reply`, botId, status: "running" });

    const forAlice = await loadBotRoster(alice.user.id, [{ botId, conversationId: aliceHome.id, updatedAt: aliceHome.updatedAt }]);
    expect(forAlice.get(botId)).toEqual({ preview: "Payments is owned by Dana.", lastAt: aliceHome.updatedAt.toISOString(), status: null });

    const forBob = await loadBotRoster(bob.user.id, [{ botId, conversationId: bobHome.id, updatedAt: bobHome.updatedAt }]);
    expect(forBob.get(botId)).toMatchObject({ preview: "You: bob's private question", status: "working" });

    await db.insert(schema.agentRuns).values({ userId: alice.user.id, conversationId: aliceHome.id, messageId: `${aliceHome.id}-ask`, botId, status: "waiting" });
    expect((await loadBotRoster(alice.user.id, [{ botId, conversationId: aliceHome.id, updatedAt: aliceHome.updatedAt }])).get(botId)?.status).toBe("waiting");
  });

  it("shows a workspace screen only for workspace bots, with the person's own latest command", async () => {
    const { db, schema } = await import("@/db");
    const { setSetting, getSetting } = await import("@/lib/settings");
    const { loadWorkspacePreview } = await import("@/lib/chat/activity");
    await setSetting("sandbox", { ...(await getSetting("sandbox")), enabled: true, access: "everyone" });
    expect(await loadWorkspacePreview(alice, botId)).toBeNull(); // no workspace tool

    await db.insert(schema.botTools).values({ botId, toolKey: "workspace", approval: "ask" });
    const bash = (command: string, stdout: string) => [{ type: "tool-workspace_bash", toolCallId: command, state: "output-available", input: { command }, output: { status: "done", ok: true, exitCode: 0, stdout, stderr: "" } }];
    await home(bob, [{ role: "assistant", text: "", parts: bash("cat bob-secrets.txt", "BOB ONLY") }], false);
    expect(await loadWorkspacePreview(alice, botId)).toMatchObject({ command: null, lines: [], state: expect.any(String) });

    await home(alice, [{ role: "assistant", text: "", parts: bash("npm test", "line 1\nline 2\n\nall passed") }], false);
    const preview = await loadWorkspacePreview(alice, botId);
    expect(preview).toMatchObject({ command: "npm test", lines: ["line 1", "line 2", "all passed"], ok: true });
    expect(JSON.stringify(preview)).not.toContain("BOB ONLY");

    await setSetting("sandbox", { ...(await getSetting("sandbox")), enabled: false });
    expect(await loadWorkspacePreview(alice, botId)).toBeNull(); // workspaces off: no screen
  });
});
