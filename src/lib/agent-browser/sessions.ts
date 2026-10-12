import { BrowserError, parseScope, scopeKey, type AgentBrowserProvider, type BrowserScope } from "./provider-contract";

/** Server-local opaque bindings only; never catalog state, cookies, profiles or viewer DTOs. */
export class AgentBrowserSessions {
  private readonly bindings = new Map<string, BrowserScope>();
  bind(id: unknown, raw: BrowserScope) {
    if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) throw new BrowserError("invalid");
    const scope = parseScope(raw); const existing = this.bindings.get(id);
    if (existing && scopeKey(existing) !== scopeKey(scope)) throw new BrowserError("denied");
    this.bindings.set(id, Object.freeze(scope));
  }
  scope(id: string): BrowserScope {
    const s = this.bindings.get(id); if (!s) throw new BrowserError("denied"); return { ...s };
  }
  forget(id: string) { this.bindings.delete(id); }
}

/** W5 consumes these read-only closures. They use the tools' exact session/page; no viewer input path. */
export type RuntimeBrowserSource = BrowserScope & {
  sessionId: string;
  status: () => ReturnType<AgentBrowserProvider["status"]>;
  subscribeFrames: (signal: AbortSignal) => ReturnType<AgentBrowserProvider["subscribeFrames"]>;
};
export function browserSource(provider: AgentBrowserProvider, scope: BrowserScope, sessionId: string): RuntimeBrowserSource {
  return Object.freeze({ ...parseScope(scope), sessionId,
    status: () => provider.status(sessionId), subscribeFrames: (signal: AbortSignal) => provider.subscribeFrames(sessionId, signal) });
}
