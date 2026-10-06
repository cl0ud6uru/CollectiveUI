import "server-only";
import type { AiApp, Bot } from "@/db/schema";
import { providerContextFor } from "@/lib/llm/resolve";
import type { ProviderContext } from "@/lib/llm/providers/types";
import { HttpError } from "@/lib/authz";

const OFFICIAL_BASE_URL = "https://api.openai.com/v1";
const LIVE_URL = `${OFFICIAL_BASE_URL}/live/sessions`;
const SHORT_VOICE_INSTRUCTIONS = "Speak naturally and briefly. This is a voice conversation. You cannot call tools or take actions; explain that clearly if asked.";
const UPSTREAM_TIMEOUT_MS = 30_000;

export type VoiceTarget = { app: AiApp; bot: Bot | null };

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

export async function voiceEligibility({ app }: VoiceTarget): Promise<VoiceEligibility> {
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

function delegationInstructions(app: AiApp, bot: Bot | null): string {
  const customInstructions = [
    app.systemPrompt?.trim(),
    bot?.instructions?.trim(),
    bot?.boundaries?.trim() ? `Boundaries: ${bot.boundaries.trim()}` : undefined,
  ].filter((x): x is string => !!x).join("\n\n").slice(0, 18_000);
  const sections = [
    customInstructions,
    "You are a text model supporting a separate live voice conversation. You receive the voice transcript and should answer it directly.",
    "This voice session has no tools connected. Do not claim to browse, execute actions, or call the app's tools.",
  ].filter(Boolean);
  return sections.join("\n\n");
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

export async function createVoiceSession(target: VoiceTarget, sdp: string, fetchImpl: typeof fetch = fetch) {
  const { app, bot } = target;
  const ctx = await credentialContext(app);
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
          instructions: SHORT_VOICE_INSTRUCTIONS,
          delegation: { type: "responses", responses: { model: app.model, instructions: delegationInstructions(app, bot), tools: [], tool_choice: "none" } },
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
