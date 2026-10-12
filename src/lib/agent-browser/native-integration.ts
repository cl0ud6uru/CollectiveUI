import { loadPrincipal, type Principal } from "@/lib/auth/groups";
import { webSessionRegistryEnabled } from "@/lib/auth/web-sessions";
import { HttpError } from "@/lib/authz";
import { resolveWorkspace } from "@/lib/workspaces/resolve";
import { agentBrowserTools } from "@/lib/agent/tools/agent-browser";
import type { AgentCtx } from "@/lib/agent/types";

export async function selectedBrowserWorkspace(principal: Principal, botId: string) {
  const workspace = await resolveWorkspace({ principal, botId, createIfMissing: false });
  if (workspace && (workspace.ownerUserId !== principal.user.id || workspace.botId !== botId)) throw new HttpError(403, "Workspace binding denied");
  return workspace;
}

/** Native worker integration imports no Auth.js request-only modules. */
export async function integratedAgentBrowserTools(ctx: AgentCtx) {
  if (process.env.AGENT_BROWSER_ENABLED !== "1") return { entries: [], close: async () => {} };
  if (!webSessionRegistryEnabled() || !ctx.bot) throw new HttpError(503, "Browser session prerequisites are unavailable");
  const fresh = await loadPrincipal(ctx.principal.user.id);
  if (!fresh || fresh.user.sessionVersion !== ctx.principal.user.sessionVersion) throw new HttpError(403, "Workspace admission changed");
  const selected = await selectedBrowserWorkspace(fresh, ctx.bot.id);
  return agentBrowserTools(ctx, { workspace: selected ? { ownerUserId: selected.ownerUserId, instanceId: selected.instanceId } : null,
    assertWorkspace: async () => {
      const current = await loadPrincipal(ctx.principal.user.id);
      if (!current || current.user.sessionVersion !== ctx.principal.user.sessionVersion) throw new HttpError(403, "Workspace admission changed");
      const workspace = await selectedBrowserWorkspace(current, ctx.bot!.id);
      if ((workspace?.instanceId ?? null) !== (selected?.instanceId ?? null)) throw new HttpError(403, "Workspace binding changed");
    } });
}
