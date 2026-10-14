import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ invoke: vi.fn(), retainedIdentityValid: true, assertRetained: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/computer/agent", () => ({
  COMPUTER_TOOL_NAMES: ["computer_screenshot", "computer_click", "computer_type", "computer_key", "computer_scroll"],
  invokeComputerTool: calls.invoke,
}));
vi.mock("@/personal-codex/control", () => ({ personalControl: async () => ({ state: "running", siwc: { available: true, credentialBinding: "fingerprint-1" } }) }));
vi.mock("@/lib/llm/chatgpt/invalidation", () => ({
  captureCurrentSIWCConnection: async (_owner: string, _binding: string, _fingerprint: string, identity?: object) => identity ?? ({ owner: "owner-1", sessionVersion: 0, binding: "credential-binding", credentialId: "credential-1", accountId: "siwc:client-1", subject: "subject-1", email: "owner@example.test", clientId: "client-1", hostId: "host-1", scope: "scope-1" }),
  assertRetainedSIWCConnection: async () => { calls.assertRetained(); if (!calls.retainedIdentityValid) throw new Error("Your ChatGPT connection changed during the turn."); },
}));

import { executeCodexSession, type SessionHooks } from "@/lib/codex/session";

type Notification = { method: string; params: unknown };
type Request = { id: string | number; method: string; params: unknown };

