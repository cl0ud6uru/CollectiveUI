/** Internal runtime contract. Scopes come from authenticated run admission, never viewer/tool JSON. */
export type BrowserScope = {
  ownerUserId: string; botId: string; runId: string; conversationId: string;
  workspaceInstanceId: string | null;
};
export type BrowserAction =
  | { kind: "click"; ref: string }
  | { kind: "type"; ref: string; text: string }
  | { kind: "scroll"; direction: "up" | "down"; pixels: number };
export type BrowserInspection = { text: string; elements: { ref: string; role: string; name: string }[] };
export type BrowserFrame = {
  sequence: number; capturedAt: string; contentType: "image/jpeg";
  bytes: Uint8Array; width: number; height: number;
};
export type BrowserState = "active" | "idle" | "disconnected";
export interface AgentBrowserProvider {
  open(scope: BrowserScope, signal?: AbortSignal): Promise<{ sessionId: string }>;
  /** Read-only lookup: never allocates a process/page. Required for worker-to-web viewer discovery. */
  find(scope: BrowserScope, signal?: AbortSignal): Promise<{ sessionId: string } | null>;
  navigate(sessionId: string, url: string, signal?: AbortSignal): Promise<{ title: string }>;
  inspect(sessionId: string, signal?: AbortSignal): Promise<BrowserInspection>;
  act(sessionId: string, action: BrowserAction, signal?: AbortSignal): Promise<void>;
  subscribeFrames(sessionId: string, signal: AbortSignal): AsyncIterable<BrowserFrame>;
  status(sessionId: string, signal?: AbortSignal): Promise<BrowserState>;
  close(sessionId: string): Promise<void>;
}
export const BROWSER_LIMITS = {
  frameBytes: 256 * 1024, frameIntervalMs: 1000, width: 1024, height: 640,
  maxText: 16_000, maxElements: 100, actionTimeoutMs: 10_000,
  maxRequestBytes: 1024 * 1024, maxResponseBytes: 4 * 1024 * 1024,
  maxSubscribers: 2, subscriberTtlMs: 10_000, maxViewMs: 5 * 60_000,
} as const;
export class BrowserError extends Error {
  readonly code: "denied" | "invalid" | "unavailable" | "capacity" | "stale_ref";
  constructor(code: BrowserError["code"], message = "Agent browser is unavailable") {
    super(message); this.name = "BrowserError"; this.code = code;
  }
}
const id = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
export function parseScope(v: unknown): BrowserScope {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new BrowserError("invalid");
  const s = v as Record<string, unknown>;
  if (Object.keys(s).sort().join(",") !== "botId,conversationId,ownerUserId,runId,workspaceInstanceId" ||
      !id(s.ownerUserId) || !id(s.botId) || !id(s.runId) || !id(s.conversationId) ||
      (s.workspaceInstanceId !== null && !id(s.workspaceInstanceId))) throw new BrowserError("invalid");
  return { ownerUserId: s.ownerUserId, botId: s.botId, runId: s.runId, conversationId: s.conversationId, workspaceInstanceId: s.workspaceInstanceId as string | null };
}
export const scopeKey = (s: BrowserScope) => JSON.stringify([s.ownerUserId, s.botId, s.runId, s.conversationId, s.workspaceInstanceId]);
export function parseAction(v: unknown): BrowserAction {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new BrowserError("invalid", "Invalid browser action");
  const a = v as Record<string, unknown>;
  const keys = Object.keys(a).sort().join(",");
  if (a.kind === "click" && keys === "kind,ref" && typeof a.ref === "string" && /^[a-f0-9]{24}$/.test(a.ref)) return { kind: a.kind, ref: a.ref };
  if (a.kind === "type" && keys === "kind,ref,text" && typeof a.ref === "string" && /^[a-f0-9]{24}$/.test(a.ref) && typeof a.text === "string" && a.text.length <= 4000)
    return { kind: a.kind, ref: a.ref, text: a.text };
  if (a.kind === "scroll" && keys === "direction,kind,pixels" && ["up", "down"].includes(String(a.direction)) && Number.isInteger(a.pixels) && Number(a.pixels) >= 1 && Number(a.pixels) <= 2000)
    return { kind: a.kind, direction: a.direction as "up" | "down", pixels: a.pixels as number };
  throw new BrowserError("invalid", "Invalid browser action");
}
