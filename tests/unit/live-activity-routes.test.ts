import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ auth: vi.fn(), config: vi.fn(), register: vi.fn(), remove: vi.fn(), run: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireMobileSession: mock.auth,
  errorResponse: (e: { status?: number }) => Response.json({ error: "Unavailable" }, { status: e.status ?? 500 }) }));
vi.mock("@/lib/live-activities/apns", () => ({ apnsConfig: mock.config }));
vi.mock("@/lib/live-activities/store", () => ({ registerActivity: mock.register, removeActivities: mock.remove, runForActivity: mock.run,
  registrationError: (e: unknown) => { throw e; } }));
import { POST, DELETE } from "@/app/api/mobile/v1/live-activities/route";
import { GET } from "@/app/api/mobile/v1/conversations/[id]/activity/route";
const input = { activityId: "activity", runId: "run", pushToken: "ab".repeat(32), tokenVersion: 1 };
const req = (body: unknown) => new Request("https://test.invalid/api/mobile/v1/live-activities", { method: "POST", body: JSON.stringify(body) });
const principal = { user: { id: "owner" } }; const session = { id: "device", userId: "owner" };
beforeEach(() => { vi.resetAllMocks(); mock.auth.mockResolvedValue({ principal, session }); mock.config.mockReturnValue({}); });
it("requires a mobile session for registration, removal and status", async () => {
  mock.auth.mockRejectedValue(Object.assign(new Error("Unauthorized"), { status: 401 }));
  expect((await POST(req(input))).status).toBe(401);
  expect((await DELETE(req({}))).status).toBe(401);
  expect((await GET(req({}), { params: Promise.resolve({ id: "chat" }) })).status).toBe(401);
  expect(mock.register).not.toHaveBeenCalled(); expect(mock.remove).not.toHaveBeenCalled(); expect(mock.run).not.toHaveBeenCalled();
});
it("binds mutations to the authenticated owner/session, with no client owner/device override", async () => {
  mock.register.mockResolvedValue({ ended: false });
  expect((await POST(req(input))).status).toBe(200);
  expect(mock.register).toHaveBeenCalledWith(principal, session, input);
  expect((await POST(req({ ...input, userId: "other" }))).status).toBe(400);
  expect((await DELETE(req({ activityId: "activity" }))).status).toBe(204);
  expect(mock.remove).toHaveBeenCalledWith("owner", "device", "activity");
});
it("bounds/validates input and never logs or echoes secret-bearing errors", async () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  for (const body of [{ ...input, pushToken: "bad" }, { ...input, pushToken: "a".repeat(3000) }, { ...input, tokenVersion: -1 }]) {
    const response = await POST(req(body)); expect(response.status).toBe(400); expect(await response.text()).not.toContain("pushToken");
  }
  mock.register.mockRejectedValue(new Error(input.pushToken));
  const response = await POST(req(input)); expect(response.status).toBe(503); expect(await response.text()).not.toContain(input.pushToken);
  expect(spy).not.toHaveBeenCalled(); spy.mockRestore();
});
it("keeps foreground status available when APNs is disabled", async () => {
  mock.config.mockReturnValue(null);
  expect((await POST(req(input))).status).toBe(503);
  mock.run.mockResolvedValue({ id: "run", conversationId: "chat", botId: "bot", status: "running", cancelRequestedAt: null,
    updatedAt: new Date(100_000), lastSeq: 4, title: "SECRET", error: "SECRET" });
  const response = await GET(new Request("https://test.invalid/chat/activity?runId=run"), { params: Promise.resolve({ id: "chat" }) });
  expect(mock.run).toHaveBeenCalledWith(principal, "chat", "run");
  expect(await response.json()).toEqual({ runId: "run", conversationId: "chat", botId: "bot", content: { phase: "working", updatedAt: 100, revision: 4 }, backgroundUpdates: false });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
it("rejects oversized streamed bodies before buffering all chunks, and malformed UTF-8", async () => {
  const cancel = vi.fn();
  let chunk = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1500)); chunk++; }, cancel });
  const request = new Request("https://test.invalid/activities", { method: "POST", body: stream, duplex: "half" } as RequestInit);
  expect((await POST(request)).status).toBe(400);
  expect(cancel).toHaveBeenCalledOnce(); expect(chunk).toBeLessThanOrEqual(3);
  expect(mock.register).not.toHaveBeenCalled();
  expect((await POST(new Request("https://test.invalid/activities", { method: "POST", body: new Uint8Array([0xff]) }))).status).toBe(400);
});
