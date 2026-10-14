import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { PersonalCodexRuntimeDriver } from './driver';
import { ComputerInputSchema, type ComputerViewStatus } from '../lib/computer/contracts';
import type { AdminRuntime } from './admin-contracts';

export const COMPUTER_LEASE_MS = 30_000;
const MAX_FRAME_BYTES = 512 * 1024;
const MAX_BODY_BYTES = 20_000;
const viewSession = z.string().regex(/^[a-f0-9]{64}$/);
const controlAction = z.object({ action: z.enum(['takeover', 'release', 'heartbeat']) }).strict();
const pausedRecord = z.object({ version: z.literal(1), paused: z.boolean() }).strict();

export class ComputerError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
type OwnerState = {
  paused: boolean;
  lease?: { session: string; until: number };
  lastFrameAt: string | null;
  sequence: number;
  lastInput: number;
};

/** Host-owned control lease. No session selectors, credentials or input text are persisted. */
export class ComputerController {
  private states = new Map<string, OwnerState>();
  private loading = new Map<string, Promise<OwnerState>>();
  private queues = new Map<string, Promise<unknown>>();
  private operations = new Map<string, number>();
  private captures = new Map<string, Promise<{ bytes: Buffer; capturedAt: string; sequence: number }>>();
  constructor(private driver: PersonalCodexRuntimeDriver, private now = Date.now) {}

