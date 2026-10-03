import { z } from "zod";
import { HttpError } from "@/lib/authz";
import { REQUIRED_FEATURES, type HermesTarget } from "@/lib/llm/providers/hermes/client";
import { HERMES_PROTOCOL, loopbackUrl, PROVIDER_ENV, type ConnectionSecrets, type ManagedConfig } from "./config";

export const PROVISION_FAILURE = "Hermes profile setup is incomplete. Retry after one minute; an admin can check credentials, protocol and gateway readiness. Your assigned profile is retained.";
const failure = () => new HttpError(503, PROVISION_FAILURE);
const nameSchema = z.string().regex(/^cui-[a-f0-9]{32}$/);
type Connection = { dashboardUrl: string; runsUrl: string; protocol: string; expectedVersion: string; expectedDisplayVersion: string };

async function boundedJson(res: Response) {
  if (!res.ok || !res.body) { await res.body?.cancel(); throw failure(); }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256 * 1024) throw failure();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Display hygiene only: runtime isolation, not redaction, protects against adversarial output. */
function redactValue(value: unknown, keys: string[]): unknown {
  if (typeof value === "string") return keys.reduce((s, key) => s.split(key).join("[REDACTED]"), value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, keys));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [
    k, k === "error" && v && typeof v !== "boolean" ? "Hermes could not complete the operation." : redactValue(v, keys),
  ]));
  return value;
}

/** Native errors can arrive inside successful JSON/SSE responses, not only non-2xx HTTP bodies. */
async function safeNativeResponse(res: Response, keys: string[]) {
  if (!res.body) return res;
  if (!res.headers.get("content-type")?.includes("text/event-stream"))
    return Response.json(redactValue(await boundedJson(res), keys), { status: res.status });
  const decoder = new TextDecoder(), encoder = new TextEncoder();
  let buffer = "";
  const emit = (controller: TransformStreamDefaultController<Uint8Array>, final = false) => {
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(buffer);
      if (!boundary && !final) break;
      const frame = boundary ? buffer.slice(0, boundary.index) : buffer;
      if (frame.length > 256 * 1024) throw failure();
      buffer = boundary ? buffer.slice(boundary.index + boundary[0].length) : "";
      const lines = frame.split(/\r?\n/);
      const data = lines.filter((s) => s.startsWith("data:")).map((s) => s.slice(5).replace(/^ /, "")).join("\n");
      const id = lines.findLast((s) => s.startsWith("id:"));
      if (data) {
        let parsed: unknown;
        try { parsed = JSON.parse(data); } catch { throw failure(); }
        controller.enqueue(encoder.encode(`${id ? `${redactValue(id, keys)}\n` : ""}data: ${JSON.stringify(redactValue(parsed, keys))}\n\n`));
      } else if (frame) controller.enqueue(encoder.encode(": keepalive\n\n"));
      if (!boundary) break;
    }
    if (buffer.length > 256 * 1024) throw failure();
  };
  return new Response(res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) { buffer += decoder.decode(chunk, { stream: true }); emit(controller); },
    flush(controller) { buffer += decoder.decode(); emit(controller, true); },
  })), { status: res.status, headers: { "Content-Type": "text/event-stream" } });
}

