import { describe, expect, it } from "vitest";
import { scrubForeignOpenAIMetadata } from "@/lib/agent/replay";
import type { PortalUIMessage } from "@/lib/chat/store";

const assistant = (meta: PortalUIMessage["metadata"]): PortalUIMessage => ({
  id: "a1",
  role: "assistant",
  metadata: meta,
  parts: [
    { type: "reasoning", text: "thinking", providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "blob" } } },
    { type: "text", text: "answer", providerMetadata: { openai: { itemId: "msg_1" }, other: { keep: true } } },
  ],
});
const user: PortalUIMessage = { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] };

describe("cross-endpoint replay hygiene", () => {
  const chatgptTarget = { appId: "cg", providerKind: "chatgpt", model: "gpt-codex", replayKey: "acct-a" };

  it("keeps a ChatGPT app's own metadata when replaying to the same app, model and account", () => {
    const h = [user, assistant({ appId: "cg", providerKind: "chatgpt", model: "gpt-codex", replayKey: "acct-a" })];
    expect(scrubForeignOpenAIMetadata(h, chatgptTarget)[1]).toBe(h[1]);
  });

  it("drops reasoning sealed to another ChatGPT account (continued shared chat, reconnect with another account)", () => {
    for (const replayKey of ["acct-b", undefined]) {
      const [, scrubbed] = scrubForeignOpenAIMetadata([user, assistant({ appId: "cg", providerKind: "chatgpt", model: "gpt-codex", replayKey })], chatgptTarget);
      expect(scrubbed.parts[0]).toMatchObject({ providerMetadata: undefined });
    }
    // Without a current account key nothing is replayed.
    const own = assistant({ appId: "cg", providerKind: "chatgpt", model: "gpt-codex", replayKey: "acct-a" });
    expect(scrubForeignOpenAIMetadata([own], { ...chatgptTarget, replayKey: null })[0].parts[0]).toMatchObject({ providerMetadata: undefined });
  });

  it("drops OpenAI metadata from other apps (or models) before it reaches a ChatGPT plan", () => {
    for (const meta of [{ appId: "company-openai", providerKind: "openai", model: "gpt-codex" }, { appId: "cg", providerKind: "chatgpt", model: "older" }, {}]) {
      const [, scrubbed] = scrubForeignOpenAIMetadata([user, assistant(meta)], chatgptTarget);
      expect(scrubbed.parts[0]).toEqual({ type: "reasoning", text: "thinking", providerMetadata: undefined });
      expect(scrubbed.parts[1]).toEqual({ type: "text", text: "answer", providerMetadata: { other: { keep: true } } });
    }
  });

  it("drops ChatGPT metadata before it reaches a company endpoint, and leaves other replies alone", () => {
    const target = { appId: "company-openai", providerKind: "openai", model: "gpt-5" };
    const [, fromPlan] = scrubForeignOpenAIMetadata([user, assistant({ appId: "cg", providerKind: "chatgpt", model: "gpt-codex" })], target);
    expect(fromPlan.parts[0]).toMatchObject({ providerMetadata: undefined });
    const own = assistant({ appId: "company-openai", providerKind: "openai", model: "gpt-5" });
    expect(scrubForeignOpenAIMetadata([own], target)[0]).toBe(own);
    const legacy = assistant({});
    expect(scrubForeignOpenAIMetadata([legacy], target)[0]).toBe(legacy);
  });
});
