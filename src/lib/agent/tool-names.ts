/**
 * Tools that can never be "always allowed": every call asks (client-safe, used by the approval policy, the grant
 * action and the approval card).
 */
export const NON_GRANTABLE_TOOLS: ReadonlySet<string> = new Set(["workspace_bash"]);

/** Tools a Hermes server runs itself: Hermes decides what needs approval, and each approval is for one call only. */
export const isHermesTool = (toolName: string) => toolName.startsWith("hermes__");

export const isGrantable = (toolName: string) => !NON_GRANTABLE_TOOLS.has(toolName) && !isHermesTool(toolName) && !toolName.startsWith("admin_");

export const isMcpToolName = (name: string) => /^mcp__[A-Za-z0-9_-]{0,25}__[a-f0-9]{32}$/.test(name);

/** The colon namespace cannot be confused with a grant saved under an old model alias. */
export const toolGrantName = (name: string) => isMcpToolName(name) ? `mcp:${name}` : name;

/** Old numeric collision aliases remain restrictive, including when the colliding neighbor disappears. */
export function matchesLegacyMcpToolName(name: string, base: string): boolean {
  if (name === base) return true;
  const suffix = /_([0-9]+)$/.exec(name)?.[1];
  return !!suffix && Number.isSafeInteger(Number(suffix)) && Number(suffix) >= 2 &&
    name === `${base.slice(0, 64 - suffix.length - 1)}_${suffix}`;
}
