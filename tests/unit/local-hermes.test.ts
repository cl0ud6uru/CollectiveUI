import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { LocalController } from "@/local-hermes/controller";
import { ControllerConfig, childEnvironment, installationId } from "@/local-hermes/config";
import { listenController } from "@/local-hermes/server";
import { LOCAL_ORIGIN, socketFetch } from "@/lib/local-hermes/client";
import { HermesLanguageModel } from "@/lib/llm/providers/hermes/model";
import { closeAllParked } from "@/lib/llm/providers/hermes/runs";
import { streamText, type ModelMessage } from "ai";
import type { RunHandle, ResumeState } from "@/lib/runs/types";
import { assertLocalBot, guardLocalBotMutation } from "@/lib/local-hermes/policy";
import { groupHasLiveMembers } from "@/local-hermes/process-group";
import type { Bot } from "@/db/schema";
import type { Principal } from "@/lib/auth/groups";

// Only installation/source trust validation is bypassed for the deliberately synthetic Python module.
// The real process, stdio, HTTP/Unix socket, controller, mapper and AI SDK all run normally.
vi.mock("@/local-hermes/config", async importOriginal => ({ ...await importOriginal<typeof import("@/local-hermes/config")>(),
  validateInstallation: async (v: unknown) => v, assertNoOtherHermes: async () => {},
}));

let root: string, config: ControllerConfig, controller: LocalController;
let running: Awaited<ReturnType<typeof listenController>> | undefined;
let binding: ReturnType<LocalController["pair"]>;
const until = async (check: () => boolean, timeout = 8000) => {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error("Timed out waiting for native fixture"); await new Promise(r => setTimeout(r, 10)); }
};
const sessionId = "portal-conversation-bot";
const begin = (text: string, receipt: string, session = sessionId) => controller.begin(binding.bindingId, { input: text, session_id: session }, receipt);
const settled = (run: string) => until(() => !["running", "waiting_for_approval"].includes(controller.getRun(run).status));

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lh-test-"));
  for (const dir of ["profile", "work", "account", "state", "ipc"]) await mkdir(path.join(root, dir), { mode: 0o700 });
  config = { trust: "single-user-exclusive-profile", python: "/usr/bin/python3", source: path.resolve("tests/fixtures/hermes-native"),
    profileHome: path.join(root, "profile"), workDir: path.join(root, "work"), accountHome: path.join(root, "account"), stateDir: path.join(root, "state"), socketPath: path.join(root, "ipc/c.sock"), label: "Fixture" };
  controller = new LocalController(config);
  await Promise.all([controller.start(), controller.start()]);
  binding = controller.pair({ runtimeId: controller.runtimeId, ownerId: "admin", name: "Fixture", exclusive: true, model: "", provider: "" });
});
afterEach(async () => { closeAllParked(); await running?.close(); running = undefined; await controller.stop(); await rm(root, { recursive: true, force: true }); });

