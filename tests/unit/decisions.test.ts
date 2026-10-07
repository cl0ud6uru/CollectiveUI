import { afterEach, describe, expect, it, vi } from "vitest";
import { DECISIONS_DEFAULTS, decisionsCapability, decisionsSettingsSchema } from "@/lib/decisions-policy";
import type { ProviderContext } from "@/lib/llm/providers/types";
vi.mock("server-only", () => ({}));
import { requestDecision, type DecisionQuestion } from "@/lib/llm/providers/decisions";

const questions: DecisionQuestion[] = [{ type: "choice", name: "delegate", instructions: "Pick", choices: [
  { value: "queen", description: "Fallback" }, { value: "allowed", description: "Allowed specialist" },
] }];
const data = (over: object = {}) => ({ model: "gpt-6-luna", usage: { input_tokens: 123 }, answers: [{
  type: "choice", name: "delegate", choice: "allowed", confidence: 0.95,
  probabilities: [{ value: "queen", probability: 0.05 }, { value: "allowed", probability: 0.95 }], ...over,
}] });
const provider = (fetcher: typeof fetch): ProviderContext => ({ appId: "billing-app", appName: "API", kind: "openai", baseUrl: null,
  secret: { type: "api-key", apiKey: "fixture-key" }, config: { store: false, reasoning: false, organization: "org-fixture", project: "project-fixture" }, fetch: fetcher });
afterEach(() => vi.restoreAllMocks());

describe("Decisions supported configuration and wire contract", () => {
  it("defaults off and only accepts configured company OpenAI API endpoints", () => {
    expect(DECISIONS_DEFAULTS.queenRouting).toBe(false);
    expect(DECISIONS_DEFAULTS.skillPicking).toBe(false);
    expect(DECISIONS_DEFAULTS.toolShortlisting).toBe(false);
    expect(decisionsSettingsSchema.parse({})).toEqual(DECISIONS_DEFAULTS);
    const app = { enabled: true, provider: "openai", credentialMode: "org", baseUrl: null };
    expect(decisionsCapability(app)).toBe(true);
    for (const provider of ["hermes", "chatgpt", "openai-compatible", "azure", "anthropic"])
      expect(decisionsCapability({ ...app, provider })).toBe(false);
    expect(decisionsCapability({ ...app, credentialMode: "user" })).toBe(false);
    expect(decisionsCapability({ ...app, baseUrl: "https://proxy.example/v1" })).toBe(false);
    expect(decisionsSettingsSchema.safeParse({ queenRouting: "true" }).success).toBe(false);
  });
  it("sends the documented Decisions body and existing server billing selectors once", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init).toMatchObject({ method: "POST", redirect: "error", headers: {
        Authorization: "Bearer fixture-key", "OpenAI-Organization": "org-fixture", "OpenAI-Project": "project-fixture",
      } });
      expect(JSON.parse(String(init?.body))).toEqual({ model: "gpt-6-luna", input: "fixture request", questions });
      return Response.json(data());
    });
    expect(await requestDecision(provider(fetcher), "fixture request", questions)).toMatchObject({ status: "ok", inputTokens: 123 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("https://api.openai.com/v1/decisions");
  });
  it.each([
    { name: "wrong" }, { type: "score" }, { choice: "forbidden" }, { confidence: 2 }, { confidence: null },
    { probabilities: [{ value: "allowed", probability: 0.95 }, { value: "allowed", probability: 0.05 }] },
    { probabilities: [{ value: "queen", probability: 0.01 }, { value: "allowed", probability: 0.01 }] },
    { probabilities: [] },
  ])("rejects malformed or out-of-set answers %j", async over => {
    expect((await requestDecision(provider(async () => Response.json(data(over))), "request", questions)).status).toBe("invalid");
  });
  it("returns refusal and rejects mismatched model/answer count", async () => {
    const refused = { ...data(), answers: [{ type: "refusal", name: "delegate" }] };
    expect((await requestDecision(provider(async () => Response.json(refused)), "request", questions)).status).toBe("refusal");
    for (const body of [{ ...data(), model: "gpt-6-sol" }, { ...data(), answers: [] }])
      expect((await requestDecision(provider(async () => Response.json(body)), "request", questions)).status).toBe("invalid");
  });
  it("never calls unsupported providers, missing keys, oversized or aborted input", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(data()));
    for (const override of [{ kind: "hermes" }, { baseUrl: "https://proxy.example/v1" }, { secret: undefined }])
      expect((await requestDecision({ ...provider(fetcher), ...override } as ProviderContext, "request", questions)).status).toBe("unavailable");
    expect((await requestDecision(provider(fetcher), "x".repeat(6001), questions)).status).toBe("invalid");
    await requestDecision(provider(fetcher), "request", questions, { signal: AbortSignal.abort() });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("bounds a hanging provider, makes no retry, and rejects oversized responses", async () => {
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    expect((await requestDecision(provider(fetcher), "request", questions, { timeoutMs: 5 })).status).toBe("timeout");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await requestDecision(provider(async () => new Response("x".repeat(70000))), "request", questions)).status).toBe("invalid");
  });
  it("does not read or log private provider errors", async () => {
    const log = vi.spyOn(console, "error");
    const fetcher = vi.fn<typeof fetch>(async () => new Response("fixture-key private request", { status: 429 }));
    expect((await requestDecision(provider(fetcher), "private request", questions)).status).toBe("unavailable");
    expect(fetcher).toHaveBeenCalledTimes(1); expect(log).not.toHaveBeenCalled();
  });
});
