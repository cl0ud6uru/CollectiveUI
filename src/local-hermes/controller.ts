import { randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { z } from "zod";
import { assertNoOtherHermes, installationId, HERMES_RELEASE, validateInstallation, type ControllerConfig } from "./config";
import { NativeRpc, object, string, type RpcFrame, type RpcObject, type RpcTransport } from "./rpc";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
export const PairInput = z.object({ runtimeId: id, ownerId: id, name: z.string().trim().min(1).max(80),
  exclusive: z.literal(true), model: z.string().max(200).regex(/^[A-Za-z0-9_./:-]*$/).default(""),
  provider: z.string().max(100).regex(/^[A-Za-z0-9_:-]*$/).default("") }).strict()
  .refine(v => !!v.model === !!v.provider, "Choose both a provider and model, or leave both blank for the native profile default");
const Binding = z.object({ bindingId: id, ownerId: id, botId: id, appId: id, name: z.string(), model: z.string(), provider: z.string() });
export type LocalBinding = z.infer<typeof Binding>;
const Stored = z.object({ runtimeId: id, binding: Binding.optional(), sessions: z.record(z.string(), z.string()),
  receipts: z.record(z.string(), z.object({ runId: id, sessionKey: z.string(), status: z.enum(["running", "completed", "failed", "cancelled", "interrupted"]) })) });
type Stored = z.infer<typeof Stored>;
export type LocalEvent = { event: string; [key: string]: unknown };
type LocalRun = { id: string; receipt: string; sessionKey: string; nativeId?: string; status: string; cancel: boolean;
  output?: string; error?: string; events: LocalEvent[]; bytes: number; seq: number;
  approvals: Map<string, { nativeId: string | number; toolId?: string }>; tools: Map<string, string>; syntheticApproval?: string;
  usageBefore?: RpcObject; runtime: RpcObject; timer?: NodeJS.Timeout; cancelTimer?: NodeJS.Timeout };

export class LocalError extends Error { constructor(public status: number, message: string) { super(message); } }
const key = () => randomUUID().replaceAll("-", "");
const active = (r: LocalRun) => r.status === "running" || r.status === "waiting_for_approval";

/** Sole engine owner. Persistent file contains IDs/admission receipts only, never transcripts or credentials. */
export class LocalController {
  readonly changes = new EventEmitter();
  readonly runtimeId: string;
  private stored: Stored;
  private rpc?: NativeRpc;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private profileLock = false;
  private runs = new Map<string, LocalRun>();
  private liveSessions = new Map<string, string>();
  private error: string | null = null;
  private storageFailed = false;
  private stateFile: string;
  constructor(readonly config: ControllerConfig, private container?: { validate: () => Promise<void>; transport: () => RpcTransport }) {
    this.runtimeId = installationId(config);
    this.stateFile = path.join(config.stateDir, "bindings.json");
    try { this.stored = Stored.parse(JSON.parse(readFileSync(this.stateFile, "utf8"))); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Controller metadata is unreadable. Restore its original mapping; do not reset it to retry a turn.");
      this.stored = { runtimeId: this.runtimeId, sessions: {}, receipts: {} };
    }
    if (this.stored.runtimeId !== this.runtimeId) throw new Error("Installation changed. Restore the original controller paths; retained bindings cannot move to another profile.");
  }
  private save() {
    this.assertStorage();
    try {
    const temp = `${this.stateFile}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.stored), { mode: 0o600, flag: "w" });
    const fd = openSync(temp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, this.stateFile);
    const dir = openSync(this.config.stateDir, "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
    } catch {
      this.storageFailed = true;
      this.error = "Controller metadata could not be persisted. The engine is being stopped. Repair storage and restart the controller; do not resend uncertain work or erase its receipts.";
      void this.rpc?.stop().catch(() => {});
      throw new LocalError(503, this.error);
    }
  }
  private assertStorage() {
    if (this.storageFailed) throw new LocalError(503, this.error ?? "Controller storage needs repair and restart");
  }
  status() {
    return { runtimeId: this.runtimeId, label: this.config.label, release: HERMES_RELEASE,
      status: this.stopping ? "stopping" : this.starting ? "starting" : this.rpc?.alive ? "ready" : "stopped",
      error: this.error, binding: this.stored.binding ?? null,
      capabilities: ["text", "native-sessions", "approve-once", "deny", "stop"],
      trust: "Single trusted administrator; exclusive profile; direct text chats only" };
  }
  pair(raw: unknown) {
    this.assertStorage();
    const input = PairInput.parse(raw);
    if (input.runtimeId !== this.runtimeId) throw new LocalError(409, "The detected installation changed. Refresh before pairing.");
    if (!this.rpc?.alive) throw new LocalError(409, "Start the selected installation before pairing.");
    const existing = this.stored.binding;
    if (existing) {
      if (existing.ownerId !== input.ownerId || existing.model !== input.model || existing.provider !== input.provider)
        throw new LocalError(409, "This profile is already paired. Its owner and model binding cannot be replaced.");
      return existing;
    }
    const binding = { bindingId: key(), ownerId: input.ownerId, botId: key(), appId: key(), name: input.name, model: input.model, provider: input.provider };
    this.stored.binding = binding;
    this.save(); return binding;
  }
  assertBinding(bindingId: string) {
    if (this.stored.binding?.bindingId !== bindingId) throw new LocalError(403, "This bot is not paired with this local runtime.");
    return this.stored.binding;
  }
  async start() {
    this.assertStorage();
    if (this.starting) return this.starting;
    if (this.stopping) throw new LocalError(409, "Native Hermes is stopping. Refresh when it has ended.");
    if (this.rpc?.alive) { await this.rpc.call("ping"); return; }
    this.starting = this.startInner();
    try { await this.starting; } finally { this.starting = undefined; }
  }
  private async startInner() {
    this.error = null;
    try {
      if (this.container) {
        await this.container.validate();
      } else {
      const detected = await validateInstallation(this.config);
      if (installationId(detected) !== this.runtimeId) throw new LocalError(409, "Installation paths changed. Restore the selected canonical profile before restarting.");
      // Shared canonical profile lock also rejects controllers with different metadata/socket directories.
      const lock = await open(path.join(this.config.profileHome, ".collectiveui-owner.lock"), "wx", 0o600)
        .catch(() => { throw new LocalError(409, "Profile ownership is locked. Stop its existing controller. After a crash, verify all Hermes processes have exited before the operator removes .collectiveui-owner.lock."); });
      this.profileLock = true;
      await lock.writeFile(JSON.stringify({ controllerPid: process.pid, runtimeId: this.runtimeId })); await lock.close();
      await assertNoOtherHermes(this.config);
      }
      this.rpc = new NativeRpc(this.config, f => this.onFrame(f), () => this.onExit(), () => this.cleanupFailed(), this.container?.transport());
      await this.rpc.start();
      // Only after exclusive startup proves there is no previous live owner can old receipts settle interrupted.
      for (const receipt of Object.values(this.stored.receipts)) if (receipt.status === "running") receipt.status = "interrupted";
      this.save();
    } catch (e) {
      this.error = e instanceof Error ? e.message : "Native Hermes could not start";
      await this.rpc?.stop(); await this.releaseProfileLock(); throw e;
    }
  }
  async reconnect() {
    this.assertStorage();
    if (!this.rpc?.alive) throw new LocalError(409, "The engine is stopped. Use Start to reopen the existing profile.");
    await this.rpc.call("ping");
  }
  private async releaseProfileLock() {
    if (!this.profileLock) return;
    await unlink(path.join(this.config.profileHome, ".collectiveui-owner.lock")); this.profileLock = false;
  }
  async stop() {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      await this.starting?.catch(() => {});
      await this.rpc?.stop(); await this.releaseProfileLock();
    })();
    try { await this.stopping; } finally { this.stopping = undefined; }
  }
  private cleanupFailed() {
    this.error = "Owned Hermes process cleanup could not be confirmed. Ownership remains locked; the operator must reconcile all runtime processes before restarting.";
  }
  private halt() {
    void this.stop().catch(() => this.cleanupFailed());
  }
  private onExit() {
    if (!this.stopping && !this.error) this.error = "Native Hermes exited. Use Stop to release its confirmed ended process, then Start to reconnect to the saved profile.";
    this.liveSessions.clear();
    if (this.storageFailed) {
      for (const r of this.runs.values()) { clearTimeout(r.timer); clearTimeout(r.cancelTimer); }
      return; // do not turn an uncertain metadata outcome into a confirmed terminal receipt
    }
    for (const r of this.runs.values()) if (active(r)) this.finish(r, "interrupted", "Native Hermes stopped. Its native session is retained; this turn was not retried.");
    // The explicit Stop/Start error path releases ownership. Unexpected exits retain a fail-closed lock.
  }
  private settingsHold = false;
  /** Close admission synchronously before checking active work, including pending approvals. */
  holdForSettings() {
    if (this.settingsHold || this.starting || this.stopping || [...this.runs.values()].some(active))
      throw new LocalError(409, 'A profile in your runtime has unfinished work. Finish or stop its turn before changing settings.');
    this.settingsHold = true;
    return () => { this.settingsHold = false; };
  }
  begin(bindingId: string, raw: unknown, receipt: string) {
    if (this.settingsHold) throw new LocalError(409, 'Profile settings are being updated or tested. Try again after they settle.');
    this.assertStorage();
    const binding = this.assertBinding(bindingId);
    const input = z.object({ input: z.string().min(1).max(64000), session_id: id, instructions: z.string().max(128000).optional(), model: z.never().optional() }).strict().parse(raw);
    id.parse(receipt);
    const previous = this.stored.receipts[receipt];
    if (previous) {
      if (previous.sessionKey !== input.session_id) throw new LocalError(409, "This admission receipt belongs to another session");
      return previous.runId;
    }
    if (!this.rpc?.alive || this.starting || this.stopping) throw new LocalError(409, "Start your native runtime before chatting. Personal Docker runtimes are in Settings → Connected accounts.");
    if ([...this.runs.values()].some(active)) throw new LocalError(429, "This personal Hermes profile already has an unfinished turn. Finish its approval or stop it first.");
    if (Object.keys(this.stored.receipts).length >= 10000 || Object.keys(this.stored.sessions).length >= 1000)
      throw new LocalError(409, "Pilot metadata capacity reached. Ask the operator to archive this pilot; receipts are retained to prevent duplicate execution.");
    const runId = `run_${key()}`;
    const r: LocalRun = { id: runId, receipt, sessionKey: input.session_id, status: "running", cancel: false, events: [], bytes: 0, seq: 0,
      approvals: new Map(), tools: new Map(), runtime: {} };
    this.runs.set(runId, r);
    this.stored.receipts[receipt] = { runId, sessionKey: input.session_id, status: "running" };
    this.save(); // Write-ahead admission: an uncertain prompt is never silently resubmitted.
    r.timer = setTimeout(() => { this.error = "Local turn exceeded the 30-minute pilot limit."; this.halt(); }, 30 * 60_000);
    const admittedRpc = this.rpc;
    void this.submit(r, input.input, binding).catch(() => {
      // An old request can reject after Stop completed and a new gateway started.
      if (this.rpc !== admittedRpc || !active(r)) return;
      this.error = "Hermes could not admit or resume this turn. Check its native profile logs. Stop and Start before continuing; no automatic retry was made.";
      // A timeout may have accepted the prompt. Stop our owned process before declaring the turn over.
      this.halt();
    });
    return runId;
  }
  private async submit(r: LocalRun, text: string, binding: LocalBinding) {
    const rpc = this.rpc!;
    let runtime = this.liveSessions.get(r.sessionKey);
    if (!runtime) {
      const storedId = this.stored.sessions[r.sessionKey];
      const response = storedId
        ? await rpc.call("session.resume", { session_id: storedId })
        : await rpc.call("session.create", { cwd: this.config.workDir, ...(binding.model ? { model: binding.model, provider: binding.provider } : {}) });
      const info = object(response.info);
      const durableId = string(response.stored_session_id) || string(info.stored_session_id) || string(response.session_key);
      if (info.desktop_contract !== 8 || !string(response.session_id) || !durableId) throw new Error("Unsupported native session contract");
      // Never attach to auto-continued or already running native work we did not admit.
      if (response.running === true || response.status === "streaming" || response.auto_continue) throw new Error("Native session is already running");
      runtime = string(response.session_id);
      // Hermes may follow the compression continuation of our own stored session. Native lineage is authoritative.
      this.stored.sessions[r.sessionKey] = durableId;
      this.save(); this.liveSessions.set(r.sessionKey, runtime);
      r.runtime = { model: string(info.model), provider: string(info.provider) };
    }
    r.nativeId = runtime;
    if (!active(r)) return;
    if (r.cancel) { this.finish(r, "cancelled"); return; }
    // Gateway usage is cumulative. Capture a baseline, not a made-up per-turn count.
    r.usageBefore = object(await rpc.call("session.usage", { session_id: runtime }));
    if (!active(r)) return;
    if (r.cancel) { this.finish(r, "cancelled"); return; }
    const response = await rpc.call("prompt.submit", { session_id: runtime, text });
    if (response.status !== "streaming") throw new Error("Native gateway did not exclusively admit this turn");
    if (r.cancel && active(r)) await this.cancel(r.id);
  }
  private emit(r: LocalRun, e: LocalEvent) {
    const bytes = Buffer.byteLength(JSON.stringify(e));
    if (r.bytes + bytes > 4 * 1024 * 1024 || r.events.length >= 10000) {
      this.error = "Local turn exceeded the pilot event limit; engine stopped to prevent untracked work.";
      this.halt(); return;
    }
    r.events.push({ ...e, _seq: String(++r.seq) }); r.bytes += bytes; this.changes.emit(r.id);
  }
  private finish(r: LocalRun, status: "completed" | "failed" | "cancelled" | "interrupted", error?: string, extra: RpcObject = {}) {
    if (!active(r)) return;
    r.status = status; r.error = error; r.approvals.clear(); clearTimeout(r.timer); clearTimeout(r.cancelTimer);
    this.stored.receipts[r.receipt].status = status; this.save();
    this.emit(r, { event: `run.${status}`, error, output: r.output, runtime: r.runtime, ...extra });
    this.changes.emit(r.id);
    // Retain bounded display replay in RAM only; durable transcript belongs to Hermes.
    const ended = [...this.runs.values()].filter(v => !active(v));
    for (const old of ended.slice(0, -20)) this.runs.delete(old.id);
  }
  private onFrame(f: RpcFrame) {
    const p = object(f.params), payload = object(p.payload);
    if (f.method === "event" && p.type === "session.info" && string(payload.stored_session_id)) {
      const mapping = [...this.liveSessions].find(([, nativeId]) => nativeId === p.session_id);
      if (mapping) { this.stored.sessions[mapping[0]] = string(payload.stored_session_id); this.save(); }
    }
    const r = [...this.runs.values()].find(v => active(v) && v.nativeId === p.session_id);
    if (f.id !== undefined && f.method) {
      if (f.method !== "approval" || !r) {
        this.rpc?.answer(f.id);
        if (r) { this.error = `Native interaction '${string(f.method).slice(0, 60)}' is not supported in this pilot. Use Hermes directly after stopping the controller.`; this.halt(); }
        return;
      }
      if (r.cancel) { this.rpc?.answer(f.id, { choice: "deny" }); return; }
      const candidates = [...r.tools].filter(([, name]) => name === (string(p.tool_name) || "terminal"));
      if (candidates.length > 1) { this.rpc?.answer(f.id, { choice: "deny" }); this.error = "Concurrent native approvals could not be paired safely; engine stopped."; this.halt(); return; }
      const requestId = key();
      let toolId = candidates[0]?.[0];
      if (!toolId) {
        toolId = `approval_${requestId}`; r.syntheticApproval = toolId;
        this.emit(r, { event: "tool.started", tool: "approval", tool_id: toolId, preview: string(p.command) });
      }
      r.approvals.set(requestId, { nativeId: f.id, toolId }); r.status = "waiting_for_approval";
      this.emit(r, { event: "approval.request", request_id: requestId, tool_id: toolId, command: string(p.command), description: string(p.description) });
      return;
    }
    if (f.method !== "event" || !r) return;
    switch (p.type) {
      case "error":
        this.error = "Native Hermes reported a session error. The owned engine was stopped; check the profile logs before restarting.";
        this.halt(); break;
      case "message.delta": this.emit(r, { event: "message.delta", delta: string(payload.text) }); break;
      case "session.info":
        r.runtime = { model: string(payload.model), provider: string(payload.provider) };
        if (string(payload.stored_session_id)) { this.stored.sessions[r.sessionKey] = string(payload.stored_session_id); this.save(); }
        break;
      case "tool.start": {
        const toolId = string(payload.tool_id), name = string(payload.name);
        if (!toolId || !name) break;
        r.tools.set(toolId, name);
        this.emit(r, { event: "tool.started", tool: name, tool_id: toolId, preview: JSON.stringify(payload.args ?? payload.context ?? "").slice(0, 16000) }); break;
      }
      case "tool.complete": {
        const toolId = string(payload.tool_id), name = r.tools.get(toolId);
        if (!name) break;
        r.tools.delete(toolId);
        this.emit(r, { event: "tool.completed", tool: name, tool_id: toolId, preview: JSON.stringify(payload.result ?? payload.summary ?? "").slice(0, 32000), duration: payload.duration_s, error: !!object(payload.result).error }); break;
      }
      case "request.cancel": {
        for (const [id, pending] of r.approvals) if (pending.nativeId === payload.id) r.approvals.delete(id);
        if (!r.approvals.size) r.status = "running";
        break;
      }
      case "message.complete": {
        r.output = string(payload.text);
        const usage = object(payload.usage), baseline = object(r.usageBefore?.usage ?? r.usageBefore);
        const counts: RpcObject = {};
        for (const [native, target] of [["input", "input_tokens"], ["output", "output_tokens"]]) {
          if (typeof usage[native] === "number" && typeof baseline[native] === "number" && Number(usage[native]) >= Number(baseline[native])) counts[target] = Number(usage[native]) - Number(baseline[native]);
        }
        if (string(usage.model)) r.runtime.model = usage.model;
        if (r.syntheticApproval) this.emit(r, { event: "tool.completed", tool: "approval", tool_id: r.syntheticApproval, preview: JSON.stringify({ status: "settled", note: "Native approval interaction ended. See Hermes tool results for execution outcome." }) });
        if (payload.status === "complete" && !payload.partial) this.finish(r, "completed", undefined, { usage: counts });
        else if (payload.status === "interrupted") this.finish(r, "cancelled");
        else this.finish(r, "failed", "The native Hermes turn did not complete. Check its profile logs and provider configuration.");
        break;
      }
    }
  }
  getRun(runId: string) {
    this.assertStorage();
    const r = this.runs.get(runId);
    if (r) return { run_id: r.id, status: r.status, output: r.output, error: r.error };
    const receipt = Object.values(this.stored.receipts).find(v => v.runId === runId);
    if (!receipt) throw new LocalError(404, "Unknown local run");
    if (receipt.status === "running") throw new LocalError(409, "Controller restarted with uncertain work. Restore exclusive engine ownership and Start before continuing.");
    // Retained receipt proves admission/outcome, not retained output. Never fabricate a successful answer.
    return { run_id: runId, status: receipt.status === "completed" ? "failed" : receipt.status,
      error: "Turn replay expired. The transcript remains in Hermes; do not resend this admission." };
  }
  events(runId: string, after: number) {
    this.assertStorage();
    const r = this.runs.get(runId);
    if (!r) throw new LocalError(404, "Local replay is unavailable; check the retained run receipt");
    if (!Number.isSafeInteger(after) || after < 0 || after > r.seq) throw new LocalError(400, "Invalid replay cursor");
    return { events: r.events.filter(e => Number(e._seq) > after), ended: !active(r) };
  }
  approve(runId: string, raw: unknown) {
    this.assertStorage();
    const { request_id, choice } = z.object({ request_id: id, choice: z.enum(["once", "deny"]) }).strict().parse(raw);
    const r = this.runs.get(runId), pending = r?.approvals.get(request_id);
    if (!r || !pending || !active(r) || r.cancel || !this.rpc?.alive) throw new LocalError(409, "This native approval expired or was withdrawn");
    r.approvals.delete(request_id); r.status = r.approvals.size ? "waiting_for_approval" : "running";
    this.rpc.answer(pending.nativeId, { choice });
  }
  async cancel(runId: string) {
    const r = this.runs.get(runId);
    if (!r) { this.getRun(runId); return; }
    if (!active(r)) return;
    r.cancel = true;
    r.cancelTimer ??= setTimeout(() => {
      this.error = "Hermes did not settle cancellation within 5 seconds. The controller stopped its owned engine; the native session is retained.";
      this.halt();
    }, 5000);
    for (const pending of r.approvals.values()) this.rpc?.answer(pending.nativeId, { choice: "deny" });
    r.approvals.clear();
    if (r.nativeId) await this.rpc?.call("session.interrupt", { session_id: r.nativeId }, 8000);
    // Completion event (or explicit process shutdown), never RPC acknowledgement, confirms cancellation.
  }
}
