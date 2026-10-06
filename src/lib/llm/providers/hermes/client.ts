/**
 * Client for a Hermes Agent API server (docs/architecture/hermes.md): the Runs API (start, events, approval, stop,
 * status) plus the checks behind "Test". Server-side only. The key is a profile's API_SERVER_KEY, which opens that
 * profile's whole toolset (terminal included), so it never leaves the server and never appears in an error message.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import type { Discovery, HermesSkill, HermesToolset } from "@/lib/chat/hermes-commands";
import { isPrivateAddress } from "@/lib/agent/tools/web";
import { HttpError } from "@/lib/authz";
import { isBlockedAddress } from "@/lib/mcp/url";
import { nativeAttachments, type NativeAttachment, type ManagedRunView } from "@/local-hermes/interactions";
import { parseSse } from "./sse";

export type HermesTarget = {
  /** Server root, e.g. https://hermes.internal:8642 (normalized by the catalog). */
  baseUrl: string;
  /** Profile served at /p/<profile>/; "" = the server's default profile. */
  profile: string;
  apiKey: string;
  fetch?: typeof fetch;
  /** Controller adapter: private IPC, native sessions and durable local admission. */
  local?: boolean;
};

/** One Runs API event: `event` names it; the other fields depend on the event (see mapper.ts). */
export type HermesEvent = { event: string; [key: string]: unknown };

export type HermesRunStatus = {
  run_id: string;
  status: string;
  output?: string;
  usage?: Record<string, number>;
  runtime?: { provider?: string; model?: string };
  error?: string;
  approval?: HermesEvent;
};

export type HermesErrorCode = "unreachable" | "unauthorized" | "profile_missing" | "busy" | "not_found" | "rejected" | "server" | "protocol" | "run_failed";

const MESSAGES: Record<HermesErrorCode, string> = {
  unreachable: "The Hermes server isn't reachable right now. Try again in a moment.",
  unauthorized: "Hermes rejected the portal's key for this profile. An admin needs to update it in Admin → Apps.",
  profile_missing: "Hermes doesn't serve this profile (check the profile name, and that the Hermes gateway runs with profiles multiplexed).",
  busy: "Hermes is busy with other conversations right now. Try again in a moment.",
  not_found: "Hermes no longer knows this run.",
  rejected: "Hermes refused the request.",
  server: "Hermes hit an error.",
  protocol: "Hermes sent a reply the portal couldn't read.",
  run_failed: "Hermes couldn't finish:",
};

/**
 * Errors people can act on; the chat shows the message as is (never the key; Hermes redacts secrets from its own
 * error text before sending it).
 */
export class HermesError extends HttpError {
  readonly code: HermesErrorCode;
  readonly userFacing = true;
  constructor(code: HermesErrorCode, status = 0, detail?: string) {
    super(status || 502, detail ? `${MESSAGES[code]} ${detail}` : MESSAGES[code]);
    this.name = "HermesError";
    this.code = code;
  }
}

const root = (t: HermesTarget) => (t.profile ? `${t.baseUrl}/p/${encodeURIComponent(t.profile)}` : t.baseUrl);

/** Hermes' own error text, trimmed and without anything that looks like a key. */
async function detailOf(res: Response): Promise<{ code?: string; message?: string }> {
  try {
    const body = (await res.json()) as { error?: string | { message?: string; code?: string } };
    const err = body.error;
    if (typeof err === "string") return { message: err.slice(0, 300) };
    return { code: err?.code, message: err?.message?.slice(0, 300) };
  } catch {
    return {};
  }
}

async function call(t: HermesTarget, path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const f = t.fetch ?? fetch;
  const { timeoutMs = 30_000, signal, headers, ...rest } = init;
  const timeout = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await f(`${root(t)}${path}`, {
      ...rest,
      redirect: "error",
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Authorization: `Bearer ${t.apiKey}`, ...(rest.body ? { "Content-Type": "application/json" } : {}), ...headers },
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError" && signal?.aborted) throw err;
    throw new HermesError("unreachable");
  }
  return res;
}

async function failure(res: Response): Promise<HermesError> {
  const d = await detailOf(res);
  if (res.status === 401 || res.status === 403) return new HermesError("unauthorized", res.status);
  if (res.status === 404 && /profile/i.test(d.message ?? "")) return new HermesError("profile_missing", 404);
  if (res.status === 404) return new HermesError("not_found", 404);
  if (res.status === 429) return new HermesError("busy", 429);
  if (res.status >= 500) return new HermesError("server", res.status);
  return new HermesError("rejected", res.status, d.message);
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw await failure(res);
  try {
    return (await res.json()) as T;
  } catch {
    throw new HermesError("protocol", res.status);
  }
}

