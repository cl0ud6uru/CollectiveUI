import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { aiApps, bots, botTools, toolGrants } from "@/db/schema";
import { agentPreferences } from "@/lib/agent/preferences";
import type { AgentCtx } from "@/lib/agent/types";
import { loadPrincipal, type Principal } from "@/lib/auth/groups";
import { HttpError } from "@/lib/authz";
import { sha256Hex } from "@/lib/crypto";
import { canonicalJson } from "@/lib/mcp/snapshot";
import { getSetting } from "@/lib/settings";

export class DelegationAuthorityChangedError extends HttpError {
  readonly userFacing = true;
  constructor() { super(403, "Tool permissions or configuration changed. Start a new request and review the new assignment."); }
}

/**
 * The parts of a person that bear on what a delegated run may do. Sign-in times and sidebar navigation change
 * during ordinary use (every direct send records `botLastSentAt`) and must not fail an unrelated delegated run.
 */
export function authorityOf(p: Principal) {
  const u = p.user;
  return {
    id: u.id, upn: u.upn, realm: u.identityRealm, email: u.email, name: u.name, authSource: u.authSource,
    session: u.sessionVersion, disabled: u.disabled, admin: p.isAdmin, canCreateBots: p.canCreateBots,
    groupIds: [...p.groupIds].sort(), prefs: agentPreferences(u.prefs),
  };
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
  return sha256Hex(canonicalJson({ principal: authorityOf(actor),
    bot: captured ? ctx.bot : bot, app: captured ? ctx.app : app, configured, grants,
    tools: captured ? ctx.toolSettings : tools, sandbox }));
}
