import { eq } from "drizzle-orm";
import { db } from "@/db";
import { aiApps, type AiApp } from "@/db/schema";
import { getSetting } from "@/lib/settings";
import { isEligibleEmbeddingApp, isEligibleUtilityApp } from "./catalog";

async function appById(id?: string) {
  if (!id) return undefined;
  const [app] = await db.select().from(aiApps).where(eq(aiApps.id, id));
  return app;
}

/**
 * App used for background work (titles, memory extraction, drafts). Falls back to the conversation's app, but only
 * when no utility connection is configured and that app runs on company credentials: background work is never billed to a user's own key or plan.
 */
export async function utilityApp(fallback?: AiApp): Promise<AiApp | undefined> {
  const tools = await getSetting("tools");
  const configured = await appById(tools.utilityAppId);
  if (tools.utilityAppId) return configured && isEligibleUtilityApp(configured) ? configured : undefined;
  return fallback && isEligibleUtilityApp(fallback) ? fallback : undefined;
}

export async function embeddingApp(): Promise<AiApp | undefined> {
  const tools = await getSetting("tools");
  const app = await appById(tools.embeddingAppId);
  return app && isEligibleEmbeddingApp(app) ? app : undefined;
}