  private path(owner: string) {
    this.driver.name(owner); // Operator admission precedes disk access and runtime commands.
    const key = createHash('sha256').update(owner).digest('hex');
    return join(dirname(this.driver.config.socketPath), `computer-${key}.json`);
  }
  private async state(owner: string) {
    const path = this.path(owner);
    let state = this.states.get(owner);
    if (!state) {
      let pending = this.loading.get(owner);
      if (!pending) {
        pending = (async () => {
          const file = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (file && (!file.isFile() || file.isSymbolicLink() || file.mode & 0o077 || file.size > 256))
            throw new ComputerError(503, 'Computer control needs operator reconciliation.');
          const paused = file ? pausedRecord.parse(JSON.parse(await readFile(path, 'utf8'))).paused : false;
          const loaded: OwnerState = { paused, lastFrameAt: null, sequence: 0, lastInput: 0 };
          this.states.set(owner, loaded);
          return loaded;
        })();
        this.loading.set(owner, pending);
      }
      try { state = await pending; }
      finally { if (this.loading.get(owner) === pending) this.loading.delete(owner); }
    }
    if (state.lease && state.lease.until <= this.now()) state.lease = undefined;
    return state;
  }
  private async persist(owner: string, paused: boolean) {
    const path = this.path(owner);
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ version: 1, paused }), { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  }
  /** Reapply durable takeover intent before the broker accepts bridges or input. */
  async reconcilePersistedPauses(owners: readonly string[]) {
    for (const owner of owners) {
      const state = await this.state(owner);
      if (!state.paused) continue;

      // A missing or stopped runtime has nothing to suspend. Keep the durable fence in place;
      // only an explicit disconnect may clear it.
      const runtime = await this.driver.inspect(owner);
      if (!runtime?.State.Running) continue;

      try {
        await this.driver.computerPause(owner, true);
      } catch (pauseError) {
        // If physical suspension cannot be restored, stop the runtime and verify it is gone.
        // Never clear the durable intent here, even after a successful stop.
        if (!this.driver.stop) throw pauseError;
        await this.driver.stop(owner);
        if ((await this.driver.inspect(owner))?.State.Running)
          throw new ComputerError(503, 'A paused computer could not be safely reconciled.');
      }
    }
  }
  private async serial<T>(owner: string, work: () => Promise<T>): Promise<T> {
    this.driver.name(owner);
    const prior = this.queues.get(owner) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(work);
    this.queues.set(owner, next);
    try { return await next; } finally { if (this.queues.get(owner) === next) this.queues.delete(owner); }
  }
  async assertAgentControl(owner: string) {
    // Wait for an in-flight pause/resume before admitting a new app-server bridge.
    await this.queues.get(owner)?.catch(() => {});
    if ((await this.state(owner)).paused) throw new ComputerError(409, 'Return computer control before starting another agent operation.');
  }
  async agentBridge(owner: string) {
    return this.serial(owner, async () => {
      if ((await this.state(owner)).paused) throw new ComputerError(409, 'Return computer control before starting another agent operation.');
      return this.driver.bridge(owner);
    });
  }
  async agentOperation<T>(owner: string, work: () => Promise<T>, options: { revokePaused?: boolean } = {}): Promise<T> {
    // Reserve admission, then release the queue: account operations connect back through agentBridge.
    await this.serial(owner, async () => {
      const state = await this.state(owner);
      if (state.paused) {
        if (!options.revokePaused) throw new ComputerError(409, 'Return computer control before starting another agent operation.');
        // A paused token supervisor cannot service clear-token. Erase its memory by stopping
        // the runtime, without resuming either automation or the user's desktop session.
        if (!this.driver.stop) throw new ComputerError(503, 'The paused runtime needs operator reconciliation.');
        state.lease = undefined;
        await this.driver.stop(owner);
        if ((await this.driver.inspect(owner))?.State.Running) throw new ComputerError(503, 'The paused runtime could not be stopped.');
        await this.persist(owner, false);
        state.paused = false;
        state.lastFrameAt = null;
      }
      this.operations.set(owner, (this.operations.get(owner) ?? 0) + 1);
    });
    try { return await work(); }
    finally {
      const remaining = (this.operations.get(owner) ?? 1) - 1;
      if (remaining) this.operations.set(owner, remaining); else this.operations.delete(owner);
    }
  }
  /** Administrative stop/delete invalidates the human lease and fences input until the guest is stopped. */
  async stopRuntime(owner: string, work: () => Promise<void>) {
    return this.serial(owner, async () => {
      if (this.operations.get(owner)) throw new ComputerError(409, 'An account operation is in progress. Retry after it finishes.');
      const state = await this.state(owner);
      state.lease = undefined;
      state.paused = true;
      await this.persist(owner, true);
      try {
        await work();
        if ((await this.driver.inspect(owner))?.State.Running) throw new ComputerError(503, 'The computer could not be stopped.');
      } catch (error) {
        // An uncertain stop never reopens admission. Preserve durable intent and try to suspend
        // any surviving process tree; a failed host operation still needs operator reconciliation.
        try { if ((await this.driver.inspect(owner))?.State.Running) await this.driver.computerPause(owner, true); } catch {}
        throw error;
      }
      await this.persist(owner, false);
      state.paused = false;
      state.lastFrameAt = null;
    });
  }
  /** Operational metadata only: no viewer session identifier, screenshot, or personal input. */
  async adminStatus(owner: string): Promise<AdminRuntime['computer']> {
    const state = await this.state(owner);
    const runtime = await this.driver.computerStatus(owner);
    return { available: runtime.available && runtime.running, paused: state.paused,
      control: !runtime.available || !runtime.running ? 'unavailable' : state.paused ? state.lease ? 'human' : 'paused' : 'agent',
      lastFrameAt: runtime.running ? state.lastFrameAt : null };
  }
  async agentFrame(owner: string) {
    return this.serial(owner, async () => {
      if ((await this.state(owner)).paused) throw new ComputerError(409, 'The user is controlling this computer.');
      return this.frame(owner, '0'.repeat(64));
    });
  }
  async agentInput(owner: string, value: unknown) {
    const input = ComputerInputSchema.parse(value);
    return this.serial(owner, async () => {
      const state = await this.state(owner);
      if (state.paused) throw new ComputerError(409, 'The user is controlling this computer.');
      if (state.lastInput && this.now() - state.lastInput < 40) throw new ComputerError(429, 'Computer input is arriving too quickly.');
      state.lastInput = this.now();
      await this.driver.computerInput(owner, input);
    });
  }
  async status(owner: string, session: string): Promise<ComputerViewStatus> {
    viewSession.parse(session);
    const state = await this.state(owner);
    const runtime = await this.driver.computerStatus(owner);
    return {
      available: runtime.available, state: !runtime.available ? 'unavailable' : runtime.running ? 'running' : 'stopped',
      control: !state.paused ? 'agent' : state.lease?.session === session ? 'you' : 'other',
      paused: state.paused, lastFrameAt: runtime.running ? state.lastFrameAt : null,
      width: 1280, height: 800,
      ...(!runtime.available ? { reason: 'This runtime does not have a computer view installed.' } :
        state.paused && !state.lease ? { reason: 'The computer remains paused. Take over, then return control when ready.' } : {}),
    };
  }
  async control(owner: string, session: string, input: unknown) {
    viewSession.parse(session);
    const { action } = controlAction.parse(input);
    return this.serial(owner, async () => {
      const state = await this.state(owner);
      const runtime = await this.driver.computerStatus(owner);
      if (!runtime.available || !runtime.running) throw new ComputerError(409, 'The computer is not running.');
      if (action === 'takeover') {
        if (this.operations.get(owner)) throw new ComputerError(409, 'An account operation is in progress. Try taking control again.');
        if (state.lease && state.lease.session !== session) throw new ComputerError(409, 'Another view is controlling this computer.');
        // Durable intent and admission fence precede suspension. Failure remains paused, never grants input.
        state.paused = true;
        state.lease = undefined;
        await this.persist(owner, true);
        await this.driver.computerPause(owner, true);
        state.lease = { session, until: this.now() + COMPUTER_LEASE_MS };
      } else {
        if (!state.paused || state.lease?.session !== session) throw new ComputerError(409, 'Take over this computer before controlling it.');
        if (action === 'heartbeat') state.lease.until = this.now() + COMPUTER_LEASE_MS;
        else {
          state.lease = undefined;
          await this.driver.computerPause(owner, false);
          try { await this.persist(owner, false); }
          catch (error) {
            // If bookkeeping fails after resumption, restore physical suspension before reporting failure.
            await this.driver.computerPause(owner, true);
            throw error;
          }
          state.paused = false;
        }
      }
      return this.status(owner, session);
    });
  }
  async input(owner: string, session: string, value: unknown) {
    viewSession.parse(session);
    const input = ComputerInputSchema.parse(value);
    await this.serial(owner, async () => {
      const state = await this.state(owner);
      if (!state.paused || state.lease?.session !== session) throw new ComputerError(409, 'Take over this computer before sending input.');
      if (state.lastInput && this.now() - state.lastInput < 40) throw new ComputerError(429, 'Computer input is arriving too quickly.');
      state.lastInput = this.now();
      await this.driver.computerInput(owner, input);
    });
  }
  async frame(owner: string, session: string) {
    viewSession.parse(session);
    const state = await this.state(owner);
    const existing = this.captures.get(owner);
    if (existing) return existing;
    const capture = (async () => {
      const bytes = await this.driver.computerFrame(owner);
      if (bytes.length < 4 || bytes.length > MAX_FRAME_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9)
        throw new ComputerError(503, 'The computer frame is unavailable.');
      state.lastFrameAt = new Date(this.now()).toISOString();
      return { bytes, capturedAt: state.lastFrameAt, sequence: ++state.sequence };
    })();
    this.captures.set(owner, capture);
    try { return await capture; }
    finally { if (this.captures.get(owner) === capture) this.captures.delete(owner); }
  }
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new ComputerError(413, 'Computer request is too large.');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ComputerError(400, 'Invalid computer request.'); }
}

