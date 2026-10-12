import { PrivateBrowserProvider } from "./provider";
import { BrowserError, parseScope, scopeKey, type BrowserFrame, type BrowserScope, type BrowserState } from "./provider-contract";

/** Structural match for W5 PR #181; W5 owns its contracts/session-source files. */
export type ViewerBrowserScope = Omit<BrowserScope, "conversationId">;
export type ViewerBrowserSource = ViewerBrowserScope & {
  sessionId: string;
  status(signal: AbortSignal): Promise<BrowserState>;
  subscribeFrames(signal: AbortSignal): AsyncIterable<BrowserFrame>;
};
export type ViewerBrowserResolver = (scope: ViewerBrowserScope, signal: AbortSignal) => Promise<ViewerBrowserSource | null>;

/** W5/parent must revalidate the signed-in session, owned conversation/run, usable bot and W2 binding.
 * conversationId must come from the persisted authorized run. Reject revoked/ended sessions, never guess it.
 */
export type AdmitBrowserViewer = (scope: ViewerBrowserScope) => Promise<BrowserScope>;

export function createBrowserSessionSourceResolver(socket: string, secret: string, admit: AdmitBrowserViewer): ViewerBrowserResolver {
  return async (selector, signal) => {
    signal.throwIfAborted();
    const binding = parseScope(await admit(selector));
    const matches = (scope: BrowserScope) => scope.ownerUserId === selector.ownerUserId && scope.botId === selector.botId &&
      scope.runId === selector.runId && scope.workspaceInstanceId === selector.workspaceInstanceId;
    if (!matches(binding)) throw new BrowserError("denied");
    const provider = new PrivateBrowserProvider(socket, secret, async (scope, operation) => {
      if (operation !== "view" || !matches(scope) || scopeKey(parseScope(await admit(selector))) !== scopeKey(binding)) throw new BrowserError("denied");
    }, "view");
    const found = await provider.find(binding, signal);
    if (!found || signal.aborted) return null;
    return Object.freeze({ ...selector, sessionId: found.sessionId,
      status: (signal: AbortSignal) => provider.status(found.sessionId, signal),
      subscribeFrames: (signal: AbortSignal) => provider.subscribeFrames(found.sessionId, signal) });
  };
}

/** Actual runtime-side registration into PR #181's registerBrowserSessionSourceResolver. No process-local fallback. */
export function installBrowserSessionSourceResolver(register: (resolver: ViewerBrowserResolver) => () => void,
  admit: AdmitBrowserViewer, env: Record<string, string | undefined> = process.env): () => void {
  if (env.AGENT_BROWSER_ENABLED !== "1") return () => {};
  if (!env.AGENT_BROWSER_SOCKET || !env.AGENT_BROWSER_SECRET) throw new BrowserError("unavailable");
  return register(createBrowserSessionSourceResolver(env.AGENT_BROWSER_SOCKET, env.AGENT_BROWSER_SECRET, admit));
}
