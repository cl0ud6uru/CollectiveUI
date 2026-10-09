import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { NativeRpc } from "@/local-hermes/rpc";
import { LocalController } from "@/local-hermes/controller";
import { ControllerConfig, childEnvironment, installationId } from "@/local-hermes/config";
import { listenController } from "@/local-hermes/server";
import { LOCAL_ORIGIN, socketFetch } from "@/lib/local-hermes/client";
import { randomUUID } from "node:crypto";
import { sessionApprovalMode } from '@/lib/llm/providers/hermes/client';
import { HermesLanguageModel, newestNativeAttachments } from "@/lib/llm/providers/hermes/model";
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
const settled = (run: string) => until(() => !["running", "waiting_for_approval", "waiting_for_input"].includes(controller.getRun(run).status));

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
  it('persists session YOLO over IPC and consumes it for native one-time approval RPCs only', async () => {
    running = await listenController(controller);
    const target = { baseUrl: LOCAL_ORIGIN, profile: binding.bindingId, apiKey: '', local: true, fetch: socketFetch(config.socketPath) };
    expect(await sessionApprovalMode(target, sessionId)).toMatchObject({ enabled: false, scope: 'session', session_id: sessionId, profile: binding.bindingId });
    expect(await sessionApprovalMode(target, sessionId, true)).toMatchObject({ enabled: true });
    const on = begin('approve', 'yolo-on'); await settled(on);
    expect(controller.getRun(on).output).toBe('Tool once');
    expect(controller.events(on, 0).events.some(e => e.event === 'approval.request')).toBe(false);
    const other = begin('approve', 'yolo-other', 'fresh-session');
    await until(() => controller.getRun(other).status === 'waiting_for_approval');
    await expect(sessionApprovalMode(target, sessionId, false)).rejects.toMatchObject({ status: 409 });
    await controller.cancel(other); await settled(other);
    await running.close(); running = undefined;
    controller = new LocalController(config); await controller.start();
    running = await listenController(controller);
    expect(await sessionApprovalMode(target, sessionId)).toMatchObject({ enabled: true });
    const resumed = begin('approve', 'yolo-resumed'); await settled(resumed);
    expect(controller.getRun(resumed).output).toBe('Tool once');
    expect(await sessionApprovalMode(target, sessionId, false)).toMatchObject({ enabled: false });
    const off = begin('approve', 'yolo-off');
    await until(() => controller.getRun(off).status === 'waiting_for_approval');
    const prompt = controller.events(off, 0).events.find(e => e.event === 'approval.request')!;
    controller.approve(off, { request_id: prompt.request_id, choice: 'deny' }); await settled(off);
    expect(controller.getRun(off).output).toBe('Tool deny');
    expect(await sessionApprovalMode(target, 'fresh-session')).toMatchObject({ enabled: false });
  });
  it('streams normal-chat YOLO through the production AI SDK adapter without parking an approval', async () => {
    running = await listenController(controller);
    const target = { baseUrl: LOCAL_ORIGIN, profile: binding.bindingId, apiKey: '', local: true, fetch: socketFetch(config.socketPath) };
    await sessionApprovalMode(target, sessionId, true);
    const model = new HermesLanguageModel('native', { target, sessionId, sessionKey: null, interactive: true, approvalTimeoutSec: 30 });
    const result = streamText({ model, messages: [{ role: 'user', content: 'approve' }] });
    const parts = []; for await (const part of result.stream) parts.push(part);
    expect(await result.text).toBe('Tool once');
    expect(parts.some(part => part.type === 'tool-approval-request')).toBe(false);
    expect(await sessionApprovalMode(target, sessionId)).toMatchObject({ enabled: true });
  });
  it('never lets YOLO or manual replies override a deny-only native approval', async () => {
    controller.sessionApprovalMode(binding.bindingId, sessionId, true);
    const run = begin('deny-only', 'yolo-deny-only');
    await until(() => controller.getRun(run).status === 'waiting_for_approval');
    const prompt = controller.events(run, 0).events.find(e => e.event === 'approval.request')!;
    expect(() => controller.approve(run, { request_id: prompt.request_id, choice: 'once' })).toThrow('does not allow');
    controller.approve(run, { request_id: prompt.request_id, choice: 'deny' }); await settled(run);
    expect(controller.getRun(run).output).toBe('Tool deny');
  });
  it.each(['protected', 'ambiguous-approvals', 'late-approval'])('keeps YOLO behind protected, pairing and cancellation floors: %s', async text => {
    controller.sessionApprovalMode(binding.bindingId, sessionId, true);
    const run = begin(text, `floor-${text}`);
    if (text === 'protected') {
      await until(() => controller.getRun(run).status === 'waiting_for_input');
      expect(() => controller.sessionApprovalMode(binding.bindingId, sessionId, false)).toThrow('unfinished');
      const view = await controller.nativeView(run);
      await controller.nativeControl(run, { operation: 'answer', requestId: view.prompts[0].id, answer: { value: 'synthetic-protected' } });
    } else if (text === 'late-approval') {
      await until(() => controller.events(run, 0).events.some(e => e.event === 'tool.started'));
      await controller.cancel(run).catch(() => {});
    }
    await settled(run);
    const log = await readFile(path.join(config.profileHome, 'fixture-approvals.jsonl'), 'utf8').catch(() => '');
    expect(log).not.toContain('"choice": "once"');
  });
  it('reports stopped controller state as unavailable rather than verifying a cached preference', async () => {
    controller.sessionApprovalMode(binding.bindingId, sessionId, true);
    await controller.stop();
    expect(() => controller.sessionApprovalMode(binding.bindingId, sessionId)).toThrow('Start');
    expect(() => controller.sessionApprovalMode(binding.bindingId, sessionId, false)).toThrow('Start');
    await controller.start();
    expect(controller.sessionApprovalMode(binding.bindingId, sessionId).enabled).toBe(true);
  });
  it('fails closed on invalid IPC bodies, binding and durable storage failure', async () => {
    running = await listenController(controller);
    const f = socketFetch(config.socketPath);
    const url = `${LOCAL_ORIGIN}/p/${binding.bindingId}/v1/sessions/${sessionId}/approval-mode`;
    for (const invalid of [{ enabled: 'true' }, { enabled: true, scope: 'global' }, { enabled: true, session_id: 'other' }]) {
      expect((await f(url, { method: 'PUT', body: JSON.stringify(invalid) })).status).toBe(400);
    }
    expect((await f(url.replace(binding.bindingId, 'forged'))).status).toBe(403);
    expect(controller.sessionApprovalMode(binding.bindingId, sessionId).enabled).toBe(false);
    const release = controller.holdForSettings();
    try {
      expect(() => controller.sessionApprovalMode(binding.bindingId, sessionId, true)).toThrow('unfinished');
      expect(() => begin('hello', 'hold-yolo')).toThrow('settings');
    } finally { release(); }
    await chmod(config.stateDir, 0o500);
    try { expect(() => controller.sessionApprovalMode(binding.bindingId, sessionId, true)).toThrow('persisted'); }
    finally { await chmod(config.stateDir, 0o700); }
    expect(() => controller.sessionApprovalMode(binding.bindingId, sessionId)).toThrow('persisted');
    expect(JSON.parse(await readFile(path.join(config.stateDir, 'bindings.json'), 'utf8')).sessionYolo).toEqual({});
  });
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
  it("stages native image, PDF and file bytes exactly once before prompt admission", async () => {
    const attachments = [
      { name: 'fixture.png', mediaType: 'image/png', contentBase64: Buffer.from('synthetic-image').toString('base64') },
      { name: 'fixture.pdf', mediaType: 'application/pdf', contentBase64: Buffer.from('synthetic-pdf').toString('base64') },
      { name: 'fixture.txt', mediaType: 'text/plain', contentBase64: Buffer.from('synthetic-file').toString('base64') },
    ];
    const run = controller.begin(binding.bindingId, { input: 'inspect these', session_id: sessionId, attachments }, 'files-receipt');
    await settled(run);
    expect(controller.begin(binding.bindingId, { input: 'inspect these', session_id: sessionId, attachments }, 'files-receipt')).toBe(run);
    expect(() => controller.begin(binding.bindingId, { input: 'different', session_id: sessionId, attachments }, 'files-receipt')).toThrow('different content');
    const staged = (await readFile(path.join(config.profileHome, 'fixture-attachments.jsonl'), 'utf8')).trim().split('\n').map(v => JSON.parse(v));
    expect(staged.map(v => v.method)).toEqual(['image.attach_bytes', 'pdf.attach', 'file.attach']);
    const native = JSON.parse((await readFile(path.join(config.profileHome, 'fixture-prompts.jsonl'), 'utf8')).trim());
    expect(native.text).toBe('inspect these\n@fixture.txt');
    const metadata = await readFile(path.join(config.stateDir, 'bindings.json'), 'utf8');
    expect(metadata).not.toContain('synthetic-file'); expect(metadata).not.toContain(attachments[0].contentBase64);
  });
  it("answers clarification and protected prompts without storing protected values or leaking native IDs", async () => {
    for (const kind of ['clarify', 'single', 'protected']) {
      const run = begin(kind, `input-${kind}`);
      await until(() => controller.getRun(run).status === 'waiting_for_input');
      expect(() => controller.holdForSettings()).toThrow('unfinished');
      const view = await controller.nativeView(run), prompt = view.prompts[0];
      expect(JSON.stringify(view)).not.toContain('srq-input');
      await expect(controller.nativeControl('run_forged', { operation: 'answer', requestId: prompt.id, answer: {} })).rejects.toThrow('ended');
      const answer = kind === 'clarify' ? { answers: { 'q-one': 'One' } } : kind === 'single' ? { answer: 'One' } : { value: 'synthetic-protected' };
      await controller.nativeControl(run, { operation: 'answer', requestId: prompt.id, answer }); await settled(run);
      expect(controller.getRun(run).output).toBe('Native input accepted');
      await expect(controller.nativeControl(run, { operation: 'answer', requestId: prompt.id, answer })).rejects.toThrow('ended');
      expect(JSON.stringify(controller.events(run, 0))).not.toContain('synthetic-protected');
      expect(await readFile(path.join(config.stateDir, 'bindings.json'), 'utf8')).not.toContain('synthetic-protected');
    }
  });
  it("deduplicates steering and queued messages, and retains only admission hashes", async () => {
    const run = begin('slow', 'control-main');
    await until(() => { try { return controller.status().status === 'ready'; } catch { return false; } });
    // Wait for actual submission, not just controller readiness.
    await until(() => { try { return readFileSync(path.join(config.profileHome, 'fixture-prompts.jsonl'), 'utf8').includes('slow'); } catch { return false; } });
    await new Promise(resolve => setTimeout(resolve, 20));
    const steer = { operation: 'steer', requestId: randomUUID(), text: 'A synthetic correction' };
    expect(await controller.nativeControl(run, steer)).toEqual({ accepted: true, duplicate: false });
    expect(await controller.nativeControl(run, steer)).toEqual({ accepted: true, duplicate: true });
    await expect(controller.nativeControl(run, { ...steer, text: 'Changed correction' })).rejects.toThrow('other work');
    const queue = { operation: 'queue', requestId: randomUUID(), text: 'A synthetic next message' };
    await controller.nativeControl(run, queue);
    expect(await controller.nativeControl(run, queue)).toEqual({ accepted: true, duplicate: true });
    await expect(controller.nativeControl(run, { ...queue, requestId: randomUUID() })).rejects.toThrow('Only one');
    expect((await controller.nativeView(run)).queued).toBe(queue.text);
    const controls = (await readFile(path.join(config.profileHome, 'fixture-controls.jsonl'), 'utf8')).trim().split('\n');
    expect(controls).toHaveLength(2);
    const metadata = await readFile(path.join(config.stateDir, 'bindings.json'), 'utf8');
    expect(metadata).not.toContain(steer.text); expect(metadata).not.toContain(queue.text);
    await controller.cancel(run); await settled(run);
  });
  it.each(['queue', 'steer'] as const)("tracks a %s follow-up and its protected prompt under the original owned run", async operation => {
    const run = begin('approve', 'queued-continuation');
    await until(() => controller.getRun(run).status === 'waiting_for_approval');
    const approval = controller.events(run, 0).events.find(e => e.event === 'approval.request')!;
    await controller.nativeControl(run, { operation, requestId: randomUUID(), text: operation === 'steer' ? 'followup correction' : 'Synthetic queued work' });
    controller.approve(run, { request_id: approval.request_id, choice: 'once' });
    await until(() => controller.getRun(run).status === 'waiting_for_input');
    expect(controller.events(run, 0).events.some(e => e.event === 'run.completed')).toBe(false);
    const view = await controller.nativeView(run);
    expect(view.queued).toBe('');
    await controller.nativeControl(run, { operation: 'answer', requestId: view.prompts[0].id, answer: { value: 'synthetic-protected' } });
    await settled(run);
    expect(controller.getRun(run).output).toBe('Native input accepted');
    expect(controller.events(run, 0).events.filter(e => e.event === 'run.completed')).toHaveLength(1);
  });
  it("retains rejected steering receipts without falsely accepting or replaying them", async () => {
    const run = begin('approve', 'rejected-steer');
    await until(() => controller.getRun(run).status === 'waiting_for_approval');
    const input = { operation: 'steer', requestId: randomUUID(), text: 'rejected correction' };
    await expect(controller.nativeControl(run, input)).rejects.toMatchObject({ status: 409 });
    await expect(controller.nativeControl(run, input)).rejects.toMatchObject({ status: 409 });
    expect(controller.getRun(run).status).toBe('waiting_for_approval');
    expect((await readFile(path.join(config.profileHome, 'fixture-controls.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
  });
  it("stops the owned engine when attachment staging is cancelled before submission", async () => {
    const run = controller.begin(binding.bindingId, { input: 'cancelled images', session_id: sessionId,
      attachments: [{ name: 'slow.png', mediaType: 'image/png', contentBase64: 'eA==' }] }, 'cancelled-image');
    await until(() => { try { return readFileSync(path.join(config.profileHome, 'fixture-attachments.jsonl'), 'utf8').includes('slow.png'); } catch { return false; } });
    await controller.cancel(run).catch(e => expect(e.message).toContain('Native Hermes exited')); await settled(run);
    await until(() => controller.status().status === 'stopped');
    expect(controller.getRun(run).status).toBe('interrupted');
    await expect(readFile(path.join(config.profileHome, 'fixture-prompts.jsonl'))).rejects.toThrow();
    await controller.start();
    const next = begin('new clean turn', 'after-cancelled-image'); await settled(next);
    const prompt = JSON.parse((await readFile(path.join(config.profileHome, 'fixture-prompts.jsonl'), 'utf8')).trim());
    expect(prompt.session).toBe('resumed-stored-1'); expect(prompt.text).toBe('new clean turn');
  });
  it.each(['queue', 'steer'] as const)("invalidates a stale idle proof before a new %s admission", async operation => {
    const original = NativeRpc.prototype.call;
    let release: ((value: Record<string, unknown>) => void) | undefined, observed = 0;
    const spy = vi.spyOn(NativeRpc.prototype, 'call').mockImplementation(async function(this: NativeRpc, method, params = {}, timeoutMs) {
      const result = await original.call(this, method, params, timeoutMs);
      if (method === 'collective.session.settled' && ++observed === 1) return new Promise(resolve => { release = resolve; });
      return result;
    });
    try {
      const run = begin('approve', `proof-race-${operation}`);
      await until(() => controller.getRun(run).status === 'waiting_for_approval');
      const approval = controller.events(run, 0).events.find(e => e.event === 'approval.request')!;
      controller.approve(run, { request_id: approval.request_id, choice: 'once' });
      await until(() => !!release);
      const input = { operation, requestId: randomUUID(), text: operation === 'queue' ? 'Race fixture queue' : 'rejected correction' };
      if (operation === 'queue') await controller.nativeControl(run, input);
      else await expect(controller.nativeControl(run, input)).rejects.toMatchObject({ status: 409 });
      release!({ session_id: 'runtime-stored-1', settled: true });
      await until(() => observed >= 2);
      if (operation === 'queue') {
        expect(controller.getRun(run).status).toBe('running');
        expect(controller.events(run, 0).events.some(e => e.event === 'run.completed')).toBe(false);
        const view = await controller.nativeView(run); expect(view.queued).toBe('');
        await controller.nativeControl(run, { operation: 'answer', requestId: view.prompts[0].id, answer: { value: 'synthetic-protected' } });
        await settled(run); expect(controller.getRun(run).status).toBe('completed');
      } else {
        await settled(run); expect(controller.getRun(run).status).toBe('completed');
      }
    } finally { spy.mockRestore(); }
  });
  it("transports current AI SDK tagged file parts over the real private controller IPC", async () => {
    running = await listenController(controller);
    const model = new HermesLanguageModel('native', { target: { baseUrl: LOCAL_ORIGIN, profile: binding.bindingId, apiKey: '', local: true, fetch: socketFetch(config.socketPath) }, sessionId, sessionKey: null, interactive: true, approvalTimeoutSec: 30 });
    const result = streamText({ model, messages: [{ role: 'user', content: [
      { type: 'text', text: 'Inspect attached file' },
      { type: 'file', data: Buffer.from('synthetic-text'), filename: 'fixture.txt', mediaType: 'text/plain' },
    ] }] });
    expect(await result.text).toBe('Fixture answer');
    const staged = JSON.parse((await readFile(path.join(config.profileHome, 'fixture-attachments.jsonl'), 'utf8')).trim());
    expect(staged).toMatchObject({ method: 'file.attach', name: 'fixture.txt', content: 'data:text/plain;base64,' + Buffer.from('synthetic-text').toString('base64') });
  });
  it("rejects attachment paths and provider URLs before any native work", async () => {
    expect(() => controller.begin(binding.bindingId, { input: 'bad', session_id: sessionId, attachments: [{ name: '../escape', mediaType: 'text/plain', contentBase64: 'eA==' }] }, 'bad-file')).toThrow();
    expect(() => newestNativeAttachments([{ role: 'user', content: [{ type: 'file', data: { type: 'url', url: new URL('https://example.com/private') }, mediaType: 'text/plain' }] }])).toThrow('cannot fetch');
    await expect(readFile(path.join(config.profileHome, 'fixture-prompts.jsonl'))).rejects.toThrow();
  });
  it("resumes durable native sessions after engine and controller restart without replaying the old turn", async () => {
    const one = begin("first", "receipt-first"); await settled(one); await controller.stop();
    controller = new LocalController(config); await controller.start();
    expect(begin("first", "receipt-first")).toBe(one);
    const two = begin("second", "receipt-second"); await settled(two);
    const sent = (await readFile(path.join(config.profileHome, "fixture-prompts.jsonl"), "utf8")).trim().split("\n").map(v => JSON.parse(v));
    expect(sent.map(v => v.text)).toEqual(["first", "second"]);
    expect(sent[1].session).toBe("resumed-stored-1");
    expect(JSON.parse((await readFile(path.join(config.profileHome, 'fixture-resumes.jsonl'), 'utf8')).trim())).toEqual({session_id:'stored-1'});
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
    for (const change of [{ visibility: "org" }, { id: "copy" }, { executionMode: "service" }, { ownerId: "other" }, { coordinatorEligible: true }, { isCoordinator: true }])
      await expect(assertLocalBot(principal, app, { ...bot, ...change } as Bot)).rejects.toThrow("private");
    await expect(assertLocalBot({ ...principal, isAdmin: false }, app, bot)).rejects.toThrow();
    expect(() => guardLocalBotMutation(app, bot.id, { ...bot, appId: "other" })).toThrow();
    expect(() => guardLocalBotMutation(app, bot.id, null)).toThrow("retains");
  });
});
