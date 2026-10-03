import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { aiApps, bots, botTools, toolGrants } from "@/db/schema";
import type { AgentCtx } from "@/lib/agent/types";
import { loadPrincipal } from "@/lib/auth/groups";
import { HttpError } from "@/lib/authz";
import { sha256Hex } from "@/lib/crypto";
import { canonicalJson } from "@/lib/mcp/snapshot";
import { getSetting } from "@/lib/settings";

export class DelegationAuthorityChangedError extends HttpError {
  readonly userFacing = true;
  constructor() { super(403, "Tool permissions or configuration changed. Start a new request and review the new assignment."); }
}

/** In-memory hash only: captured builtin permissions must still match at the next dispatch. */
export async function delegatedAuthorityBinding(ctx: AgentCtx, captured = false) {
  const principal = await loadPrincipal(ctx.principal.user.id);
  if (!principal || principal.user.sessionVersion !== ctx.principal.user.sessionVersion)
    throw new HttpError(403, "The account or session changed.");
  const botId = ctx.bot?.id ?? "";
  const [[bot], [app], configured, grants, tools, sandbox] = await Promise.all([
    db.select().from(bots).where(eq(bots.id, botId)),
    db.select().from(aiApps).where(eq(aiApps.id, ctx.app.id)),
    db.select().from(botTools).where(eq(botTools.botId, botId)).orderBy(botTools.toolKey),
    db.select().from(toolGrants).where(and(eq(toolGrants.userId, principal.user.id), eq(toolGrants.botId, botId))).orderBy(toolGrants.toolName),
    getSetting("tools"), getSetting("sandbox"),
  ]);
  const actor = captured ? ctx.principal : principal;
  return sha256Hex(canonicalJson({ principal: { ...actor, groupIds: [...actor.groupIds].sort() },
    bot: captured ? ctx.bot : bot, app: captured ? ctx.app : app, configured, grants,
    tools: captured ? ctx.toolSettings : tools, sandbox }));
}
