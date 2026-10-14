import "node:async_hooks";
import { isAbsolute } from "node:path";
import { HttpError } from "@/lib/authz";
import { LOCAL_ORIGIN, socketFetch } from "@/lib/local-hermes/client";
import { ComputerInputSchema, ComputerViewStatusSchema, type ComputerInput } from "./contracts";
import type { CodexRuntime } from "@/lib/codex/runtime";
import { webSessionRegistryEnabled } from "@/lib/auth/web-sessions";
import { z } from "zod";

export const COMPUTER_AGENT_FRAME_LIMIT = 512 * 1024;
const MAX_TOOL_TEXT = 4000;

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (segmentLength < 8) return null;
      return { height: (bytes[offset + 3] << 8) | bytes[offset + 4], width: (bytes[offset + 5] << 8) | bytes[offset + 6] };
    }
    offset += segmentLength;
  }
  return null;
}

export const COMPUTER_TOOL_NAMES = ["computer_screenshot", "computer_click", "computer_type", "computer_key", "computer_scroll"] as const;
export type ComputerToolName = typeof COMPUTER_TOOL_NAMES[number];
export type DynamicToolCallResult = { success: boolean; contentItems: ({ type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string })[] };

const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object", properties, required, additionalProperties: false,
});

/** These plain function specs match the 0.163.0-alpha.2 app-server DynamicToolSpec schema. */
export const COMPUTER_DYNAMIC_TOOLS = [
  { type: "function", name: "computer_screenshot", description: "Capture the current computer display as an image.", inputSchema: object({}, []) },
  { type: "function", name: "computer_click", description: "Click a coordinate on the 1280 by 800 computer display.", inputSchema: object({
    x: { type: "integer", minimum: 0, maximum: 1279 }, y: { type: "integer", minimum: 0, maximum: 799 }, button: { type: "string", enum: ["left", "right", "middle"] },
  }, ["x", "y"]) },
  { type: "function", name: "computer_type", description: `Type text into the focused computer field (up to ${MAX_TOOL_TEXT} characters).`, inputSchema: object({
    text: { type: "string", maxLength: MAX_TOOL_TEXT },
  }, ["text"]) },
  { type: "function", name: "computer_key", description: "Press one supported key on the computer.", inputSchema: object({
    key: { type: "string", enum: ["Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Control+a", "Control+c", "Control+v"] },
  }, ["key"]) },
  { type: "function", name: "computer_scroll", description: "Scroll the computer display by one to ten steps.", inputSchema: object({
    direction: { type: "string", enum: ["up", "down"] }, amount: { type: "integer", minimum: 1, maximum: 10 },
  }, ["direction", "amount"]) },
] as const;

export type ComputerAgent = {
  runtime: { ownerId: string; socketPath: string };
  tools: typeof COMPUTER_DYNAMIC_TOOLS;
};

const toolArguments: Record<Exclude<ComputerToolName, "computer_screenshot">, z.ZodType> = {
  computer_click: z.object({ x: z.number().int().min(0).max(1279), y: z.number().int().min(0).max(799), button: z.enum(["left", "right", "middle"]).optional() }).strict(),
  computer_type: z.object({ text: z.string().max(MAX_TOOL_TEXT) }).strict(),
  computer_key: z.object({ key: z.enum(["Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Control+a", "Control+c", "Control+v"]) }).strict(),
  computer_scroll: z.object({ direction: z.enum(["up", "down"]), amount: z.number().int().min(1).max(10) }).strict(),
};

function failure(text = "The computer tool is unavailable."): DynamicToolCallResult {
  return { success: false, contentItems: [{ type: "inputText", text }] };
}

async function agentRequest(agent: ComputerAgent, path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  try {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    return await socketFetch(agent.runtime.socketPath)(`${LOCAL_ORIGIN}/computer/agent/${path}`, {
      ...init, headers: { "x-collective-owner": agent.runtime.ownerId,
        ...(init.body != null ? { "Content-Type": "application/json" } : {}), ...Object.fromEntries(new Headers(init.headers)) },
      signal: requestSignal,
    });
  } catch {
    throw new HttpError(503, "The computer tool is unavailable.");
  }
}

