import "server-only";
import { HttpError } from "@/lib/authz";
import { AGENT_BROWSER_STALE_FRAME_MS, MAX_AGENT_BROWSER_FRAME_BYTES, type AgentBrowserFrame, type AgentBrowserScope, type AgentBrowserStatus, type BrowserSessionSource } from "./contracts";

export const MAX_AGENT_BROWSER_STREAM_MS = 30_000;
export const MAX_AGENT_BROWSER_SUBSCRIBERS_PER_OWNER = 2;
export const AGENT_BROWSER_MAX_FRAME_RATE = 2;

const minFrameIntervalMs = 1000 / AGENT_BROWSER_MAX_FRAME_RATE;
const maxWidth = 1920;
const maxHeight = 1080;
const slotCounts = new Map<string, number>();
const latestFrames = new Map<string, { capturedAt: string; receivedAt: number }>();

const sourceKey = (source: Pick<BrowserSessionSource, "ownerUserId" | "botId" | "runId" | "workspaceInstanceId" | "sessionId">) =>
  JSON.stringify([source.ownerUserId, source.botId, source.runId, source.workspaceInstanceId, source.sessionId]);

export function reserveAgentBrowserSubscriber(ownerUserId: string): () => void {
  const count = slotCounts.get(ownerUserId) ?? 0;
  if (count >= MAX_AGENT_BROWSER_SUBSCRIBERS_PER_OWNER) throw new HttpError(429, "Too many browser views are open for this account.");
  slotCounts.set(ownerUserId, count + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (slotCounts.get(ownerUserId) ?? 1) - 1;
    if (next > 0) slotCounts.set(ownerUserId, next);
    else slotCounts.delete(ownerUserId);
  };
}

export async function agentBrowserStatus(source: BrowserSessionSource, signal: AbortSignal): Promise<AgentBrowserStatus> {
  let state: AgentBrowserStatus["state"] = "disconnected";
  try { state = await source.status(signal); } catch { /* A lost broker is a disconnected view. */ }
  const latest = latestFrames.get(sourceKey(source));
  const stale = !latest || Date.now() - latest.receivedAt > AGENT_BROWSER_STALE_FRAME_MS;
  if (state === "disconnected" || (latest && stale)) return { state: "disconnected", viewOnly: true, lastFrameAt: latest?.capturedAt ?? null };
  return { state, viewOnly: true, lastFrameAt: latest?.capturedAt ?? null };
}

/** Read the dimensions from a JPEG start-of-frame segment instead of trusting provider metadata. */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) return null;
    // Standalone markers have no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    const startOfFrame = marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3 ||
      marker === 0xc5 || marker === 0xc6 || marker === 0xc7 || marker === 0xc9 || marker === 0xca ||
      marker === 0xcb || marker === 0xcd || marker === 0xce || marker === 0xcf;
    if (startOfFrame) {
      if (segmentLength < 8) return null;
      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      };
    }
    offset += segmentLength;
  }
  return null;
}

export function validateAgentBrowserFrame(frame: AgentBrowserFrame): boolean {
  if (!frame || !Number.isSafeInteger(frame.sequence) || frame.sequence < 1 || frame.contentType !== "image/jpeg" ||
      !(frame.bytes instanceof Uint8Array) || frame.bytes.byteLength < 4 || frame.bytes.byteLength > MAX_AGENT_BROWSER_FRAME_BYTES ||
      !Number.isInteger(frame.width) || frame.width < 1 || frame.width > maxWidth ||
      !Number.isInteger(frame.height) || frame.height < 1 || frame.height > maxHeight ||
      typeof frame.capturedAt !== "string") return false;
  const capturedMs = Date.parse(frame.capturedAt);
  if (!Number.isFinite(capturedMs) || capturedMs > Date.now() + 2_000 || Date.now() - capturedMs > AGENT_BROWSER_STALE_FRAME_MS) return false;
  // Restrict the wire format to an actual bounded JPEG. Metadata alone cannot make an oversized image safe.
  if (frame.bytes[0] !== 0xff || frame.bytes[1] !== 0xd8 || frame.bytes[2] !== 0xff ||
      frame.bytes[frame.bytes.length - 2] !== 0xff || frame.bytes[frame.bytes.length - 1] !== 0xd9) return false;
  const dimensions = jpegDimensions(frame.bytes);
  return !!dimensions && dimensions.width === frame.width && dimensions.height === frame.height &&
    dimensions.width > 0 && dimensions.width <= maxWidth && dimensions.height > 0 && dimensions.height <= maxHeight;
}

/** Bounds data from the provider before the authenticated stream route serializes a frame. */
export async function* boundedAgentBrowserFrames(source: BrowserSessionSource, signal: AbortSignal): AsyncGenerator<AgentBrowserFrame> {
  let previousSequence = 0;
  let previousSentAt = 0;
  for await (const frame of source.subscribeFrames(signal)) {
    if (signal.aborted) return;
    if (!validateAgentBrowserFrame(frame) || frame.sequence <= previousSequence) continue;
    previousSequence = frame.sequence;
    const now = Date.now();
    if (now - previousSentAt < minFrameIntervalMs) continue;
    previousSentAt = now;
    latestFrames.set(sourceKey(source), { capturedAt: new Date(Date.parse(frame.capturedAt)).toISOString(), receivedAt: now });
    // Keep this process-local timestamp cache bounded; the source/browser itself is never kept here.
    if (latestFrames.size > 1024) {
      for (const [key, value] of latestFrames) if (now - value.receivedAt > 60_000) latestFrames.delete(key);
      if (latestFrames.size > 1024) latestFrames.delete(latestFrames.keys().next().value!);
    }
    yield frame;
  }
}

/** Let the runtime owner discard viewer freshness metadata when its session ends. */
export function clearAgentBrowserFreshness(scope: AgentBrowserScope, sessionId?: string) {
  if (sessionId) {
    latestFrames.delete(sourceKey({ ...scope, sessionId }));
    return;
  }
  for (const key of latestFrames.keys()) {
    const [owner, bot, run, workspace] = JSON.parse(key) as [string, string, string, string | null, string];
    if (owner === scope.ownerUserId && bot === scope.botId && run === scope.runId && workspace === scope.workspaceInstanceId) latestFrames.delete(key);
  }
}
