import { beforeEach, expect, it, vi } from "vitest";
import { POST as openChat } from "@/app/api/mobile/v1/bots/[id]/chat/route";
import { POST as markRead } from "@/app/api/mobile/v1/inbox/read/route";
import { markInboxRead } from "@/app/(chat)/actions";
import { openBotHome } from "@/lib/chat/home";
import { openSideChat } from "@/lib/chat/side";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/session", () => ({ requirePrincipal: async () => ({}), errorResponse: vi.fn() }));
vi.mock("@/app/(chat)/actions", () => ({ markInboxRead: vi.fn() }));
vi.mock("@/lib/chat/home", () => ({ openBotHome: vi.fn(async () => ({ id: "home" })) }));
vi.mock("@/lib/chat/side", () => ({ openSideChat: vi.fn(async () => ({ id: "side" })) }));

const request = (body: string) => new Request("http://localhost", { method: "POST", body });
const bot = { params: Promise.resolve({ id: "research" }) };
beforeEach(() => { vi.clearAllMocks(); });

it.each(['{"id":', '{"itemId":"one"}', ""])("rejects an ambiguous inbox payload (%s) without changing read state", async body => {
  expect((await markRead(request(body))).status).toBe(400);
  expect(markInboxRead).not.toHaveBeenCalled();
});

it("marks one item for an id and all items for an explicit empty object", async () => {
  expect((await markRead(request('{"id":"one"}'))).status).toBe(204);
  expect(markInboxRead).toHaveBeenNthCalledWith(1, "one");
  expect((await markRead(request("{}"))).status).toBe(204);
  expect(markInboxRead).toHaveBeenNthCalledWith(2, undefined);
});

it.each(['{"kind":', '{"type":"side"}'])("rejects an invalid chat request (%s) without opening a conversation", async body => {
  expect((await openChat(request(body), bot)).status).toBe(400);
  expect(openBotHome).not.toHaveBeenCalled();
  expect(openSideChat).not.toHaveBeenCalled();
});

it("keeps home as the default kind and routes side chats explicitly", async () => {
  expect(await (await openChat(request("{}"), bot)).json()).toEqual({ conversationId: "home" });
  expect(await (await openChat(request('{"kind":"side"}'), bot)).json()).toEqual({ conversationId: "side" });
});
