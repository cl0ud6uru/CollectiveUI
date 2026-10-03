import { generateText, wrapLanguageModel } from "ai";
import { CATALOG, type AnyProviderConfig, type EnabledKind, type ProviderConfigMap } from "./catalog";
import { describeHttpStatus, describeProviderError } from "./errors";
import { defaultsMiddleware } from "./middleware";
import { PROVIDERS } from "./providers";
import { checkHermes, checkHermesUrl, hermesTarget } from "./providers/hermes";
import { ANTHROPIC_DEFAULT_BASE_URL } from "./providers/anthropic";
import { OPENAI_DEFAULT_BASE_URL } from "./providers/openai";
import type { AppSecret } from "./secrets";

export type ConnectionTestInput = {
  kind: EnabledKind;
  name: string;
  /** Normalized base URL (null = vendor default). */
  baseUrl: string | null;
  config: AnyProviderConfig;
  secret: AppSecret | undefined;
  model?: string;
  fetch?: typeof fetch;
};

export type ConnectionTestResult = { ok: true; models: string[]; note?: string } | { ok: false; error: string };

class ListError extends Error {
  constructor(public status: number) {
    super(`${status}`);
  }
}

async function getJson(url: string, headers: Record<string, string>, f: typeof fetch): Promise<unknown> {
  const res = await f(url, { headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new ListError(res.status);
  return res.json();
}

const ids = (body: unknown) => ((body as { data?: { id?: unknown }[] }).data ?? []).map((m) => String(m.id ?? "")).filter(Boolean);
const apiKey = (s: AppSecret | undefined) => (s?.type === "api-key" ? s.apiKey : undefined);

async function listModels(i: ConnectionTestInput, f: typeof fetch): Promise<string[] | null> {
  const key = apiKey(i.secret);
  switch (i.kind) {
    case "openai-compatible":
      return ids(await getJson(`${(i.baseUrl ?? "").replace(/\/+$/, "")}/models`, key ? { Authorization: `Bearer ${key}` } : {}, f));
    case "openai": {
      const cfg = i.config as ProviderConfigMap["openai"];
      const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
      if (cfg.organization) headers["OpenAI-Organization"] = cfg.organization;
      if (cfg.project) headers["OpenAI-Project"] = cfg.project;
      return ids(await getJson(`${i.baseUrl ?? OPENAI_DEFAULT_BASE_URL}/models`, headers, f));
    }
    case "azure":
      // Lists the resource's models, not its deployments; the probe below checks the deployment.
      return ids(await getJson(`${i.baseUrl}/models`, { "api-key": key ?? "" }, f));
    case "anthropic": {
      const out: string[] = [];
      let after: string | undefined;
      for (let page = 0; page < 5; page++) {
        const qs = new URLSearchParams({ limit: "1000", ...(after ? { after_id: after } : {}) });
        let body: { data?: { id?: string }[]; has_more?: boolean; last_id?: string };
        try {
          body = (await getJson(`${i.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL}/models?${qs}`, { "x-api-key": key ?? "", "anthropic-version": "2023-06-01" }, f)) as typeof body;
        } catch (err) {
          // Claude on Microsoft Foundry has no Models API: fall back to a probe.
          if (err instanceof ListError && (err.status === 404 || err.status === 405)) return null;
          throw err;
        }
        out.push(...ids(body));
        if (!body.has_more || !body.last_id) break;
        after = body.last_id;
      }
      return out;
    }
    default:
      return null;
  }
}

async function probe(i: ConnectionTestInput): Promise<void> {
  const instance = await PROVIDERS[i.kind].create({
    appId: "connection-test",
    appName: i.name,
    kind: i.kind,
    baseUrl: i.baseUrl,
    config: i.config,
    secret: i.secret,
    fetch: i.fetch,
  });
  await generateText({
    model: wrapLanguageModel({ model: instance.chat(i.model!), middleware: defaultsMiddleware(i.kind, i.config, i.model!, "probe") }),
    prompt: "Reply with OK.",
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(20_000),
  });
}

/**
 * Admin "Test connection". Lists models where the vendor has a cheap endpoint, otherwise sends one tiny request
 * with the configured model. Test calls are not recorded in the usage ledger.
 */
export async function testConnection(i: ConnectionTestInput): Promise<ConnectionTestResult> {
  const f = i.fetch ?? globalThis.fetch;
  if (i.kind === "hermes") return testHermes(i);
  try {
    const models = CATALOG[i.kind].test === "list" ? await listModels(i, f) : null;
    const needsProbe = models === null || (i.kind === "azure" && !!i.model);
    if (needsProbe) {
      if (!i.model) return { ok: false, error: `Enter the ${CATALOG[i.kind].modelLabel.toLowerCase()} first, then test.` };
      await probe(i);
    }
    return { ok: true, models: models ?? [], note: needsProbe ? `${i.model} answered` : undefined };
  } catch (err) {
    if (err instanceof ListError) return { ok: false, error: describeHttpStatus(err.status) ?? `The endpoint returned HTTP ${err.status}.` };
    return { ok: false, error: describeProviderError(err) };
  }
}

/** Hermes: the URL is safe for the key, the server answers, the key opens the profile, and the Runs API is there. */
async function testHermes(i: ConnectionTestInput): Promise<ConnectionTestResult> {
  const target = hermesTarget({ appId: "connection-test", appName: i.name, kind: "hermes", baseUrl: i.baseUrl, config: i.config, secret: i.secret, fetch: i.fetch });
  const problem = await checkHermesUrl(target.baseUrl);
  if (problem) return { ok: false, error: problem };
  const r = await checkHermes(target);
  if (!r.ok) return r;
  if (r.missing.length) return { ok: false, error: `This Hermes server is missing ${r.missing.join(", ")}. Update Hermes (v2026.9.24 or newer).` };
  const version = r.version ? `Hermes ${r.version}` : "Hermes";
  return { ok: true, models: r.models, note: `${version} · profile ${target.profile || "default"} answered` };
}
