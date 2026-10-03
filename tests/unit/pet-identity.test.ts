import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Tooltip } from "radix-ui";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/app/(chat)/settings/workspace-actions", () => ({ stopWorkspaceCommand: async () => ({ ok: true }) }));
import { BotAvatar } from "@/components/bots/bot-avatar";
import { PetProvider } from "@/components/pets/pet-context";
import { AssistantMessage } from "@/components/chat/message";
import { DEFAULT_PET } from "@/lib/pets/shared";
import type { PortalUIMessage } from "@/lib/chat/store";

const pets = { a: { ...DEFAULT_PET, enabled: true }, b: { ...DEFAULT_PET, enabled: true, appearance: "ember" as const } };
const withPets = (children: React.ReactNode) => renderToStaticMarkup(createElement(Tooltip.Provider, null, createElement(PetProvider, { initialPets: pets }, children)));
const speaker = (botId?: string) => ({ type: "data-speaker", data: { botId, name: "Same name", avatar: "blob:circle:teal" } });
const text = { type: "text", text: "A reply." };
const message = (parts: unknown[]) => ({ id: "test", role: "assistant", parts }) as PortalUIMessage;
const reply = (parts: unknown[], isLast: boolean, streaming = false) => withPets(createElement(AssistantMessage, { message: message(parts), isLast, streaming, variant: "bubbles", onApprove: () => {}, onDeny: () => {} }));

describe("private bot identity", () => {
  it("requires a bot ID and a viewer preference; branding and app icons stay ordinary", () => {
    expect(withPets(createElement(BotAvatar, { value: "blob:circle:teal", state: "working" }))).not.toContain("data-pet-enabled");
    const noProvider = renderToStaticMarkup(createElement(BotAvatar, { botId: "a", value: "blob:circle:teal", state: "working" }));
    expect(noProvider).toContain('data-pet-enabled="false"');
    expect(noProvider).toContain("blob-working");
    expect(withPets(createElement(BotAvatar, { botId: "unknown", value: "blob:circle:teal" }))).toContain('data-pet-enabled="false"');
  });
  it("uses each group speaker ID despite identical names and global icons", () => {
    const html = reply([speaker("a"), text, speaker("b"), text], true, true);
    expect(html).toContain('data-bot-avatar="a" data-pet-enabled="true" data-activity="decorative" data-pet-appearance="moss"');
    expect(html).toContain('data-bot-avatar="b" data-pet-enabled="true" data-activity="working" data-pet-appearance="ember"');
    expect(reply([speaker(), text], true)).not.toContain("data-pet-enabled");
  });
  it("keeps historical speakers decorative and shows approval before streaming", () => {
    const parts = [speaker("a"), text, speaker("b"), { type: "tool-fetch_url", toolCallId: "call", state: "approval-requested", input: { url: "https://example.com" }, approval: { id: "approval" } }];
    expect(reply(parts, true, true)).toContain('data-bot-avatar="b" data-pet-enabled="true" data-activity="approval"');
    const historical = reply(parts, false);
    expect(historical.match(/data-activity="decorative"/g)).toHaveLength(2);
    expect(historical).not.toContain('data-activity="working"');
  });
});
