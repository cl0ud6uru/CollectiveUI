import { eq } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { aiApps, type AiApp } from "@/db/schema";
import { getSetting } from "@/lib/settings";
import { isEligibleEmbeddingApp, isEligibleUtilityApp } from "./catalog";

async function appById(id?: string, q: DbOrTx = db) {
  if (!id) return undefined;
  const [app] = await q.select().from(aiApps).where(eq(aiApps.id, id));
  return app;
}

/**
 * App used for background work (titles, memory extraction, drafts). Falls back to the conversation's app, but only
 * when no utility connection is configured and that app runs on company credentials: background work is never billed to a user's own key or plan.
 */
export async function utilityApp(fallback?: AiApp, q: DbOrTx = db): Promise<AiApp | undefined> {
  const tools = await getSetting("tools", q);
  const configured = await appById(tools.utilityAppId, q);
  if (tools.utilityAppId) return configured && isEligibleUtilityApp(configured) ? configured : undefined;
  return fallback && isEligibleUtilityApp(fallback) ? fallback : undefined;
}

export async function embeddingApp(q: DbOrTx = db): Promise<AiApp | undefined> {
  const tools = await getSetting("tools", q);
  const app = await appById(tools.embeddingAppId, q);
  return app && isEligibleEmbeddingApp(app) ? app : undefined;
}