/** Only mounted on the existing protected personal-Codex Unix socket. */
export async function handleComputerRequest(controller: ComputerController, req: IncomingMessage, res: ServerResponse, owner: string) {
  const reply = (value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  try {
    // These routes are private broker IPC, never browser-facing routes. The server already admitted the owner.
    if (req.method === 'GET' && req.url === '/computer/agent/status') return reply(await controller.status(owner, '0'.repeat(64)));
    if (req.method === 'GET' && req.url === '/computer/agent/frame') {
      const frame = await controller.agentFrame(owner);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': frame.bytes.length });
      return res.end(frame.bytes);
    }
    if (req.method === 'POST' && req.url === '/computer/agent/input') {
      await controller.agentInput(owner, await readBody(req));
      res.writeHead(204, { 'Cache-Control': 'no-store' }); return res.end();
    }
    const session = viewSession.parse(req.headers['x-collective-view-session']);
    if (req.method === 'GET' && req.url === '/computer/status') return reply(await controller.status(owner, session));
    if (req.method === 'GET' && req.url === '/computer/frame') {
      const frame = await controller.frame(owner, session);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Computer-Captured-At': frame.capturedAt,
        'X-Computer-Sequence': String(frame.sequence), 'Content-Length': frame.bytes.length });
      return res.end(frame.bytes);
    }
    if (req.method === 'POST' && req.url === '/computer/control') return reply(await controller.control(owner, session, await readBody(req)));
    if (req.method === 'POST' && req.url === '/computer/input') {
      await controller.input(owner, session, await readBody(req));
      res.writeHead(204, { 'Cache-Control': 'no-store' }); return res.end();
    }
    reply({ error: 'Unknown computer operation.' }, 404);
  } catch (error) {
    // Native stdout/stderr, credentials, and typed input must never enter public errors or logs.
    const code = error instanceof ComputerError ? error.status : error instanceof z.ZodError ? 400 : 503;
    reply({ error: error instanceof ComputerError ? error.message : 'Computer operation unavailable.' }, code);
  }
}
