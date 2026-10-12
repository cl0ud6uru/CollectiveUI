/** Joint proof against W5 PR #181, exact 0b5ff7b56b445962a91d4674ab919b28eb614638.
 * Run in a worktree containing W4 + that W5 head. Actual Chromium; synthetic auth/pages only.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFile } from "node:fs/promises";
import { encode } from "next-auth/jwt";
import type { DbOrTx } from "@/db";
import { commitServerLogout } from "@/lib/auth/web-logout";
import { chromium, type Browser } from "playwright-core";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { BrowserRuntime } from "@/agent-browserd/runtime";
import { createBrowserServer } from "@/agent-browserd/server";
import { PrivateBrowserProvider } from "@/lib/agent-browser/provider";
import { installBrowserSessionSourceResolver } from "@/lib/agent-browser/viewer-source-adapter";
import { agentBrowserTools } from "@/lib/agent/tools/agent-browser";
import type { AgentCtx } from "@/lib/agent/types";
import type { BrowserScope } from "@/lib/agent-browser/provider-contract";

const f = vi.hoisted(() => ({ principal: vi.fn(), auth: vi.fn(), fresh: vi.fn(), conversation: vi.fn(), target: vi.fn(), active: vi.fn(), run: vi.fn(), registry: vi.fn(), settings: vi.fn(), bot: vi.fn(), workspace: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: f.auth }));
vi.mock("@/db", () => ({ db: { select: () => ({ from: () => ({ where: async () => [{ toolKey: "agent_browser" }] }) }) } }));
vi.mock("@/lib/session", () => ({ requirePrincipal: f.principal, errorResponse: (e: { status?: number }) => Response.json({}, { status: e.status ?? 500 }) }));
vi.mock("@/lib/auth/groups", () => ({ loadPrincipal: f.fresh }));
vi.mock("@/lib/authz", async () => ({ HttpError: (await import("@/lib/http-error")).HttpError, getOwnedConversation: f.conversation, getUsableBot: f.bot }));
vi.mock("@/lib/agent/target", () => ({ resolveTurnTarget: f.target }));
vi.mock("@/lib/runs/state", () => ({ activeRunOf: f.active, getRun: f.run }));
vi.mock("@/lib/settings", () => ({ getSetting: f.settings }));
vi.mock("@/lib/agent-browser/admission", () => ({ assertBrowserAdmission: vi.fn(async () => {}) }));
vi.mock("@/lib/auth/web-sessions", async original => ({ ...await original<object>(), webSessionRegistryEnabled: () => true, activeWebSession: f.registry }));
vi.mock("@/lib/workspaces/instances", () => ({ resolveWorkspace: f.workspace }));
vi.mock("@/lib/workspaces/resolve", () => ({ resolveWorkspace: f.workspace }));
const enabled = process.env.AGENT_BROWSER_VIEWER_PROOF === "1" && existsSync(join(process.cwd(), "src/lib/agent-browser/session-source.ts"));

describe.skipIf(!enabled)("W4 real page through integrated W5 source resolver and SSE route", () => {
  it("delivers actual agent navigation/click frames through a separate read-only viewer client, and revokes its source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "browser-w5-real-")); const socket = join(dir, "broker.sock");
    const secret = "joint-synthetic-browser-secret".repeat(2);
    const scope: BrowserScope = { ownerUserId: "owner-a", botId: "bot-a", runId: "run-a", conversationId: "conversation-a", workspaceInstanceId: "instance-a" };
    const registry = new PGlite(); const q = drizzle(registry) as unknown as DbOrTx;
    await registry.exec("create table users(id text primary key); insert into users values ('owner-a');");
    await registry.exec(await readFile("src/db/migrations/0056_web_sessions.sql", "utf8"));
    const sessions = await vi.importActual<typeof import("@/lib/auth/web-sessions")>("@/lib/auth/web-sessions");
    const identity = { userId: scope.ownerUserId, sessionId: randomUUID(), sessionVersion: 1, expiresAt: new Date(Math.floor(Date.now() / 1000) * 1000 + 3600_000) };
    await sessions.admitWebSession(identity, q);
    f.registry.mockImplementation(value => sessions.activeWebSession(value, q));
    f.workspace.mockResolvedValue({ instanceId: scope.workspaceInstanceId, ownerUserId: scope.ownerUserId, botId: scope.botId });
    const principal = { user: { id: scope.ownerUserId, sessionVersion: 1 }, groupIds: [], isAdmin: false };
    const run = { id: scope.runId, userId: scope.ownerUserId, botId: scope.botId, conversationId: scope.conversationId, status: "running" };
    f.principal.mockResolvedValue(principal); f.fresh.mockResolvedValue(principal);
    f.auth.mockResolvedValue({ user: { id: scope.ownerUserId, sessionId: identity.sessionId, sessionVersion: 1 } });
    f.conversation.mockResolvedValue({ id: scope.conversationId, userId: scope.ownerUserId, botId: scope.botId, source: "chat", isGroup: false });
    f.settings.mockImplementation(key => key === "sandbox" ? { enabled: true, access: "everyone" } : { disabledTools: [] });
    f.bot.mockResolvedValue({ id: scope.botId, executionMode: "caller", hermesTeam: null });
    f.target.mockResolvedValue({ bot: { id: scope.botId } }); f.active.mockResolvedValue(run); f.run.mockResolvedValue(run);
    let browser: Browser | undefined; let launches = 0;
    const runtime = new BrowserRuntime({ launch: async () => {
      launches++; browser = await chromium.launch({ executablePath: "/usr/bin/chromium", chromiumSandbox: process.env.AGENT_BROWSER_TEST_UNSANDBOXED !== "1" }); return browser;
    }, egress: async req => {
      if (req.url !== "https://fixture.example/") throw new Error("Synthetic page only");
      return { status: 200, headers: [{ name: "content-type", value: "text/html" }], bodyB64: Buffer.from('<body style="background:rgb(200,20,20)"><button onclick="document.body.style.background=\'rgb(20,200,20)\'">Change</button>').toString("base64") };
    } });
    const server = createBrowserServer(runtime, secret); await new Promise<void>(done => server.listen(socket, done));
    const sourceModulePath = "@/lib/agent-browser/session-source";
    const streamModulePath = "@/app/api/agent-browser/stream/route";
    const statusModulePath = "@/app/api/agent-browser/status/route";
    const w5 = await import(sourceModulePath); const stream = await import(streamModulePath); const status = await import(statusModulePath);
    const { admitIntegratedBrowserViewer } = await import("@/lib/agent-browser/integration");
    const unregister = installBrowserSessionSourceResolver(w5.registerBrowserSessionSourceResolver, admitIntegratedBrowserViewer,
      { AGENT_BROWSER_ENABLED: "1", AGENT_BROWSER_SOCKET: socket, AGENT_BROWSER_SECRET: secret });
    const worker = new PrivateBrowserProvider(socket, secret, async () => {});
    const tools = await agentBrowserTools({ principal, bot: { id: scope.botId }, conversationId: scope.conversationId, usage: { runId: scope.runId } } as unknown as AgentCtx,
      { provider: worker, workspace: { ownerUserId: scope.ownerUserId, instanceId: scope.workspaceInstanceId! }, assertWorkspace: async () => {} });
    const execute = async (name: string, input: unknown) => (tools.entries.find(e => e.name === name)!.tool.execute as (i: unknown, o: object) => Promise<unknown>)(input, { toolCallId: "joint", messages: [] });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let secondWindow: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const request = (op: string) => new Request(`https://portal.test/api/agent-browser/${op}?conversationId=${scope.conversationId}`);
    const wireFrame = async () => {
      const wire = new TextDecoder().decode((await reader!.read()).value);
      expect(wire).toContain("event: frame"); expect(wire).not.toContain(scope.ownerUserId);
      const payload = JSON.parse(wire.split("data: ")[1].trim());
      const { data, info } = await sharp(Buffer.from(payload.data, "base64")).raw().toBuffer({ resolveWithObject: true });
      const offset = (500 * info.width + 800) * info.channels;
      return { payload, pixel: [...data.subarray(offset, offset + 3)] };
    };
    try {
      expect(await w5.resolveBrowserSessionSource({ ownerUserId: scope.ownerUserId, botId: scope.botId, runId: scope.runId, workspaceInstanceId: scope.workspaceInstanceId }, new AbortController().signal)).toBeNull();
      expect(launches).toBe(0); // Viewer lookup cannot start a browser.
      await execute("browser_navigate", { url: "https://fixture.example/" });
      expect((await status.GET(request("status"))).status).toBe(200);
      const response = await stream.GET(request("stream")); expect(response.status).toBe(200); reader = response.body!.getReader();
      const first = await wireFrame(); expect(first.pixel[0]).toBeGreaterThan(150);
      // An independent Node process discovers the same broker binding without any shared JS registry.
      const driver = `import {PrivateBrowserProvider} from './src/lib/agent-browser/provider.ts';
        const provider=new PrivateBrowserProvider(process.env.BROWSER_PROOF_SOCKET,process.env.BROWSER_PROOF_SECRET,async()=>{},'view');
        const session=await provider.find(JSON.parse(process.env.BROWSER_PROOF_SCOPE));
        console.log(JSON.stringify({pid:process.pid,state:await provider.status(session.sessionId)}));`;
      const child = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", driver], {
        cwd: process.cwd(), env: { ...process.env, BROWSER_PROOF_SOCKET: socket, BROWSER_PROOF_SECRET: secret, BROWSER_PROOF_SCOPE: JSON.stringify(scope) }, timeout: 10_000,
      });
      const discovered = JSON.parse(child.stdout.trim()); expect(discovered.pid).not.toBe(process.pid); expect(discovered.state).toBe("active");
      const inspected = await execute("browser_inspect", {}) as { elements: { name: string; ref: string }[] };
      await execute("browser_act", { action: { kind: "click", ref: inspected.elements.find(e => e.name === "Change")!.ref } });
      const second = await wireFrame(); expect(second.pixel[1]).toBeGreaterThan(150); expect(second.payload.sequence).toBeGreaterThan(first.payload.sequence);
      expect(launches).toBe(1); expect(browser!.contexts()[0].pages()).toHaveLength(1);
      await reader!.cancel(); reader = undefined;
      const session = await worker.find(scope); expect(await worker.status(session!.sessionId)).toBe("active");
      const reopened = await stream.GET(request("stream")); reader = reopened.body!.getReader(); await wireFrame();
      secondWindow = (await stream.GET(request("stream"))).body!.getReader();
      expect(new TextDecoder().decode((await secondWindow!.read()).value)).toContain("event: frame");
      await new Promise(resolve => setTimeout(resolve, 1200)); // Leave an actual private frame unread in W5's bounded queue.
      const authSecret = "synthetic-auth-logout-proof".repeat(2);
      const jwt = await encode({ token: { uid: identity.userId, authSessionId: identity.sessionId, sessionVersion: identity.sessionVersion, sessionDeadline: identity.expiresAt.getTime() / 1000 },
        secret: authSecret, salt: "__Secure-authjs.session-token" });
      await commitServerLogout(new Headers({ cookie: `__Secure-authjs.session-token=${jwt}` }), { providers: [], secret: authSecret }, value => sessions.revokeWebSession(value, q), { AUTH_URL: "https://portal.test" });
      expect(await sessions.activeWebSession(identity, q)).toBe(false);
      await new Promise(resolve => setTimeout(resolve, 1500));
      await expect(reader!.read()).rejects.toThrow(); // Durable logout discards queued frames despite the original request's old JWT.
      await expect(secondWindow!.read()).rejects.toThrow();
      expect((await status.GET(request("status"))).status).toBe(401);
      expect(await worker.status(session!.sessionId)).toBe("active"); // Source revocation/viewer close do not cancel agent run.
    } finally {
      await reader?.cancel().catch(() => {}); await secondWindow?.cancel().catch(() => {}); unregister(); await tools.close(); await runtime.shutdown(); server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done())); await registry.close(); await rm(dir, { recursive: true, force: true });
    }
  });
});
