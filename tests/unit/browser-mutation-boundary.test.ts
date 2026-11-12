import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/http-error";

const f = vi.hoisted(() => ({ mutate: vi.fn(), binding: vi.fn(), principal: vi.fn(), auth: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/authz", () => ({ HttpError }));
vi.mock("@/lib/session", () => ({ requirePrincipal: f.principal, requireAdmin: f.principal,
  errorResponse: (error: unknown) => Response.json({ error: "Rejected" }, { status: error instanceof HttpError ? error.status : 500 }) }));
vi.mock("@/auth", () => ({ auth: f.auth }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/auth/mobile", () => ({ mobileEnabled: () => true, MobileAuthError: class extends Error {},
  parseAuthorizeRequest: () => ({ codeChallenge: "challenge", state: "state", deviceName: "fixture" }),
  issueAuthCode: f.mutate, callbackUrl: () => "collectiveui://auth/callback" }));
vi.mock("@/lib/delegation/approvals", () => ({ answerTaskApproval: f.mutate, pendingTaskApprovals: vi.fn() }));
vi.mock("@/lib/delegation/read", () => ({ markTaskRead: f.mutate }));
vi.mock("@/personal-codex/approvals", () => ({ decideApproval: f.mutate }));
vi.mock("@/lib/docker-hermes/store", () => ({ personalProfileBinding: f.binding, dockerStatus: vi.fn(),
  withDockerAccess: async (p: unknown, _create: boolean, work: (p: unknown, tx: object) => unknown) => work(p, {}) }));
vi.mock("@/lib/docker-hermes/client", () => ({ dockerControl: f.mutate }));
vi.mock("@/lib/docker-hermes/policy", () => ({ assertDockerCreate: vi.fn() }));
vi.mock("@/lib/settings", () => ({ getSetting: vi.fn() }));
vi.mock("@/lib/docker-hermes/network", () => ({ getDockerNetworks: vi.fn(), requestDockerNetwork: f.mutate }));
vi.mock("@/lib/mcp/apps", () => ({ callMcpAppTool: f.mutate, decideMcpAppAction: f.mutate, listMcpAppActions: vi.fn(), loadMcpApp: vi.fn() }));

import { POST as approve } from "@/app/api/chat/[id]/approvals/route";
import { POST as read } from "@/app/api/chat/[id]/read/route";
import { POST as codexApproval } from "@/app/api/me/codex/approvals/[id]/route";
import { POST as settings } from "@/app/api/bots/[id]/native/settings/route";
import { POST as codex } from "@/app/api/bots/[id]/native/codex/route";
import { POST as network } from "@/app/api/admin/hermes/network/route";
import { POST as mcp } from "@/app/api/mcp-apps/[id]/route";
import { POST as authorize } from "@/app/api/mobile/auth/authorize/route";
import { readTeamRequest } from "@/lib/hermes-team/request";

const portal = "https://portal.example.test";
const context = { params: Promise.resolve({ id: "fixture-id" }) };
const revision = "a".repeat(64);
const routes = [
  { name: "chat approval", handler: (req: Request) => approve(req, context), body: { runId: "run", approvalId: "approval", approved: true }, status: 200 },
  { name: "chat read", handler: (req: Request) => read(req, context), body: { runId: "run", status: "succeeded", lastSeq: 1 }, status: 204 },
  { name: "native settings", handler: (req: Request) => settings(req, context), body: { operation: "network", network: { revision } }, status: 200 },
  { name: "native Codex", handler: (req: Request) => codex(req, context), body: { action: "disconnect", revision }, status: 200 },
  { name: "admin network", handler: network, body: { owner: "owner", request: { mode: "none", revision: 0, requestId: "a4c0315e-3a2c-4af8-bf04-7094939c3033", confirmRestart: true } }, status: 202 },
  { name: "MCP app", handler: (req: Request) => mcp(req, context), body: { operation: "decide", id: "approval12345678", approve: false }, status: 200 },
];
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("AUTH_URL", portal);
  f.principal.mockResolvedValue({ user: { id: "owner", sessionVersion: 1 } });
  f.auth.mockResolvedValue({ user: { id: "owner", sessionVersion: 1, sessionId: "session", authProvider: "local" } });
  f.binding.mockResolvedValue({ bindingId: "binding" }); f.mutate.mockResolvedValue({ ok: true });
});
afterEach(() => vi.unstubAllEnvs());
const request = (body: unknown, origin = portal, type = "application/json") => new Request(`${portal}/api/test`, {
  method: "POST", headers: { origin, "content-type": type }, body: JSON.stringify(body),
});

