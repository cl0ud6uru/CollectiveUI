import { eq, like, or } from "drizzle-orm";
import { db, pool } from "../../src/db";
import { aiApps, appAccess, bots, groups, routines, settings, userCredentials, users } from "../../src/db/schema";

async function main() {
  const [eng] = await db.select().from(groups).where(eq(groups.name, "Engineering"));
  if (!eng) throw new Error("Run `npm run db:seed` first");
  let [app] = await db.select().from(aiApps).where(eq(aiApps.name, "Engineering Copilot"));
  if (!app) {
    [app] = await db
      .insert(aiApps)
      .values({
        name: "Engineering Copilot",
        description: "Restricted to the Engineering group",
        icon: "🛠️",
        provider: "openai-compatible",
        baseUrl: process.env.MOCK_LLM_URL ?? "http://localhost:4010/v1",
        model: "mock-gpt",
        isPublic: false,
        sortOrder: 10,
      })
      .returning();
    await db.insert(appAccess).values({ appId: app.id, groupId: eng.id });
  }
  // Second org bot used by the group chat, sidebar and template-link tests (owned by alice, like the demo bot).
  const [researcher] = await db.select().from(bots).where(eq(bots.name, "Research Assistant"));
  if (!researcher) throw new Error("Sign in once as alice, then run `npm run db:seed` to create the demo bot");
  if (!(await db.select().from(bots).where(eq(bots.name, "Directory Bot"))).length) {
    await db.insert(bots).values({
      ownerId: researcher.ownerId,
      name: "Directory Bot",
      avatar: "blob:hexagon:teal",
      label: "Directory",
      description: "Directory lookups: finds people, teams and owners.",
      instructions: "Answer questions about who owns what and who is on which team.",
      appId: researcher.appId,
      visibility: "org",
    });
  }
  // Apps created by earlier provider test runs (tests/e2e/providers.spec.ts, chatgpt.spec.ts).
  await db.delete(aiApps).where(like(aiApps.name, "E2E %"));
  // Sign in with ChatGPT starts off, with nobody connected (tests/e2e/chatgpt.spec.ts).
  await db.delete(settings).where(eq(settings.key, "chatgpt"));
  await db.delete(userCredentials);
  // Workspaces start off (tests/e2e/workspace.spec.ts turns them on and back off).
  await db.delete(settings).where(eq(settings.key, "sandbox"));
  // Bots made by earlier MCP and workspace runs (they'd push the seeded bots out of the sidebar's short list).
  await db.delete(bots).where(or(like(bots.name, "E2E MCP bot %"), like(bots.name, "E2E Workspace bot %"), like(bots.name, "E2E Hermes %")));
  // Remove copies left behind by earlier runs so the sidebar stays readable.
  await db.delete(bots).where(or(like(bots.name, "% copy"), like(bots.name, "% (copy)")));
  await db.delete(routines).where(like(routines.name, "E2E routine %"));
  const [bob] = await db.select().from(users).where(eq(users.upn, "bob@corp.local"));
  if (bob) await db.delete(bots).where(eq(bots.ownerId, bob.id)); // bots bob added from template links

  await pool.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