function clientFixture(options: { resume?: boolean; tool?: string; args?: unknown; siwc?: boolean } = {}) {
  const notifications = new Set<(event: Notification) => void>();
  const serverRequests = new Set<(event: Request) => void>();
  const failures = new Set<(error: Error) => void>();
  const seen: { method: string; params: Record<string, unknown> }[] = [];
  const responses: { id: string | number; result: unknown }[] = [];
  const rejected: (string | number)[] = [];
  let turnId = "turn-1";
  const emit = (event: Notification) => { for (const listener of notifications) listener(event); };
  const client = {
    onNotification(listener: (event: Notification) => void) { notifications.add(listener); return () => notifications.delete(listener); },
    onServerRequest(listener: (event: Request) => void) { serverRequests.add(listener); return () => serverRequests.delete(listener); },
    onFailure(listener: (error: Error) => void) { failures.add(listener); return () => failures.delete(listener); },
    rejectRequest(id: string | number) { rejected.push(id); },
    respond(id: string | number, result: unknown) {
      responses.push({ id, result });
      emit({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId, status: "completed" } } });
    },
    async request(method: string, raw: unknown): Promise<unknown> {
      const params = raw as Record<string, unknown>;
      seen.push({ method, params });
      if (method === "account/read") return { account: { type: "chatgpt", email: "owner@example.test", planType: "business" }, workspaceRouting: { chatgptAccountId: "workspace-1", backendOrigin: "https://chatgpt.com/backend-api", accountRoutingOverride: "NO_CONSTRAINT" } };
      if (method === "config/read") return { config: options.siwc ? { model_provider: "openai_chatgpt_plan", model_providers: { openai_chatgpt_plan: { base_url: "https://api.openai.com/v1", env_key: "ACCESS_TOKEN", wire_api: "responses", requires_openai_auth: false, supports_websockets: false } }, shell_environment_policy: { inherit: "none", filters: { ACCESS_TOKEN: "exclude" } } } : { forced_login_method: "chatgpt", forced_chatgpt_workspace_id: "workspace-1" } };
      if (method === "configRequirements/read") return { requirements: { defaultPermissions: "collective-personal", allowedPermissionProfiles: { "collective-personal": true }, allowedLoginMethods: ["chatgpt"], allowedApprovalsReviewers: ["user"], allowedApprovalPolicies: ["on-request"] } };
      if (method === "model/list") return { data: [{ model: "fixture-model", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }], nextCursor: null };
      if (method === "thread/start" || method === "thread/resume") return { thread: { id: "thread-1", turns: method === "thread/resume" ? [{ id: "old-turn", status: "completed" }] : [] }, model: "fixture-model", modelProvider: options.siwc ? "openai_chatgpt_plan" : "openai", cwd: "/workspace", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspaceWrite", networkAccess: false }, activePermissionProfile: { id: "collective-personal", extends: null } };
      if (method === "turn/start") {
        turnId = "turn-1";
        for (const listener of serverRequests) listener({ id: "tool-call", method: "item/tool/call", params: {
          threadId: "thread-1", turnId, callId: "call-1", namespace: null,
          tool: options.tool ?? "computer_type", arguments: options.args ?? { text: "private typed text" },
        } });
        return { turn: { id: turnId } };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  return { client, seen, responses, rejected };
}

const runtime = { managed: true, ownerId: "owner-1", funding: "chatgpt_subscription", expectedEmail: "owner@example.test", expectedWorkspaceId: "workspace-1", cwd: "/workspace" };
const siwcRuntime = { ...runtime, authMode: "siwc", tokenFingerprint: "fingerprint-1", credentialBinding: "credential-binding" };
const agent = { runtime: { ownerId: "owner-1", socketPath: "/tmp/codex.sock" }, tools: ["screenshot", "click", "type", "key", "scroll"].map(name => ({ type: "function", name: `computer_${name}`, description: "fixture", inputSchema: { type: "object" } })) } as never;
const policy = { funding: "chatgpt_subscription", model: "fixture-model", effort: "medium" } as never;

async function run(options: { resume?: boolean; tool?: string; args?: unknown; siwc?: boolean } = {}) {
  const fixture = clientFixture(options);
  const checkpoints: unknown[] = [], visible: unknown[] = [];
  const hooks: SessionHooks = {
    checkpoint: async values => { checkpoints.push(values); }, text: () => {}, computerAgent: agent,
    authorizeComputerCall: async () => { visible.push("authorized"); },
    computerTool: (callId, tool, phase, success) => visible.push({ callId, tool, phase, success }),
    authorizeAccount: async () => {},
    resumeThreadId: options.resume ? "thread-1" : undefined,
  };
  await executeCodexSession(fixture.client as never, (options.siwc ? siwcRuntime : runtime) as never, policy, "turn", "", hooks, AbortSignal.timeout(1000));
  return { ...fixture, checkpoints, visible };
}

describe("Codex computer dynamic tool lifecycle", () => {
  beforeEach(() => {
    calls.retainedIdentityValid = true;
    calls.assertRetained.mockReset();
    calls.invoke.mockReset().mockResolvedValue({ success: true, contentItems: [{ type: "inputText", text: "Computer input completed." }] });
  });

  it("registers tools only on start and validates owner-bound tool calls before broker dispatch", async () => {
    const result = await run();
    const start = result.seen.find(item => item.method === "thread/start")!;
    expect(start.params.dynamicTools).toHaveLength(5);
    expect(start.params.dynamicTools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "computer_screenshot", type: "function" })]));
    expect(calls.invoke).toHaveBeenCalledWith(agent, "computer_type", { text: "private typed text" }, expect.any(AbortSignal), expect.any(Function));
    expect(result.responses).toEqual([{ id: "tool-call", result: { success: true, contentItems: [{ type: "inputText", text: "Computer input completed." }] } }]);
    expect(result.visible).toContain("authorized");
    expect(JSON.stringify(result.visible)).not.toContain("private typed text");
    expect(result.checkpoints).toContainEqual({ phase: "terminal" });
  });

  it("resumes stored tools without changing the saved thread tool list and reauthorizes each call", async () => {
    const result = await run({ resume: true, tool: "computer_click", args: { x: 12, y: 31 } });
    const resume = result.seen.find(item => item.method === "thread/resume")!;
    expect(resume.params).not.toHaveProperty("dynamicTools");
    expect(calls.invoke).toHaveBeenCalledWith(agent, "computer_click", { x: 12, y: 31 }, expect.any(AbortSignal), expect.any(Function));
    expect(result.visible.filter(item => item === "authorized")).toHaveLength(1);
  });

  it("rejects unsupported tool names without invoking the broker", async () => {
    await expect(run({ tool: "computer_shell", args: { command: "id" } })).rejects.toThrow("unsupported computer tool");
    expect(calls.invoke).not.toHaveBeenCalled();
  });

  it("rechecks SIWC identity after screenshot capture while allowing a same-identity token refresh", async () => {
    calls.retainedIdentityValid = true;
    calls.assertRetained.mockClear();
    calls.invoke.mockImplementationOnce(async (_agent, _tool, _args, _signal, reauthorize) => {
      await reauthorize(); // invokeComputerTool's post-capture release fence
      return { success: true, contentItems: [{ type: "inputImage", imageUrl: "data:image/jpeg;base64,fixture" }] };
    });
    const refreshed = await run({ siwc: true, tool: "computer_screenshot", args: {} });
    expect(refreshed.responses).toHaveLength(1);
    expect(refreshed.responses[0].result).toMatchObject({ success: true });
    expect(calls.assertRetained).toHaveBeenCalled();

    calls.assertRetained.mockClear();
    calls.invoke.mockImplementationOnce(async (_agent, _tool, _args, _signal, reauthorize) => {
      calls.retainedIdentityValid = false; // account or SIWC registration changed while capture was in flight
      await reauthorize();
      return { success: true, contentItems: [{ type: "inputImage", imageUrl: "data:image/jpeg;base64,fixture" }] };
    });
    await expect(run({ siwc: true, tool: "computer_screenshot", args: {} })).rejects.toThrow("authorization failed safely");
  });
});