/** Probe the owner-only broker route before exposing tools on newly started managed threads. */
export async function managedComputerAgent(runtime: CodexRuntime): Promise<ComputerAgent | null> {
  if (process.env.COMPUTER_VIEW_ENABLED !== "1" || !webSessionRegistryEnabled() || !runtime.managed || !runtime.socketPath || !isAbsolute(runtime.socketPath) ||
      /[\x00-\x1f]/.test(runtime.socketPath)) return null;
  const agent: ComputerAgent = { runtime: { ownerId: runtime.ownerId, socketPath: runtime.socketPath }, tools: COMPUTER_DYNAMIC_TOOLS };
  try {
    // The all-zero token is the broker's explicit agent-view sentinel; it is never a web session credential.
    const response = await socketFetch(runtime.socketPath)(`${LOCAL_ORIGIN}/computer/agent/status`, {
      method: "GET", headers: { "x-collective-owner": runtime.ownerId, "x-collective-view-session": "0".repeat(64) },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const status = ComputerViewStatusSchema.parse(await response.json());
    if (!status.available || status.state !== "running" || status.paused || status.control !== "agent") return null;
    return agent;
  } catch { return null; }
}

function inputForTool(tool: string, args: unknown): ComputerInput | null {
  if (!COMPUTER_TOOL_NAMES.includes(tool as ComputerToolName) || tool === "computer_screenshot") return null;
  const parsedArgs = toolArguments[tool as Exclude<ComputerToolName, "computer_screenshot">].safeParse(args);
  if (!parsedArgs.success) return null;
  const kind = tool.slice("computer_".length);
  const mapped = { ...(parsedArgs.data as Record<string, unknown>), kind };
  const parsed = ComputerInputSchema.safeParse(mapped);
  return parsed.success ? parsed.data : null;
}

async function boundedFrame(response: Response): Promise<Uint8Array | null> {
  if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "image/jpeg") return null;
  const size = Number(response.headers.get("content-length"));
  if (Number.isFinite(size) && size > COMPUTER_AGENT_FRAME_LIMIT) { await response.body?.cancel(); return null; }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > COMPUTER_AGENT_FRAME_LIMIT) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const dimensions = jpegDimensions(bytes);
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9 ||
      dimensions?.width !== 1280 || dimensions.height !== 800) return null;
  return bytes;
}

/** Tool arguments and results use the generated app-server call contract; the broker is the atomic pause fence. */
export async function invokeComputerTool(agent: ComputerAgent, tool: string, args: unknown, signal: AbortSignal,
  reauthorize: () => Promise<void>): Promise<DynamicToolCallResult> {
  if (!COMPUTER_TOOL_NAMES.includes(tool as ComputerToolName)) return failure("Unsupported computer tool.");
  if (tool === "computer_screenshot") {
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) return failure("Invalid computer tool arguments.");
    await reauthorize();
    const response = await agentRequest(agent, "frame", { method: "GET" }, signal);
    if (!response.ok) return failure();
    const frame = await boundedFrame(response);
    if (!frame) return failure("The computer did not return a valid screenshot.");
    await reauthorize();
    return { success: true, contentItems: [{ type: "inputImage", imageUrl: `data:image/jpeg;base64,${Buffer.from(frame).toString("base64")}` }] };
  }
  const input = inputForTool(tool, args);
  if (!input) return failure("Invalid computer tool arguments.");
  await reauthorize();
  const response = await agentRequest(agent, "input", { method: "POST", body: JSON.stringify(input) }, signal);
  if (!response.ok) return failure();
  return { success: true, contentItems: [{ type: "inputText", text: "Computer input completed." }] };
}
