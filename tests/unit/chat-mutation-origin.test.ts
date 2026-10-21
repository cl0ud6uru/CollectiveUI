import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/http-error";

const f = vi.hoisted(() => ({
  principal: vi.fn(), execute: vi.fn(), start: vi.fn(), continue: vi.fn(), stop: vi.fn(), stopFor: vi.fn(),
  select: vi.fn(), insert: vi.fn(), update: vi.fn(), transaction: vi.fn(), put: vi.fn(), extract: vi.fn(),
  target: vi.fn(), rows: vi.fn(), tail: vi.fn(), lock: vi.fn(), active: vi.fn(), revalidate: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/session", () => ({ requirePrincipal: f.principal, errorResponse: (error: unknown) =>
  Response.json({ error: error instanceof Error ? error.message : "Unexpected error" }, { status: error instanceof HttpError ? error.status : 500 }) }));
vi.mock("@/db", () => ({ db: { select: f.select, insert: f.insert, update: f.update, transaction: f.transaction } }));
vi.mock("next/cache", () => ({ revalidatePath: f.revalidate }));
vi.mock("@/lib/chat/hermes-command-service", () => ({ executeHermesCommand: f.execute, commandCatalog: vi.fn(), resolveCommandTarget: vi.fn() }));
vi.mock("@/lib/runs/store", () => ({ startRun: f.start, continueRun: f.continue, stopRuns: f.stop, stopRunFor: f.stopFor, waitForRunEnd: vi.fn() }));
vi.mock("@/lib/runs/state", () => ({ activeRunOf: f.active, runOfMessage: vi.fn(), RunBusyError: class extends Error {} }));
vi.mock("@/lib/runs/tail", () => ({ tailRun: f.tail }));
vi.mock("@/lib/runs/sse", () => ({ sseResponse: () => Response.json({ accepted: true }) }));
vi.mock("@/lib/runs/lock", () => ({ lockUserRuns: f.lock }));
vi.mock("@/lib/agent/target", () => ({ resolveTurnTarget: f.target }));
vi.mock("@/lib/agent/group", () => ({ loadGroupMembers: vi.fn(), runGroupTurn: vi.fn() }));
vi.mock("@/lib/agent/native-search", () => ({ nativeSearchSelection: vi.fn() }));
vi.mock("@/lib/docker-hermes/policy", () => ({ isDockerHermes: () => false }));
vi.mock("@/lib/docker-hermes/store", () => ({ authorizeDockerStream: vi.fn() }));
vi.mock("@/lib/chat/reply-server", () => ({ resolveReplyReference: vi.fn(), resolveStoredReplyReference: vi.fn() }));
vi.mock("@/lib/chat/store", () => ({ loadMessageRows: f.rows, insertMessage: vi.fn(), pathTo: vi.fn(), rowToUIMessage: vi.fn(), setCurrentLeaf: vi.fn() }));
vi.mock("@/lib/files/storage", () => ({ storage: () => ({ put: f.put }) }));
vi.mock("@/lib/files/extract", () => ({ extractText: f.extract, isImage: () => false }));
vi.mock("@/lib/settings", () => ({ getSetting: async () => ({ uploadMaxMb: 20, maxAttachmentsPerMessage: 5 }) }));

import { POST as chat } from "@/app/api/chat/route";
import { POST as commands } from "@/app/api/chat/commands/route";
import { POST as stop } from "@/app/api/chat/[id]/stop/route";
import { PATCH as search } from "@/app/api/chat/native-search/route";
import { POST as files } from "@/app/api/files/route";

