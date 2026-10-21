import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const fixture = vi.hoisted(() => ({ allowed: true }));
vi.mock("@/lib/session", () => ({ requireAdmin: async () => { if (!fixture.allowed) throw new Error("Admin only"); } }));
import { listOpenRouterModels } from "@/app/admin/model-catalog-actions";
import { readOpenRouterCatalog } from "@/lib/llm/model-catalog";
import { normalizeBaseUrl, OPENROUTER_BASE_URL } from "@/lib/llm/catalog";

const model = (id: string, name: string, output = ["text"]) => ({ id, name, architecture: { input_modalities: ["text", "image"], output_modalities: output }, supported_parameters: ["tools"] });
beforeEach(() => { fixture.allowed = true; vi.restoreAllMocks(); });

describe("OpenRouter catalog", () => {
  it("reads only the fixed public endpoint without credentials and returns names, IDs and chat capabilities", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ data: [model("vendor/z", "Zebra"), model("vendor/a", "Alpha"), model("vendor/image", "Image", ["image"]), { id: 14 }, model("vendor/a", "Alpha")] }));
    expect(await readOpenRouterCatalog(fetcher)).toEqual({ ok: true, models: [
      { id: "vendor/a", name: "Alpha", supportsTools: true, supportsVision: true },
      { id: "vendor/z", name: "Zebra", supportsTools: true, supportsVision: true },
    ] });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`${OPENROUTER_BASE_URL}/models`, expect.objectContaining({ headers: { Accept: "application/json" }, redirect: "error", next: { revalidate: 300 } }));
  });
  it.each(["network", "status", "malformed"])("provides safe manual-fallback guidance after %s failure", async failure => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      if (failure === "network") throw new Error("Sensitive upstream detail");
      return Response.json(failure === "malformed" ? { data: null } : {}, { status: failure === "status" ? 503 : 200 });
    });
    expect(await readOpenRouterCatalog(fetcher)).toEqual({ ok: false, error: expect.stringContaining("enter a model ID manually") });
  });
  it("accepts an empty catalog and authorizes before any catalog request", async () => {
    expect(await readOpenRouterCatalog(async () => Response.json({ data: [] }))).toEqual({ ok: true, models: [] });
    fixture.allowed = false;
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No external network"));
    await expect(listOpenRouterModels()).rejects.toThrow("Admin only");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("defaults to the API base, rejects operation paths and wrong OpenAI protocol, and retains generic custom endpoints", () => {
    for (const input of [null, "", `${OPENROUTER_BASE_URL}/`]) expect(normalizeBaseUrl("openrouter", input)).toEqual({ ok: true, value: OPENROUTER_BASE_URL });
    for (const input of [`${OPENROUTER_BASE_URL}/chat/completions`, `${OPENROUTER_BASE_URL}/models`, "https://other.example/v1", "http://openrouter.ai/api/v1", `${OPENROUTER_BASE_URL}?key=unused`]) expect(normalizeBaseUrl("openrouter", input)).toMatchObject({ ok: false });
    expect(normalizeBaseUrl("openai", OPENROUTER_BASE_URL)).toMatchObject({ ok: false, error: expect.stringContaining("Select OpenRouter") });
    expect(normalizeBaseUrl("openai-compatible", "https://custom.example/tenant/api")).toEqual({ ok: true, value: "https://custom.example/tenant/api" });
  });
});
