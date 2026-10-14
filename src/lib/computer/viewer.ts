import "server-only";
import { HttpError } from "@/lib/authz";
import { jpegDimensions, validateAgentBrowserFrame } from "@/lib/agent-browser/viewer";
import { MAX_AGENT_BROWSER_FRAME_BYTES } from "@/lib/agent-browser/contracts";
import type { AuthorizedComputerView } from "./access";
import { computerFrame, computerStatus } from "./client";
import type { ComputerViewStatus } from "./contracts";

export const MAX_COMPUTER_STREAM_MS = 30_000;
export const MAX_COMPUTER_SUBSCRIBERS_PER_OWNER = 2;
const STALE_MS = 8_000;
const subscribers = new Map<string, number>();
const freshness = new Map<string, { capturedAt: string; receivedAt: number; sequence: number }>();
const keyOf = (v: AuthorizedComputerView) => `${v.ownerUserId}\0${v.conversationId}\0${v.sessionId}`;

export function reserveComputerSubscriber(owner: string): () => void {
  const count = subscribers.get(owner) ?? 0;
  if (count >= MAX_COMPUTER_SUBSCRIBERS_PER_OWNER) throw new HttpError(429, "Too many computer views are open for this account.");
  subscribers.set(owner, count + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (subscribers.get(owner) ?? 1) - 1;
    if (next > 0) subscribers.set(owner, next); else subscribers.delete(owner);
  };
}

export async function computerStatusForView(view: AuthorizedComputerView, signal?: AbortSignal): Promise<ComputerViewStatus> {
  await view.authorize();
  const status = await computerStatus(view, signal);
  const last = freshness.get(keyOf(view));
  // Broker's timestamp is authoritative, but discard stale timestamps instead of presenting an old screenshot as live.
  if (status.lastFrameAt && Date.now() - Date.parse(status.lastFrameAt) > STALE_MS)
    return { ...status, lastFrameAt: null };
  if (!status.lastFrameAt && last && Date.now() - last.receivedAt <= STALE_MS)
    return { ...status, lastFrameAt: last.capturedAt };
  return status;
}

async function readBounded(response: Response): Promise<Uint8Array> {
  if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "image/jpeg") throw new HttpError(503, "Computer frame is unavailable.");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_AGENT_BROWSER_FRAME_BYTES) {
    await response.body?.cancel();
    throw new HttpError(413, "Computer frame is too large.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new HttpError(503, "Computer frame is unavailable.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_AGENT_BROWSER_FRAME_BYTES) {
        await reader.cancel();
        throw new HttpError(413, "Computer frame is too large.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function computerFrameForView(view: AuthorizedComputerView, signal?: AbortSignal) {
  await view.authorize();
  const response = await computerFrame(view, signal);
  const capturedAt = response.headers.get("x-computer-captured-at") ?? "";
  const sequence = Number(response.headers.get("x-computer-sequence"));
  const bytes = await readBounded(response);
  const dimensions = jpegDimensions(bytes);
  const frame = { sequence, capturedAt, contentType: "image/jpeg" as const, bytes,
    width: dimensions?.width ?? 0, height: dimensions?.height ?? 0 };
  if (!validateAgentBrowserFrame(frame) || frame.width !== 1280 || frame.height !== 800) throw new HttpError(409, "A current computer frame is not available.");
  freshness.set(keyOf(view), { capturedAt: new Date(Date.parse(capturedAt)).toISOString(), receivedAt: Date.now(), sequence });
  if (freshness.size > 1024) {
    const now = Date.now();
    for (const [key, value] of freshness) if (now - value.receivedAt > 60_000) freshness.delete(key);
    if (freshness.size > 1024) freshness.delete(freshness.keys().next().value!);
  }
  return frame;
}