export type StartRun = {
  attachments?: NativeAttachment[];
  input: string;
  sessionId: string | null;
  instructions?: string;
  idempotencyKey: string;
  /** Scopes Hermes' long-term memory providers per portal user (never the user's id itself). */
  sessionKey?: string | null;
  signal?: AbortSignal;
  /** An admin-approved route alias; a request, not a guarantee of the effective runtime. */
  model?: string | null;
};

export async function startRun(t: HermesTarget, r: StartRun): Promise<string> {
  const body: Record<string, unknown> = { input: r.input };
  if (r.sessionId) body.session_id = r.sessionId;
  if (r.instructions) body.instructions = r.instructions;
  if (r.model) body.model = r.model;
  if (r.attachments?.length) {
    if (!t.local) throw new HermesError("rejected", 400, "Native file transport is unavailable on this Hermes connection.");
    body.attachments = nativeAttachments.parse(r.attachments);
  }
  const res = await call(t, "/v1/runs", {
    method: "POST",
    body: JSON.stringify(body),
    signal: r.signal,
    headers: { "Idempotency-Key": r.idempotencyKey, ...(r.sessionKey ? { "X-Hermes-Session-Key": r.sessionKey } : {}) },
  });
  const out = await json<{ run_id?: string; runId?: string; id?: string }>(res);
  const runId = out.run_id ?? out.runId ?? out.id;
  if (!runId) throw new HermesError("protocol", res.status);
  return runId;
}

/**
 * The run's events, in order, until the stream closes. Throws HermesError("not_found") when Hermes no longer has the
 * stream (releases up to v2026.9.24 keep it only for the first subscriber; newer ones resume after `lastEventId`).
 */
export async function* runEvents(t: HermesTarget, runId: string, opts: { signal?: AbortSignal; lastEventId?: string } = {}): AsyncGenerator<HermesEvent> {
  const res = await call(t, `/v1/runs/${encodeURIComponent(runId)}/events`, {
    signal: opts.signal,
    timeoutMs: 24 * 3600_000,
    headers: { Accept: "text/event-stream", ...(opts.lastEventId ? { "Last-Event-ID": opts.lastEventId } : {}) },
  });
  if (!res.ok) throw await failure(res);
  if (!res.body) throw new HermesError("protocol", res.status);
  for await (const frame of parseSse(res.body)) {
    let event: unknown;
    try {
      event = JSON.parse(frame.data);
    } catch {
      continue;
    }
    if (event && typeof event === "object" && typeof (event as HermesEvent).event === "string") {
      yield frame.id ? { ...(event as HermesEvent), _seq: frame.id } : (event as HermesEvent);
    }
  }
}

/** "resolved", or "not_pending" when Hermes already settled it (timed out, answered elsewhere, run stopped). */
export async function answerApproval(t: HermesTarget, runId: string, requestId: string, choice: "once" | "deny"): Promise<"resolved" | "not_pending"> {
  const res = await call(t, `/v1/runs/${encodeURIComponent(runId)}/approval`, {
    method: "POST",
    body: JSON.stringify({ choice, request_id: requestId }),
  });
  if (res.status === 409 || res.status === 404) return "not_pending";
  await json(res);
  return "resolved";
}

/** Asks Hermes to stop the run; a run that already ended is fine. */
export async function stopRun(t: HermesTarget, runId: string): Promise<void> {
  const res = await call(t, `/v1/runs/${encodeURIComponent(runId)}/stop`, { method: "POST", timeoutMs: 10_000 });
  if (!res.ok && res.status !== 404 && res.status !== 409) throw await failure(res);
}

export async function getRun(t: HermesTarget, runId: string): Promise<HermesRunStatus> {
  return json<HermesRunStatus>(await call(t, `/v1/runs/${encodeURIComponent(runId)}`, { timeoutMs: 10_000 }));
}

/** Discovery is untrusted metadata. Bound the body before parsing and project only display fields. */
async function discoveryJson(t: HermesTarget, path: string): Promise<unknown> {
  const res = await call(t, path, { timeoutMs: 5_000 });
  if (!res.ok) {
    await res.body?.cancel();
    throw new HermesError(res.status === 401 || res.status === 403 ? "unauthorized" : "server");
  }
  if (!res.body) throw new HermesError("protocol");
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256 * 1024) throw new HermesError("protocol");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const displayName = z.string().min(1).max(200);
const skillSchema = z.object({ name: displayName, description: z.string().max(2000).default("") });
const toolsetSchema = skillSchema.extend({ enabled: z.boolean(), configured: z.boolean() });

