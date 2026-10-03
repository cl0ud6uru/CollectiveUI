/**
 * Tools that can never be "always allowed": every call asks (client-safe, used by the approval policy, the grant
 * action and the approval card).
 */
export const NON_GRANTABLE_TOOLS: ReadonlySet<string> = new Set(["workspace_bash"]);

/** Tools a Hermes server runs itself: Hermes decides what needs approval, and each approval is for one call only. */
export const isHermesTool = (toolName: string) => toolName.startsWith("hermes__");

export const isGrantable = (toolName: string) => !NON_GRANTABLE_TOOLS.has(toolName) && !isHermesTool(toolName);
