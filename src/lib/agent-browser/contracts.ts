/** Public browser-view DTOs. Never add browser session IDs, URLs, credentials or transport data here. */
export type AgentBrowserState = "active" | "idle" | "disconnected";

export type AgentBrowserStatus = {
  state: AgentBrowserState;
  viewOnly: true;
  lastFrameAt: string | null;
};

/** Scope is created from the authenticated conversation and persisted run, never from request ownership claims. */
export type AgentBrowserScope = {
  ownerUserId: string;
  botId: string;
  runId: string;
  workspaceInstanceId: string | null;
};

/** Ephemeral provider-to-viewer frame. The viewer accepts JPEG only and bounds bytes/dimensions before forwarding. */
export type AgentBrowserFrame = {
  sequence: number;
  capturedAt: string;
  contentType: "image/jpeg";
  bytes: Uint8Array;
  width: number;
  height: number;
};

export const MAX_AGENT_BROWSER_FRAME_BYTES = 512 * 1024;
export const AGENT_BROWSER_STALE_FRAME_MS = 8_000;

/** Internal source resolved by the browser-runtime owner after W5 has authorized the scope. */
export type BrowserSessionSource = AgentBrowserScope & {
  /** Opaque internal handle; never serialized or accepted from a browser request. */
  sessionId: string;
  status(signal: AbortSignal): Promise<AgentBrowserState>;
  subscribeFrames(signal: AbortSignal): AsyncIterable<AgentBrowserFrame>;
};