const portal = "https://portal.example.test";
const conversationId = "chatOrigin12345";
const principal = { user: { id: "owner" } };
const conv = { id: conversationId, userId: "owner", appId: "model", botId: null, source: "chat", isGroup: false };
const routes = [
  { name: "chat", method: "POST", path: "/api/chat", handler: chat, body: { conversationId, message: { id: "messageOrigin123", role: "user", parts: [{ type: "text", text: "Synthetic prompt" }] } } },
  { name: "commands", method: "POST", path: "/api/chat/commands", handler: commands, body: { conversationId, botId: "hermesBot12345", text: "/yolo on" } },
  { name: "stop", method: "POST", path: `/api/chat/${conversationId}/stop`, handler: (req: Request) => stop(req, { params: Promise.resolve({ id: conversationId }) }), body: {} },
  { name: "native search", method: "PATCH", path: "/api/chat/native-search", handler: search, body: { conversationId, mode: "off" } },
  { name: "files", method: "POST", path: "/api/files", handler: files, body: null },
];
function request(route: typeof routes[number], extra: Record<string, string> = {}, jsonType = "application/json") {
  const headers = new Headers({ origin: portal, ...extra });
  let body: BodyInit;
  if (route.name === "files") {
    const form = new FormData(); form.set("file", new File(["Synthetic file"], "fixture.txt", { type: "text/plain" })); body = form;
  } else { headers.set("content-type", jsonType); body = JSON.stringify(route.body); }
  return new Request(portal + route.path, { method: route.method, headers, body });
}
function untouched() {
  for (const fn of [f.execute, f.start, f.continue, f.stop, f.stopFor, f.select, f.insert, f.update, f.transaction, f.put, f.extract])
    expect(fn).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("AUTH_URL", portal);
  f.principal.mockResolvedValue(principal);
  f.execute.mockResolvedValue({ title: "Synthetic control", lines: [] });
  f.start.mockResolvedValue({ id: "run", segment: 0 }); f.stop.mockResolvedValue({ cancelled: 1, signalled: 0 });
  f.target.mockResolvedValue({ bot: null, app: { id: "model", provider: "openai-compatible" } }); f.rows.mockResolvedValue([]);
  f.extract.mockResolvedValue("Synthetic file"); f.active.mockResolvedValue(null);
  const query = { from: () => query, where: () => query, for: () => query, limit: () => query,
    then: (resolve: (value: unknown[]) => unknown) => Promise.resolve([conv]).then(resolve) };
  f.select.mockReturnValue(query);
  f.insert.mockReturnValue({ values: vi.fn(async () => {}) });
  f.update.mockReturnValue({ set: () => ({ where: vi.fn(async () => {}) }) });
  f.transaction.mockImplementation(async (work: (tx: object) => Promise<void>) => work({ select: f.select, update: f.update }));
});
afterEach(() => { vi.unstubAllEnvs(); });

describe.each(routes)("$name mutation origin and body boundary", route => {
  it.each(["https://sibling.example.test", "https://elsewhere.test", "null", ""])("rejects cookie requests from origin %j before parsing or acting", async origin => {
    const req = request(route, { origin }); if (!origin) req.headers.delete("origin");
    const response = await route.handler(req);
    expect(response.status).toBe(403); expect(req.bodyUsed).toBe(false); untouched();
  });
  it("fails closed when the configured public origin is missing", async () => {
    vi.stubEnv("AUTH_URL", undefined);
    const req = request(route);
    expect((await route.handler(req)).status).toBe(403); expect(req.bodyUsed).toBe(false); untouched();
  });
  it("accepts the configured same-origin browser request", async () => {
    expect((await route.handler(request(route))).status).toBe(200);
  });
  it("preserves authenticated native requests without an Origin header", async () => {
    const req = request(route, { authorization: "Bearer cui_m_synthetic" }); req.headers.delete("origin");
    expect((await route.handler(req)).status).toBe(200);
  });
  it("does not let a rejected bearer token fall back to a cookie mutation", async () => {
    f.principal.mockRejectedValue(new HttpError(401, "Unauthorized"));
    const response = await route.handler(request(route, { authorization: "Bearer invalid", cookie: "synthetic-session=present" }));
    expect(response.status).toBe(401); untouched();
  });
});

describe.each(routes.filter(route => route.name !== "files"))("$name JSON media type", route => {
  it.each(["text/plain", "application/x-www-form-urlencoded", "application/jsonp", ""])("rejects %j before parsing or acting", async type => {
    const req = request(route, {}, type); if (!type) req.headers.delete("content-type");
    expect((await route.handler(req)).status).toBe(415); expect(req.bodyUsed).toBe(false); untouched();
  });
  it("accepts JSON media type parameters", async () => {
    expect((await route.handler(request(route, {}, "application/json; charset=utf-8"))).status).toBe(200);
  });
});

it("rejects a non-multipart upload before reading or storing it", async () => {
  const route = routes.find(route => route.name === "files")!;
  const req = request(route); req.headers.set("content-type", "application/json");
  expect((await files(req)).status).toBe(415); expect(req.bodyUsed).toBe(false); untouched();
});
it("rejects the two-step sibling-origin yolo/prompt attack without changing controls or starting a durable run", async () => {
  const responses: Response[] = [];
  for (const route of routes.slice(0, 2).reverse()) {
    const req = request(route, { origin: "https://sibling.example.test" }, "text/plain");
    responses.push(await route.handler(req));
  }
  expect(responses.map(response => response.status)).toEqual([403, 403]);
  untouched();
});
