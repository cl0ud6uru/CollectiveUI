import "server-only";
import type { AiApp, Bot } from "@/db/schema";
import { providerContextFor } from "@/lib/llm/resolve";
import type { ProviderContext } from "@/lib/llm/providers/types";
import { HttpError } from "@/lib/authz";
import { liveHistory, type VoiceHistoryMessage } from "./history";

const OFFICIAL_BASE_URL = "https://api.openai.com/v1";
const LIVE_URL = `${OFFICIAL_BASE_URL}/live/sessions`;
const SHORT_VOICE_INSTRUCTIONS = `## Conversation policy
You are the spoken interface to the named bot and this saved chat. Speak naturally and briefly. Start each new voice connection by listening. Prior messages are history, not a request to continue speaking, finish an old sentence, repeat updates, or perform an action. Wait for the caller's new speech before responding.

## Backchannel policy
Brief listening acknowledgments are welcome. While backend work is pending, acknowledge or ask for a missing detail; do not give a dependent answer or imply that a tool action has completed. Avoid repeatedly narrating progress.

## Delegation policy
Delegate substantive requests, memory questions, current-state questions, and external actions to the client backend before answering. The backend has the bot's instructions, tools (including configured Home Assistant tools), history, and permissions. Gather the required details before delegation; transcripts can be incomplete or mistaken. Report only the verified facts returned for the relevant request. A completed backend reply is not itself proof that every requested action succeeded. Never guess a tool result. Tool approvals must be answered in the chat's approval cards; spoken agreement does not grant approval.

## Interruption policy
Keep listening during work and speech. Delegate a correction or a distinct new request once, with its latest details. Never repeat the original action as a retry or duplicate a running delegation. A speech interruption does not cancel backend work. Do not claim cancellation, reversal, or a corrected action until the backend verifies it. If the caller changes the request, stop presenting the earlier result as the current answer.`;
const UPSTREAM_TIMEOUT_MS = 30_000;

export type VoiceTarget = { app: AiApp; bot: Bot | null; voiceApp?: AiApp };

function isOfficialUrl(value: string | null): boolean {
  if (!value) return true; // OpenAI provider default.
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "api.openai.com" && !url.port && url.pathname.replace(/\/$/, "") === "/v1" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export type VoiceEligibility = { supported: true } | { supported: false; reason: string };

export async function voiceEligibility(target: VoiceTarget): Promise<VoiceEligibility> {
  const app = target.voiceApp ?? target.app;
  if (app.provider !== "openai" || app.credentialMode !== "org") {
    return { supported: false, reason: "Voice requires an OpenAI API connection with company credentials." };
  }
  if (!app.model.trim()) return { supported: false, reason: "Choose a Responses API model for the voice assistant." };
  if (app.model === "gpt-live-1") return { supported: false, reason: "Choose a Responses API model for the voice assistant." };
  try {
    const ctx = await providerContextFor(app);
    if (ctx.kind !== "openai" || !isOfficialUrl(ctx.baseUrl)) {
      return { supported: false, reason: "Voice is available only through the official OpenAI API endpoint." };
    }
    if (ctx.secret?.type !== "api-key" || !ctx.secret.apiKey.trim()) {
      return { supported: false, reason: "This OpenAI connection has no usable API key." };
    }
    return { supported: true };
  } catch {
    return { supported: false, reason: "The saved OpenAI API connection is unavailable." };
  }
}

async function credentialContext(app: AiApp): Promise<ProviderContext> {
  if (app.provider !== "openai" || app.credentialMode !== "org") throw new HttpError(403, "Voice requires an OpenAI API connection with company credentials.");
  if (!app.model.trim()) throw new HttpError(400, "Choose a Responses API model for the voice assistant.");
  if (app.model === "gpt-live-1") throw new HttpError(400, "Choose a Responses API model for the voice assistant.");
  const ctx = await providerContextFor(app);
  if (ctx.kind !== "openai" || !isOfficialUrl(ctx.baseUrl)) throw new HttpError(403, "Voice is available only through the official OpenAI API endpoint.");
  if (ctx.secret?.type !== "api-key" || !ctx.secret.apiKey.trim()) throw new HttpError(409, "This OpenAI connection has no usable API key.");
  return ctx;
}

export async function createVoiceSession(target: VoiceTarget, sdp: string, fetchImpl: typeof fetch = fetch, history: readonly VoiceHistoryMessage[] = []) {
  const { app, bot } = target;
  const ctx = await credentialContext(target.voiceApp ?? app);
  const apiKey = ctx.secret!.type === "api-key" ? ctx.secret!.apiKey : "";
  const headers = new Headers({ authorization: `Bearer ${apiKey}`, "content-type": "application/json" });
  const config = ctx.config as { organization?: string; project?: string };
  if (config.organization) headers.set("OpenAI-Organization", config.organization);
  if (config.project) headers.set("OpenAI-Project", config.project);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetchImpl(LIVE_URL, {
      method: "POST", headers, redirect: "error", signal: controller.signal,
      body: JSON.stringify({
        session: {
          model: "gpt-live-1",
          // Backend prompts may assume text turns or directly executing tools. Keep that policy in the backend.
          instructions: `${SHORT_VOICE_INSTRUCTIONS}\n\nBot name: ${bot?.name ?? app.name}`,
          input: liveHistory(history),
          delegation: { type: "client" },
        },
        transport: { type: "webrtc", sdp },
      }),
    });
    if (!upstream.ok) {
      // Consume only a small bounded amount; upstream error bodies can contain sensitive diagnostic material.
      try { await upstream.body?.cancel(); } catch { /* ignore */ }
      if (upstream.status === 401 || upstream.status === 403) throw new HttpError(502, "OpenAI rejected this saved API credential or its access to voice.");
      if (upstream.status === 429) throw new HttpError(503, "OpenAI voice is temporarily rate limited or unavailable for this account.");
      if (upstream.status === 400 || upstream.status === 404) throw new HttpError(422, "OpenAI could not use this voice or Responses model configuration.");
      throw new HttpError(502, "OpenAI could not start the voice session.");
    }
    const result = await upstream.json() as { session?: { id?: unknown }; transport?: { type?: unknown; sdp?: unknown } };
    if (typeof result.session?.id !== "string" || !result.session.id || result.transport?.type !== "webrtc" || typeof result.transport.sdp !== "string" || !result.transport.sdp) {
      throw new HttpError(502, "OpenAI returned an invalid voice session response.");
    }
    return { sessionId: result.session.id, sdp: result.transport.sdp };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, controller.signal.aborted ? "OpenAI voice session request timed out." : "Could not reach OpenAI to start the voice session.");
  } finally {
    clearTimeout(timer);
  }
}