describe.each(routes)("$name browser mutation boundary", route => {
  it.each(["", "null", "https://sibling.example.test", `${portal}/path`])("rejects Origin %j without consuming or mutating", async origin => {
    const req = request(route.body, origin); if (!origin) req.headers.delete("origin");
    expect((await route.handler(req)).status).toBe(403);
    expect(req.bodyUsed).toBe(false); expect(f.binding).not.toHaveBeenCalled(); expect(f.mutate).not.toHaveBeenCalled();
  });
  it.each([undefined, "invalid URL", "data:text/html,test"])("fails closed for AUTH_URL %j", async configured => {
    vi.stubEnv("AUTH_URL", configured); const req = request(route.body);
    expect((await route.handler(req)).status).toBe(403);
    expect(req.bodyUsed).toBe(false); expect(f.mutate).not.toHaveBeenCalled();
  });
  it.each(["text/plain", "application/jsonp", "application/json, text/plain"])("rejects media type %j before body parsing or mutation", async type => {
    const req = request(route.body, portal, type);
    expect((await route.handler(req)).status).toBe(415);
    expect(req.bodyUsed).toBe(false); expect(f.mutate).not.toHaveBeenCalled();
  });
  it("preserves a same-origin JSON mutation", async () => {
    expect((await route.handler(request(route.body, portal, "Application/JSON; charset=utf-8"))).status).toBe(route.status);
    expect(f.mutate).toHaveBeenCalled();
  });
});

it.each([undefined, "bad URL", "file:///tmp/portal"])("blocks bodyless Codex approval with invalid public URL %j", async configured => {
  vi.stubEnv("AUTH_URL", configured);
  const req = new Request(`${portal}/api/me/codex/approvals/id`, { method: "POST", headers: { origin: portal, "x-codex-decision": "decline" } });
  expect((await codexApproval(req, context)).status).toBe(403); expect(f.mutate).not.toHaveBeenCalled();
});
it("preserves the bodyless same-origin Codex decision", async () => {
  const req = new Request(portal, { method: "POST", headers: { origin: portal, "x-codex-decision": "decline" } });
  expect((await codexApproval(req, context)).status).toBe(200); expect(f.mutate).toHaveBeenCalled();
});
it.each([undefined, "bad URL", "data:text/html,test"])("blocks mobile consent with invalid public URL %j before issuing a code", async configured => {
  vi.stubEnv("AUTH_URL", configured);
  const form = new FormData(); form.set("decision", "approve");
  const req = new Request(portal, { method: "POST", headers: { origin: portal }, body: form });
  expect((await authorize(req)).status).toBe(403); expect(req.bodyUsed).toBe(false); expect(f.mutate).not.toHaveBeenCalled();
});
it("preserves same-origin mobile consent forms", async () => {
  const form = new FormData(); form.set("decision", "approve");
  const req = new Request(portal, { method: "POST", headers: { origin: portal }, body: form });
  expect((await authorize(req)).status).toBe(303); expect(f.mutate).toHaveBeenCalled();
});
it.each(["application/jsonp", "text/plain", "application/json, text/plain"])("rejects a Team payload with media type %j", async type => {
  const req = request({ operation: "save" }, portal, type);
  await expect(readTeamRequest(req)).rejects.toMatchObject({ status: 415 }); expect(req.bodyUsed).toBe(false);
});
