import { beforeEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ principal: vi.fn(), target: vi.fn(), setting: vi.fn() }));
vi.mock("@/lib/session", () => ({ requirePagePrincipal: deps.principal }));
vi.mock("@/lib/voice/target", () => ({ targetFor: deps.target }));
vi.mock("@/lib/settings", () => ({ getSetting: deps.setting }));
vi.mock("@/components/chat/voice-reaction-studio", () => ({ VoiceReactionStudio: "studio-fixture" }));
import Page from "@/app/voice/reaction-studio/page";
beforeEach(() => {
  vi.clearAllMocks(); deps.principal.mockResolvedValue({ user: { id: "owner" } });
  deps.target.mockResolvedValue({ app: { apiKey: "PRIVATE_KEY" }, history: "PRIVATE_HISTORY" });
  deps.setting.mockResolvedValue({ avatarUrl: "/api/voice/avatar", reactions: true, secret: "PRIVATE_KEY" });
});
it("requires authentication before resolving settings or chat ownership", async () => {
  deps.principal.mockRejectedValueOnce(new Error("Sign in"));
  await expect(Page({ searchParams: Promise.resolve({ conversationId: "chat00000001" }) })).rejects.toThrow("Sign in");
  expect(deps.target).not.toHaveBeenCalled(); expect(deps.setting).not.toHaveBeenCalled();
});
it("checks existing chat ownership and passes only safe display props", async () => {
  const page = await Page({ searchParams: Promise.resolve({ conversationId: "chat00000001" }) });
  expect(deps.target).toHaveBeenCalledWith({ user: { id: "owner" } }, { conversationId: "chat00000001" });
  expect(page.props).toMatchObject({ conversationId: "chat00000001", initialModelUrl: "/api/voice/avatar" });
  expect(JSON.stringify(page.props)).not.toMatch(/PRIVATE_/);
});
it("refuses unauthorized chats before reading settings", async () => {
  deps.target.mockRejectedValueOnce(new Error("Conversation not found"));
  await expect(Page({ searchParams: Promise.resolve({ conversationId: "chat00000001" }) })).rejects.toThrow("Conversation not found");
  expect(deps.setting).not.toHaveBeenCalled();
});
it("uses manual mode for missing or malformed conversation ids", async () => {
  const page = await Page({ searchParams: Promise.resolve({ conversationId: "../private" }) });
  expect(page.props.conversationId).toBeUndefined(); expect(deps.target).not.toHaveBeenCalled();
});