describe("Local Hermes native pilot", () => {
  it("streams native text, retains only IDs, and rejects duplicate admission/cross-session reuse", async () => {
    const run = begin("hello", "receipt-one");
    expect(begin("hello", "receipt-one")).toBe(run);
    expect(() => begin("again", "receipt-two")).toThrow("unfinished");
    expect(() => begin("hello", "receipt-one", "different")).toThrow("another session");
    await settled(run);
    expect(controller.events(run, 0).events.filter(e => e.event === "message.delta").map(e => e.delta).join("")).toBe("Fixture answer");
    const terminal = controller.events(run, 0).events.at(-1);
    expect(terminal).toMatchObject({ event: "run.completed", usage: { input_tokens: 10, output_tokens: 2 } });
    const metadata = await readFile(path.join(config.stateDir, "bindings.json"), "utf8");
    expect(metadata).not.toContain("hello"); expect(metadata).not.toContain("Fixture answer");
    expect((await readFile(path.join(config.profileHome, "fixture-prompts.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
  });
  it("resumes durable native sessions after engine and controller restart without replaying the old turn", async () => {
    const one = begin("first", "receipt-first"); await settled(one); await controller.stop();
    controller = new LocalController(config); await controller.start();
    expect(begin("first", "receipt-first")).toBe(one);
    const two = begin("second", "receipt-second"); await settled(two);
    const sent = (await readFile(path.join(config.profileHome, "fixture-prompts.jsonl"), "utf8")).trim().split("\n").map(v => JSON.parse(v));
    expect(sent.map(v => v.text)).toEqual(["first", "second"]);
    expect(sent[1].session).toBe("resumed-stored-1");
    expect(controller.getRun(one).status).toBe("failed"); // old output was not fabricated from its receipt
  });
  it("preserves one profile owner across independent controllers and re-pair attempts", async () => {
    const other = new LocalController(config);
    await expect(other.start()).rejects.toThrow("ownership is locked");
    expect(() => controller.pair({ runtimeId: controller.runtimeId, ownerId: "other", name: "Other", exclusive: true, model: "", provider: "" })).toThrow("already paired");
    expect(() => controller.begin("forged", { input: "x", session_id: sessionId }, "receipt")).toThrow("not paired");
    expect(() => new LocalController({ ...config, workDir: config.accountHome })).toThrow("Installation changed");
  });
  it("allows only one-time approval for its exact run, and rejects stale/forged answers", async () => {
    const run = begin("approve", "receipt-approval");
    await until(() => controller.getRun(run).status === "waiting_for_approval");
    const request = controller.events(run, 0).events.find(e => e.event === "approval.request")!;
    expect(() => controller.approve(run, { request_id: request.request_id, choice: "always" })).toThrow();
    expect(() => controller.approve("run_forged", { request_id: request.request_id, choice: "once" })).toThrow("expired");
    controller.approve(run, { request_id: request.request_id, choice: "once" }); await settled(run);
    expect(() => controller.approve(run, { request_id: request.request_id, choice: "once" })).toThrow("expired");
    expect(await readFile(path.join(config.profileHome, "fixture-approvals.jsonl"), "utf8")).toContain('"choice": "once"');
  });
  it("cancels error-only native turns and refuses old approvals after Stop", async () => {
    const run = begin("approve", "receipt-cancel"); await until(() => controller.getRun(run).status === "waiting_for_approval");
    const request = controller.events(run, 0).events.find(e => e.event === "approval.request")!;
    await controller.cancel(run); await settled(run);
    expect(() => controller.approve(run, { request_id: request.request_id, choice: "once" })).toThrow("expired");
    const contents = await readFile(path.join(config.profileHome, "fixture-approvals.jsonl"), "utf8");
    expect(contents).not.toContain('"once"');
  });
  it("terminates unsupported prompts and malformed/oversized native frames", async () => {
    for (const text of ["unsupported", "malformed", "oversized"]) {
      const run = begin(text, `receipt-${text}`); await settled(run);
      expect(controller.getRun(run).status).toBe("interrupted");
      await controller.stop(); await controller.start();
    }
  });
  it("cleans SIGTERM-ignoring descendants after explicit Stop and unexpected parent exit", async () => {
    for (const text of ["descendant", "orphan"]) {
      const run = begin(text, `receipt-${text}`);
      await until(() => controller.events(run, 0).events.some(e => e.event === "message.delta"));
      const group = Number(await readFile(path.join(config.profileHome, "fixture-group"), "utf8"));
      if (text === "descendant") await controller.stop();
      await settled(run);
      expect(await groupHasLiveMembers(group)).toBe(false);
      await controller.stop(); await controller.start();
    }
  }, 15000);
  it("poisons failed admissions so a retry cannot become a phantom or duplicate turn", async () => {
    await chmod(config.stateDir, 0o500);
    try { expect(() => begin("never submitted", "receipt-write-error")).toThrow("persisted"); }
    finally { await chmod(config.stateDir, 0o700); }
    expect(() => begin("never submitted", "receipt-write-error")).toThrow("persisted");
    await expect(controller.start()).rejects.toThrow("persisted");
    await expect(readFile(path.join(config.profileHome, "fixture-prompts.jsonl"))).rejects.toThrow();
  });
  it("never returns an in-memory pairing after a failed durable write", async () => {
    await controller.stop();
    await rm(path.join(config.stateDir, "bindings.json"));
    controller = new LocalController(config); await controller.start();
    const pair = () => controller.pair({ runtimeId: controller.runtimeId, ownerId: "admin", name: "Fixture", exclusive: true, model: "", provider: "" });
    await chmod(config.stateDir, 0o500);
    try { expect(pair).toThrow("persisted"); } finally { await chmod(config.stateDir, 0o700); }
    expect(pair).toThrow("persisted");
    expect(JSON.parse(await readFile(path.join(config.stateDir, "bindings.json"), "utf8")).binding).toBeUndefined();
  });
  it("does not inherit application secrets or ambient credential variables", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://synthetic-secret"); vi.stubEnv("OPENAI_API_KEY", "synthetic-provider-secret");
    try {
      expect(childEnvironment(config)).not.toHaveProperty("DATABASE_URL");
      expect(childEnvironment(config)).not.toHaveProperty("OPENAI_API_KEY");
      const run = begin("environment", "receipt-env"); await settled(run);
      const data = JSON.stringify(controller.events(run, 0));
      expect(data).not.toContain("DATABASE_URL"); expect(data).not.toContain("OPENAI_API_KEY");
      expect(data).toContain("HERMES_DISABLE_LAZY_INSTALLS");
    } finally { vi.unstubAllEnvs(); }
  });
  it("rejects shell-shaped/nonabsolute config and binds canonical installation identity", () => {
    expect(() => ControllerConfig.parse({ ...config, python: "python --exec evil" })).toThrow();
    expect(() => ControllerConfig.parse({ ...config, shell: "sh" })).toThrow();
    expect(() => ControllerConfig.parse({ ...config, trust: "multiuser" })).toThrow();
    expect(installationId(config)).not.toBe(installationId({ ...config, profileHome: "/another" }));
  });
  it("refuses a retained uncertain receipt until exclusive startup and never repeats its prompt", async () => {
    const run = begin("slow", "receipt-uncertain"); await until(() => { try { return controller.events(run, 0).events.length === 0; } catch { return false; } });
    await controller.stop();
    const file = path.join(config.stateDir, "bindings.json"); const data = JSON.parse(await readFile(file, "utf8"));
    data.receipts["receipt-uncertain"].status = "running"; await writeFile(file, JSON.stringify(data));
    controller = new LocalController(config);
    expect(() => controller.getRun(run)).toThrow("uncertain");
    await controller.start(); expect(begin("slow", "receipt-uncertain")).toBe(run);
    expect(controller.getRun(run).status).toBe("interrupted");
  });
  it("runs the existing AI SDK approval continuation over protected Unix IPC, with replay", async () => {
    running = await listenController(controller);
    expect((await stat(config.socketPath)).mode & 0o777).toBe(0o660);
    await expect(listenController(new LocalController(config))).rejects.toThrow("ownership is locked");
    const f = socketFetch(config.socketPath);
    await expect(f("http://example.com/v1/runs")).rejects.toThrow("destination");
    expect((await f(`${LOCAL_ORIGIN}/control/status`, { headers: { Origin: "http://evil" } })).status).toBe(403);
    const target = { baseUrl: LOCAL_ORIGIN, profile: binding.bindingId, apiKey: "", fetch: f, local: true };
    let saved: ResumeState | null = null;
    const run: RunHandle = { id: "durable-portal-run", segment: 0, legacy: false, resumeState: null, saveResumeState: s => { saved = s; } };
    const model = () => new HermesLanguageModel("native-profile", { target, sessionId, sessionKey: null, interactive: true, approvalTimeoutSec: 300, run });
    const first = streamText({ model: model(), messages: [{ role: "user", content: "approve" }] });
    const parts = []; for await (const part of first.stream) parts.push(part);
    const approval = parts.find(p => p.type === "tool-approval-request")!;
    expect(approval).toBeTruthy();
    run.resumeState = saved; run.segment = 1;
    const messages: ModelMessage[] = [...(await first.response).messages, { role: "tool", content: [{ type: "tool-approval-response", approvalId: approval.approvalId, approved: true, providerExecuted: true } as never] }];
    const next = streamText({ model: model(), messages }); await next.consumeStream();
    expect(await next.text).toBe("Tool once");
    const remote = JSON.parse(await readFile(path.join(config.stateDir, "bindings.json"), "utf8")).receipts["portal-durable-portal-run"].runId;
    const replay = await f(`${LOCAL_ORIGIN}/p/${binding.bindingId}/v1/runs/${remote}/events`, { headers: { "Last-Event-ID": "1" } });
    expect(await replay.text()).toContain("run.completed");
    const again = streamText({ model: model(), messages: [{ role: "user", content: "approve" }] }); await again.consumeStream();
    expect((await readFile(path.join(config.profileHome, "fixture-prompts.jsonl"), "utf8")).trim().split("\n")).toHaveLength(1);
  });
  it("fails closed for shared, nonowner, nonadmin, service, copied or rebound bots", async () => {
    const local = { runtimeId: controller.runtimeId, bindingId: binding.bindingId, ownerId: "admin", botId: "bot", model: "", provider: "" };
    const app = { id: "app", provider: "hermes" as const, providerConfig: { local }, isPublic: false };
    const bot = { id: "bot", ownerId: "admin", appId: "app", visibility: "private", executionMode: "caller", coordinatorEligible: false } as Bot;
    const principal = { isAdmin: true, user: { id: "admin" } } as Principal;
    await expect(assertLocalBot(principal, app, bot)).resolves.toBeUndefined();
    for (const change of [{ visibility: "org" }, { id: "copy" }, { executionMode: "service" }, { ownerId: "other" }, { coordinatorEligible: true }])
      await expect(assertLocalBot(principal, app, { ...bot, ...change } as Bot)).rejects.toThrow("private");
    await expect(assertLocalBot({ ...principal, isAdmin: false }, app, bot)).rejects.toThrow();
    expect(() => guardLocalBotMutation(app, bot.id, { ...bot, appId: "other" })).toThrow();
    expect(() => guardLocalBotMutation(app, bot.id, null)).toThrow("retains");
  });
});
