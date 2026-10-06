import { beforeEach, expect, it, vi } from "vitest";
import { buildCommandRequest } from "@/lib/chat/composer-commands";

const f = vi.hoisted(() => ({ principal: vi.fn(), execute: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/session", () => ({ requirePrincipal: f.principal, errorResponse: () => Response.json({ error: "Unexpected error" }, { status: 500 }) }));
vi.mock("@/lib/chat/hermes-command-service", () => ({ executeHermesCommand: f.execute, commandCatalog: vi.fn(), resolveCommandTarget: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: f.revalidate }));
import { POST } from "@/app/api/chat/commands/route";

const principal = { user: { id: "owner" } };
const controls = { conversationId: "existingChat1234", text: "/new", revision: 0, newConversationId: "newChat123456789", messageId: "lastMessage12345" };
const request = (body: unknown) => new Request("https://portal.test/api/chat/commands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks();
  f.principal.mockResolvedValue(principal);
  f.execute.mockResolvedValue({ title: "New chat", lines: [], navigateTo: `/c/${controls.newConversationId}` });
});

it.each([{ botId: "nativeBot1234" }, { botId: "hermesBot1234" }, { appId: "hermesApp1234" }])("accepts composer commands for %j without leaking model settings", async target => {
  const browserInput = { ...controls, ...target, nativeSearchMode: null };
  const payload = buildCommandRequest(browserInput);
  const response = await POST(request(payload));
  expect(response.status).toBe(200);
  expect(f.execute).toHaveBeenCalledWith(principal, { ...controls, ...target });
  expect(f.revalidate).toHaveBeenCalledWith("/", "layout");
  expect(await response.json()).toMatchObject({ navigateTo: `/c/${controls.newConversationId}` });
});

it.each(["/help", "/model fast", "/reset", "/stop"])("preserves command arguments and retry fields for %s", async text => {
  const browserInput = { ...controls, text, appId: "hermesApp1234", nativeSearchMode: "on" };
  expect((await POST(request(buildCommandRequest(browserInput)))).status).toBe(200);
  expect(f.execute).toHaveBeenCalledWith(principal, { ...controls, text, appId: "hermesApp1234" });
});

it("keeps server validation strict when raw clients send model settings", async () => {
  const response = await POST(request({ ...controls, nativeSearchMode: null }));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "Invalid command request" });
  expect(f.execute).not.toHaveBeenCalled();
});
