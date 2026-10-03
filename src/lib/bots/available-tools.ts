import type { Principal } from "@/lib/auth/groups";
import { BUILTIN_TOOLS } from "@/lib/agent/types";
import { sandboxdConfig } from "@/lib/sandbox/client";
import { userMayUseWorkspace } from "@/lib/sandbox/policy";
import { getSetting } from "@/lib/settings";

/**
 * Built-in tool groups this person may add to a bot: not disabled org-wide, and the workspace only when sandboxes
 * are set up and they may use one. (At run time each acting person is checked again.)
 */
export async function availableBuiltinKeys(p: Principal): Promise<Set<string>> {
  const [tools, sandbox] = await Promise.all([getSetting("tools"), getSetting("sandbox")]);
  const disabled = new Set(tools.disabledTools);
  const workspaceOk = !!sandboxdConfig() && userMayUseWorkspace(p, sandbox);
  return new Set(BUILTIN_TOOLS.filter((t) => !disabled.has(t.key) && (t.key !== "workspace" || workspaceOk)).map((t) => t.key));
}
