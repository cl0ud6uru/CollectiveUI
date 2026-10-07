// Used by the native Node worker as well as web server code; never import into a client component.
import { z } from "zod";
import { DECISIONS_BASE, DECISIONS_MODEL } from "@/lib/decisions-policy";
import type { ProviderContext } from "./types";

export type DecisionQuestion = { type: "predicate"; name: string; instructions: string } |
  { type: "choice"; name: string; instructions: string; choices: { value: string; description: string }[] };
const probability = z.number().finite().min(0).max(1);
const answer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("predicate"), name: z.string(), probability }),
  z.object({ type: z.literal("choice"), name: z.string(), choice: z.string(), confidence: probability,
    probabilities: z.array(z.object({ value: z.string(), probability })) }),
  z.object({ type: z.literal("refusal"), name: z.string().nullable() }),
]);
const response = z.object({ model: z.literal(DECISIONS_MODEL), answers: z.array(answer),
  usage: z.object({ input_tokens: z.number().int().nonnegative() }).optional() });
export type DecisionResult = { status: "ok"; answers: z.infer<typeof answer>[]; inputTokens: number | null } |
  { status: "unavailable" | "timeout" | "invalid" | "refusal"; inputTokens?: number | null };

/** Direct Decisions wire contract; never uses Responses/tool execution or environment credentials. */
export async function requestDecision(ctx: ProviderContext, input: string, questions: DecisionQuestion[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<DecisionResult> {
  if (ctx.kind !== "openai" || ctx.secret?.type !== "api-key" || !ctx.secret.apiKey ||
      (ctx.baseUrl && ctx.baseUrl.replace(/\/$/, "") !== DECISIONS_BASE)) return { status: "unavailable" };
  if (!input.trim() || input.length > 6000 || !questions.length || questions.length > 32) return { status: "invalid" };
  const config = ctx.config as { organization?: string; project?: string };
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DecisionResult>(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve({ status: "timeout" }); }, Math.min(1500, Math.max(1, options.timeoutMs ?? 1200)));
  });
  try {
    return await Promise.race([timeout, (async (): Promise<DecisionResult> => {
      signal.throwIfAborted();
      const res = await (ctx.fetch ?? globalThis.fetch)(`${DECISIONS_BASE}/decisions`, {
        method: "POST", redirect: "error", signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.secret!.type === "api-key" ? ctx.secret!.apiKey : ""}`,
          ...(config.organization ? { "OpenAI-Organization": config.organization } : {}),
          ...(config.project ? { "OpenAI-Project": config.project } : {}) },
        body: JSON.stringify({ model: DECISIONS_MODEL, input, questions }),
      });
      // Error bodies can echo private input. Do not read or log them.
      if (!res.ok) { await res.body?.cancel(); return { status: "unavailable" }; }
      const reader = res.body?.getReader();
      if (!reader) return { status: "invalid" };
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 65536) { await reader.cancel(); return { status: "invalid" }; }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      const parsed = response.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!parsed.success) return { status: "invalid" };
      const data = parsed.data; const inputTokens = data.usage?.input_tokens ?? null;
      if (data.answers.length !== questions.length) return { status: "invalid", inputTokens };
      if (data.answers.some(a => a.type === "refusal")) return { status: "refusal", inputTokens };
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i]; const a = data.answers[i];
        if (a.name !== q.name || a.type !== q.type) return { status: "invalid", inputTokens };
        if (q.type === "choice" && a.type === "choice") {
          const values = q.choices.map(c => c.value);
          if (!values.includes(a.choice) || a.probabilities.length !== values.length ||
              new Set(a.probabilities.map(p => p.value)).size !== values.length ||
              a.probabilities.some(p => !values.includes(p.value)) ||
              Math.abs(a.probabilities.reduce((n, p) => n + p.probability, 0) - 1) > 0.02)
            return { status: "invalid", inputTokens };
        }
      }
      return { status: "ok", answers: data.answers, inputTokens };
    })().catch((): DecisionResult => ({ status: controller.signal.aborted ? "timeout" : "unavailable" }))]);
  } finally { clearTimeout(timer); }
}
