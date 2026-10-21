import "server-only";
import { z } from "zod";
import { OPENROUTER_BASE_URL, type CatalogModel, type ModelCatalogResult } from "./catalog";

const Model = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(300),
  architecture: z.object({ input_modalities: z.array(z.string()), output_modalities: z.array(z.string()) }),
  supported_parameters: z.array(z.string()).default([]),
});

/** Fixed public destination, no credential reads, and no inference. Only chat-capable models reach the picker. */
export async function readOpenRouterCatalog(fetcher: typeof fetch = fetch): Promise<ModelCatalogResult> {
  try {
    const response = await fetcher(`${OPENROUTER_BASE_URL}/models`, {
      headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000),
      next: { revalidate: 300 },
    });
    if (!response.ok) throw new Error("Catalog unavailable");
    const body = z.object({ data: z.array(z.unknown()).max(10_000) }).parse(await response.json());
    const models = new Map<string, CatalogModel>();
    for (const raw of body.data) {
      const parsed = Model.safeParse(raw);
      if (!parsed.success) continue;
      const m = parsed.data;
      if (!m.architecture.input_modalities.includes("text") || !m.architecture.output_modalities.includes("text")) continue;
      models.set(m.id, { id: m.id, name: m.name, supportsTools: m.supported_parameters.includes("tools"), supportsVision: m.architecture.input_modalities.includes("image") });
    }
    return { ok: true, models: [...models.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) };
  } catch {
    return { ok: false, error: "OpenRouter’s model catalog is unavailable. Retry, or enter a model ID manually." };
  }
}