/** No general dashboard proxy. All paths and request bodies are constructed here, never from agent input. */
export class ProfileProtocol {
  constructor(private c: Connection, private secrets: ConnectionSecrets, private transport: typeof fetch = fetch) {
    loopbackUrl.parse(c.dashboardUrl); loopbackUrl.parse(c.runsUrl);
    if (c.protocol !== HERMES_PROTOCOL || c.dashboardUrl === c.runsUrl || secrets.dashboardToken === secrets.providerKey ||
      secrets.profileKeys.includes(secrets.dashboardToken) || secrets.profileKeys.includes(secrets.providerKey)) throw failure();
  }
  private async call(path: string, body?: unknown, method = "GET") {
    try {
      return await boundedJson(await this.transport(`${this.c.dashboardUrl}${path}`, {
        method, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(8000),
        headers: { "X-Hermes-Session-Token": this.secrets.dashboardToken, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
    } catch (err) { throw err instanceof HttpError ? err : failure(); }
  }
  private async health() {
    const health = z.object({ ok: z.literal(true), version: z.string(), displayVersion: z.string(), auth_required: z.literal(false) }).parse(await this.call("/api/health"));
    if (health.version !== this.c.expectedVersion || health.displayVersion !== this.c.expectedDisplayVersion) throw failure();
  }
  private async roster() {
    // Authenticated management read, distinct from the public health check.
    return z.object({ profiles: z.array(z.object({ name: z.string(), description: z.string(), is_default: z.boolean(), model: z.string().nullable(), provider: z.string().nullable() })).max(2000) }).parse(await this.call("/api/profiles")).profiles;
  }
  async check() {
    await this.health();
    return this.roster();
  }
  async prepare(name: string, marker: string, attempted: boolean, config: ManagedConfig, soul: string, keySlot: number, beforeCreate: () => Promise<void>) {
    nameSchema.parse(name);
    const existing = (await this.check()).find((p) => p.name === name);
    if (existing && (!attempted || existing.is_default || existing.description !== marker))
      throw new HttpError(409, "Hermes profile identity conflicts with an existing profile. An operator must investigate; nothing was overwritten.");
    if (!existing) {
      await beforeCreate(); // durable intent before any remote side effect
      z.object({ ok: z.literal(true), name: z.literal(name), model_set: z.boolean(), model_error: z.string(), hub_installs: z.array(z.unknown()).length(0) }).parse(await this.call("/api/profiles", {
        name, description: marker, clone_from: null, clone_from_default: false, clone_all: false, clone_channels: false,
        no_skills: true, provider: config.provider, model: config.model, mcp_servers: [], keep_skills: [], hub_skills: [],
      }, "POST"));
      // Even model_set:false/model_error is only a partial result. Always apply credentials/model below
      // and verify actual state; the durable reservation owns the partial profile without replacement.
    }
    const apiKey = this.secrets.profileKeys[keySlot];
    if (!apiKey) throw failure();
    await this.call("/api/env", { profile: name, key: PROVIDER_ENV[config.provider], value: this.secrets.providerKey }, "PUT");
    await this.call(`/api/profiles/${name}/model`, { provider: config.provider, model: config.model }, "PUT");
    await this.call(`/api/profiles/${name}/soul`, { content: soul }, "PUT");
    await this.call("/api/config", { profile: name, config: {
      platform_toolsets: { api_server: config.toolsets, cli: [] },
      skills: { external_dirs: [] }, mcp_servers: {}, approvals: { mode: "manual", timeout: 300 },
    } }, "PUT");
    // Publish the profile only after its explicit instructions and tool configuration are written.
    await this.call("/api/env", { profile: name, key: "API_SERVER_KEY", value: apiKey }, "PUT");
    await this.call("/api/env", { profile: name, key: "API_SERVER_ENABLED", value: "true" }, "PUT");
    await this.verify(name, config, soul, keySlot, true);
  }
  async verify(name: string, config: ManagedConfig, soul: string, keySlot: number, initial = false) {
    nameSchema.parse(name);
    await this.health();
    const t = this.target(name, keySlot);
    const get = async (path: string) => boundedJson(await t.fetch!(`${t.baseUrl}/p/${name}${path}`, {
      headers: { Authorization: `Bearer ${t.apiKey}` }, signal: AbortSignal.timeout(8000), redirect: "error",
    }));
    // Independent reads overlap after the version gate; each transport still refreshes authorization.
    const reads = await Promise.allSettled([
      this.roster(), this.call(`/api/config?profile=${name}`), this.call(`/api/profiles/${name}/soul`),
      get("/v1/capabilities"), get("/v1/models"), get("/v1/toolsets"),
      ...(initial ? [this.call(`/api/skills?profile=${name}`)] : []),
    ]);
    const values = reads.map((r) => { if (r.status === "rejected") throw r.reason; return r.value; });
    const profile = (values[0] as Awaited<ReturnType<ProfileProtocol["roster"]>>).find((p) => p.name === name);
    const saved = z.object({
      model: z.string(), platform_toolsets: z.object({ api_server: z.array(z.string()), cli: z.array(z.unknown()).length(0) }),
      skills: z.object({ external_dirs: z.array(z.unknown()).length(0) }),
      mcp_servers: z.record(z.string(), z.unknown()).refine((v) => Object.keys(v).length === 0),
      approvals: z.object({ mode: z.literal("manual"), timeout: z.literal(300) }),
    }).parse(values[1]);
    if (profile?.provider !== config.provider || profile.model !== config.model || saved.model !== config.model ||
      JSON.stringify([...saved.platform_toolsets.api_server].sort()) !== JSON.stringify([...config.toolsets].sort())) throw failure();
    const persona = z.object({ exists: z.literal(true), content: z.string() }).parse(values[2]);
    if (persona.content !== soul) throw failure();
    // Initial clean profile check. Later Hermes may legitimately learn new skills in this user's boundary.
    if (initial) z.array(z.unknown()).length(0).parse(values[6]);
    const caps = z.object({ features: z.record(z.string(), z.unknown()) }).parse(values[3]);
    if (REQUIRED_FEATURES.some((f) => caps.features[f] !== true)) throw failure();
    const models = z.object({ data: z.array(z.object({ id: z.string() })) }).parse(values[4]);
    // Pinned _handle_models advertises the active profile name, NOT its provider's native model ID.
    // The dashboard checks above verify the actual model/provider configuration independently.
    if (!models.data.some((m) => m.id === name)) throw failure();
    const toolsets = z.object({ data: z.array(z.object({ name: z.string(), enabled: z.boolean(), configured: z.boolean() })) }).parse(values[5]);
    const enabled = toolsets.data.filter((t) => t.enabled);
    if (enabled.some((t) => !t.configured) || JSON.stringify(enabled.map((t) => t.name).sort()) !== JSON.stringify([...config.toolsets].sort())) throw failure();
  }
  target(name: string, keySlot: number): HermesTarget {
    nameSchema.parse(name);
    const prefix = `${this.c.runsUrl}/p/${name}/v1/`;
    const transport: typeof fetch = async (input, init) => {
      const url = String(input);
      const parsed = new URL(url);
      if (!url.startsWith(prefix) || parsed.href !== url || parsed.origin !== this.c.runsUrl ||
        !parsed.pathname.startsWith(`/p/${name}/v1/`) || /%2f|%5c/i.test(parsed.pathname) || parsed.hash || parsed.search ||
        !this.secrets.profileKeys[keySlot]) throw failure();
      const res = await this.transport(url, { ...init, redirect: "error", cache: "no-store" });
      // Discard upstream error bodies: provider errors can contain credentials or filesystem paths.
      if (!res.ok) { await res.body?.cancel(); return Response.json({}, { status: res.status }); }
      return safeNativeResponse(res, [this.secrets.dashboardToken, this.secrets.providerKey, ...this.secrets.profileKeys].sort((a, b) => b.length - a.length));
    };
    return { baseUrl: this.c.runsUrl, profile: name, apiKey: this.secrets.profileKeys[keySlot], fetch: transport };
  }
}
