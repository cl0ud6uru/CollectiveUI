// Seeds a local dev database with the mock LLM app, a demo group mapping and a couple of bots.
import { eq } from "drizzle-orm";
import { db, pool } from "../src/db";
import { aiApps, botTools, bots, groupMappings, groups, users } from "../src/db/schema";
import { setSetting, getSetting } from "../src/lib/settings";

async function main() {
  const base = process.env.MOCK_LLM_URL ?? "http://localhost:4010/v1";
  let [app] = await db.select().from(aiApps).where(eq(aiApps.name, "Mock GPT"));
  if (!app) {
    [app] = await db
      .insert(aiApps)
      .values({
        name: "Mock GPT",
        description: "Local mock model for development",
        icon: "🧪",
        provider: "openai-compatible",
        baseUrl: base,
        model: "mock-gpt",
        supportsTools: true,
        supportsVision: true,
        embeddingModel: "mock-embed",
      })
      .returning();
  }
  const tools = await getSetting("tools");
  await setSetting("tools", { ...tools, utilityAppId: app.id, embeddingAppId: app.id });

  let [eng] = await db.select().from(groups).where(eq(groups.name, "Engineering"));
  if (!eng) {
    [eng] = await db.insert(groups).values({ name: "Engineering", description: "Engineering department" }).returning();
    await db.insert(groupMappings).values({
      groupId: eng.id,
      source: "ldap",
      externalId: "cn=engineering,ou=groups,dc=corp,dc=local",
      displayName: "Engineering (LDAP)",
    });
  }

  const [owner] = await db.select().from(users).limit(1);
  if (owner && !(await db.select().from(bots).where(eq(bots.name, "Research Assistant"))).length) {
    const [researcher] = await db
      .insert(bots)
      .values({
        ownerId: owner.id,
        name: "Research Assistant",
        avatar: "blob:drop:blue",
        label: "Research",
        description: "Researches topics on the web and summarises findings with sources.",
        instructions: "Search first, then read the most relevant pages, then answer with citations.",
        appId: app.id,
        visibility: "org",
        starters: ["Summarise the latest news on AI regulation", "[tool:web_search {\"query\":\"hello\"}]"],
      })
      .returning();
    await db.insert(botTools).values([
      { botId: researcher.id, toolKey: "web_search", approval: "auto" },
      { botId: researcher.id, toolKey: "fetch_url", approval: "ask" },
      { botId: researcher.id, toolKey: "memory", approval: "auto" },
    ]);
  }
  console.log("seeded", { app: app.id });
  await pool.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
