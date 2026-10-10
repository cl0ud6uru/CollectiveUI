import { getToolOrDynamicToolName, isToolUIPart } from "ai";
import { and, eq } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { botTools, type Message } from "@/db/schema";
import type { PortalUIMessage } from "@/lib/chat/store";
import { getSetting } from "@/lib/settings";

/**
 * Automatic extraction is a separate write, so a grant/approval for one remember call
 * does not authorize it. Respect the current bot and organization memory policy.
 */
export async function memoryConsentRequired(botId: string | null, q: DbOrTx = db) {
  const settings = await getSetting("tools", q);
  if (settings.disabledTools.includes("memory") || settings.enforcedApproval.some(name => name === "memory" || name === "remember")) return true;
  if (!botId) return false;
  const [memory] = await q.select({ approval: botTools.approval }).from(botTools)
    .where(and(eq(botTools.botId, botId), eq(botTools.toolKey, "memory")));
  return memory?.approval === "ask";
}

/**
 * Stored server tool state is the consent evidence, never transcript/model claims.
 * Check the entire conversation, including old turns and inactive branches. Without
 * a reliable semantic equivalence check, conservatively keep this source inert for
 * automatic writes rather than risk saving a paraphrase of a denied fact.
 */
export function hasUnapprovedMemoryWrite(rows: Pick<Message, "role" | "parts">[]) {
  return rows.some(row => row.role === "assistant" && (row.parts as PortalUIMessage["parts"]).some(part => {
    if (!isToolUIPart(part) || getToolOrDynamicToolName(part) !== "remember") return false;
    return part.approval?.approved === false || part.state !== "output-available" || part.preliminary === true;
  }));
}
