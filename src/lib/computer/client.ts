import "server-only";
import { createHash } from "node:crypto";
import { HttpError } from "@/lib/authz";
import { socketFetch, LOCAL_ORIGIN } from "@/lib/local-hermes/client";
import { ComputerViewStatusSchema, type ComputerInput, type ComputerViewStatus } from "./contracts";
import type { AuthorizedComputerView } from "./access";

export function computerViewSessionToken(view: Pick<AuthorizedComputerView, "sessionId" | "conversationId">): string {
  return createHash("sha256").update("collective:computer-view:v1\0").update(view.sessionId).update("\0").update(view.conversationId).digest("hex");
}

function headers(view: AuthorizedComputerView, json = false) {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    "x-collective-owner": view.ownerUserId,
    "x-collective-view-session": computerViewSessionToken(view),
  };
}

async function request(view: AuthorizedComputerView, path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await socketFetch(view.socketPath)(`${LOCAL_ORIGIN}/computer/${path}`, {
      ...init, headers: { ...headers(view, init.body != null), ...Object.fromEntries(new Headers(init.headers)) },
      signal: init.signal ?? AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "Computer view is unavailable.");
  }
}

async function jsonError(response: Response): Promise<never> {
  if (response.status === 409) throw new HttpError(409, "Take control before sending input.");
  if (response.status === 400) throw new HttpError(400, "Invalid computer request.");
  throw new HttpError(503, "Computer view is unavailable.");
}

export async function computerStatus(view: AuthorizedComputerView, signal?: AbortSignal): Promise<ComputerViewStatus> {
  const response = await request(view, "status", { signal });
  if (!response.ok) return jsonError(response);
  try { return ComputerViewStatusSchema.parse(await response.json()); }
  catch { throw new HttpError(503, "Computer view is unavailable."); }
}

export async function computerFrame(view: AuthorizedComputerView, signal?: AbortSignal): Promise<Response> {
  const response = await request(view, "frame", { signal });
  if (!response.ok) return jsonError(response);
  return response;
}

export async function computerControl(view: AuthorizedComputerView, action: "takeover" | "release" | "heartbeat", signal?: AbortSignal): Promise<ComputerViewStatus> {
  const response = await request(view, "control", { method: "POST", body: JSON.stringify({ action }), signal });
  if (!response.ok) return jsonError(response);
  try { return ComputerViewStatusSchema.parse(await response.json()); }
  catch { throw new HttpError(503, "Computer view is unavailable."); }
}

export async function computerInput(view: AuthorizedComputerView, input: ComputerInput, signal?: AbortSignal): Promise<void> {
  const response = await request(view, "input", { method: "POST", body: JSON.stringify(input), signal });
  if (!response.ok) return jsonError(response);
}