async function discover<T>(t: HermesTarget, path: string, schema: z.ZodType<T>): Promise<Discovery<T>> {
  try {
    const result = z.object({ data: z.array(schema).max(5000) }).parse(await discoveryJson(t, path));
    return { available: true, items: result.data.slice(0, 200) };
  } catch (err) {
    return { available: false, reason: err instanceof HermesError && err.code === "unauthorized" ? MESSAGES.unauthorized : "Discovery is unavailable on this Hermes server. Chat and local commands still work." };
  }
}

export async function discoverHermes(t: HermesTarget): Promise<{
  models: Discovery<string>; skills: Discovery<HermesSkill>; tools: Discovery<HermesToolset>; canStopRemotely: boolean; capabilityWarning?: string;
}> {
  const [models, skills, tools, caps] = await Promise.all([
    discover(t, "/v1/models", z.object({ id: displayName })),
    discover(t, "/v1/skills", skillSchema),
    discover(t, "/v1/toolsets", toolsetSchema),
    discoveryJson(t, "/v1/capabilities").then((data) => z.object({ features: z.object({ run_stop: z.boolean() }) }).parse(data)).catch(() => null),
  ]);
  return {
    models: models.available ? { available: true, items: models.items.map((m) => m.id) } : models,
    skills, tools, canStopRemotely: caps?.features.run_stop === true,
    ...(!caps ? { capabilityWarning: "Hermes capabilities could not be checked. Remote cancellation will be attempted and its outcome reported." }
      : !caps.features.run_stop ? { capabilityWarning: "This server does not advertise remote cancellation. /stop still cancels locally and reports whether Hermes confirms completion." } : {}),
  };
}

/** Features the portal relies on (from /v1/capabilities). */
export const REQUIRED_FEATURES = ["run_submission", "run_events_sse", "run_stop", "run_approval_response", "approval_events"] as const;

export type HermesCheck = { ok: true; version: string | null; models: string[]; missing: string[] } | { ok: false; error: string };

/** "Test": the server answers, the key opens this profile, and the Runs API features are there. */
export async function checkHermes(t: HermesTarget): Promise<HermesCheck> {
  try {
    const health = await json<{ version?: string }>(await call(t, "/health", { timeoutMs: 10_000 })).catch((err): { version?: string } => {
      // /health doesn't need the key; a profile-less server may not mirror it under /p/.
      if (err instanceof HermesError && err.code === "not_found") return {};
      throw err;
    });
    const caps = await json<{ features?: Record<string, unknown> }>(await call(t, "/v1/capabilities", { timeoutMs: 10_000 }));
    const models = await json<{ data?: { id?: string }[] }>(await call(t, "/v1/models", { timeoutMs: 10_000 }));
    const missing = REQUIRED_FEATURES.filter((f) => !caps.features?.[f]);
    return {
      ok: true,
      version: typeof health.version === "string" ? health.version : null,
      models: (models.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean),
      missing,
    };
  } catch (err) {
    return { ok: false, error: err instanceof HermesError ? err.message : "The Hermes server couldn't be checked." };
  }
}

type Lookup = (host: string) => Promise<{ address: string }[]>;
const defaultLookup: Lookup = (host) => dnsLookup(host, { all: true });

/**
 * Where the portal may send a Hermes key: https anywhere, plain http only inside the private network (a LAN, VPN,
 * tailnet or compose address), never link-local or cloud metadata addresses. Null when fine, else the reason.
 */
export async function checkHermesUrl(raw: string, lookup: Lookup = defaultLookup): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Not a valid URL";
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host)).map((a) => a.address);
  } catch {
    return url.protocol === "https:" ? null : `Can't resolve ${host}`;
  }
  if (addresses.some(isBlockedAddress)) return "Link-local and cloud metadata addresses are blocked";
  if (url.protocol === "http:" && addresses.some((a) => !isPrivateAddress(a))) {
    return "Use https for a Hermes server outside your network (its key would travel in cleartext)";
  }
  return null;
}

/** Private controller operations only; callers resolve the owned provider run from durable portal records. */
export async function managedRunView(t: HermesTarget, runId: string): Promise<ManagedRunView> {
  if (!t.local || !/^run_[a-f0-9]{32}$/.test(runId)) throw new HermesError('rejected', 400, 'Native run inspection is unavailable.');
  return json<ManagedRunView>(await call(t, `/v1/runs/${runId}/native`));
}
export async function controlManagedRun(t: HermesTarget, runId: string, input: unknown) {
  if (!t.local || !/^run_[a-f0-9]{32}$/.test(runId)) throw new HermesError('rejected', 400, 'Native controls are unavailable.');
  return json(await call(t, `/v1/runs/${runId}/native`, { method: 'POST', body: JSON.stringify(input) }));
}
