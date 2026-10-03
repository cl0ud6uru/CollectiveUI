import type { PortalUIMessage } from "@/lib/chat/store";

const META_KEYS = ["providerMetadata", "callProviderMetadata", "resultProviderMetadata"] as const;

/** The part without its "openai" provider metadata (item ids, encrypted reasoning); other providers' metadata stays. */
export function withoutOpenAIMetadata<P extends object>(part: P): P {
  let out: P | undefined;
  for (const key of META_KEYS) {
    const meta = (part as Record<string, unknown>)[key] as Record<string, unknown> | undefined;
    if (!meta || !("openai" in meta)) continue;
    const { openai: _drop, ...rest } = meta;
    void _drop;
    out = { ...(out ?? part), [key]: Object.keys(rest).length ? rest : undefined };
  }
  return out ?? part;
}

/**
 * Cross-endpoint replay hygiene for the model-bound copy of the history (the stored messages are untouched).
 *
 * The company OpenAI API and ChatGPT plans both file response metadata under "openai": item ids and encrypted
 * reasoning, which is sealed to the account, endpoint and model that produced it (replaying it elsewhere is
 * rejected). So the other side's OpenAI metadata is dropped: for a ChatGPT target, everything not produced by this
 * same app, model and ChatGPT account (replayKey: a continued shared chat or a reconnect with another account must
 * not replay someone else's reasoning); for any other target, everything a ChatGPT app produced. Reasoning without
 * its encrypted blob is then simply not replayed.
 */
export function scrubForeignOpenAIMetadata(
  history: PortalUIMessage[],
  target: { appId: string; providerKind: string; model: string; replayKey?: string | null },
): PortalUIMessage[] {
  return history.map((m) => {
    if (m.role !== "assistant") return m;
    const meta = m.metadata ?? {};
    const foreign =
      target.providerKind === "chatgpt"
        ? meta.appId !== target.appId || meta.model !== target.model || !target.replayKey || meta.replayKey !== target.replayKey
        : meta.providerKind === "chatgpt";
    if (!foreign) return m;
    const parts = m.parts.map((p) => withoutOpenAIMetadata(p));
    return parts.some((p, i) => p !== m.parts[i]) ? { ...m, parts } : m;
  });
}
