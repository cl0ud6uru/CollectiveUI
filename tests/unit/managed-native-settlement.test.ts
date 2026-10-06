import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalController } from '@/local-hermes/controller';
import type { RpcFrame, RpcObject, RpcTransport } from '@/local-hermes/rpc';

// Exercise the actual controller and stdio mapper without Linux process ownership or sockets.
// The duplicate acknowledgment and post-error follow-up contracts are checked against the
// actual pinned Python helpers in tests/fixtures/hermes-native-queue-contract.py.
class NativeFixture {
  readonly sessionId = 'owned-runtime';
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly child = Object.assign(new EventEmitter(), {
    stdout: this.stdout, stderr: this.stderr,
    stdin: new Writable({ write: (chunk, _encoding, done) => { this.receive(JSON.parse(chunk.toString())); done(); } }),
  }) as unknown as ChildProcessWithoutNullStreams;
  readonly transport: RpcTransport = {
    spawn: () => { queueMicrotask(() => this.event('gateway.ready')); return this.child; },
    stop: async () => { await Promise.resolve(); this.stops++; this.child.emit('exit', 0, null); },
  };
  submissions = 0;
  proofCalls = 0;
  stops = 0;
  workerSettled = true;
  activeText = '';
  queued?: string;
  pendingInput = false;
  proof: () => RpcObject | Promise<RpcObject> = () => ({ session_id: this.sessionId, settled: this.workerSettled && !this.queued && !this.pendingInput });

  private send(frame: RpcFrame) { this.stdout.write(`${JSON.stringify(frame)}\n`); }
  event(type: string, payload: RpcObject = {}) { this.send({ jsonrpc: '2.0', method: 'event', params: { type, session_id: this.sessionId, payload } }); }
  complete(status = 'complete') { this.event('message.complete', { status, text: 'Native answer', usage: { input: 12, output: 3 } }); }
  startQueued() {
    expect(this.queued).toBeTruthy(); this.activeText = this.queued!; this.queued = undefined;
    this.event('message.start');
  }
  askProtected() {
    this.pendingInput = true;
    this.send({ jsonrpc: '2.0', id: 'srq-protected', method: 'secret', params: { session_id: this.sessionId, prompt: 'Protected fixture value' } });
  }
  private receive(frame: RpcFrame) {
    if (!frame.method) { this.pendingInput = false; return; }
    const reply = (result: RpcObject) => this.send({ jsonrpc: '2.0', id: frame.id, result });
    switch (frame.method) {
      case 'ping': reply({ pong: true }); break;
      case 'client.capabilities': reply({ server_requests: ['approval', 'secret'] }); break;
      case 'gateway.capabilities': reply({ per_session_exclusive_submit: true }); break;
      case 'session.create': reply({ session_id: this.sessionId, stored_session_id: 'stored-session', info: { desktop_contract: 8 } }); break;
      case 'session.usage': reply({ input: 2, output: 1 }); break;
      case 'session.activate': reply({ session_id: this.sessionId, info: {} }); break;
      case 'session.interrupt': this.queued = undefined; reply({ status: 'interrupted' }); break;
      case 'prompt.submit':
        if (frame.params?.queued) {
          // Native _enqueue_prompt drops a self-copy but _handle_busy_submit still acknowledges it.
          if (frame.params.text !== this.activeText) this.queued = String(frame.params.text);
          reply({ status: 'queued' });
        } else { this.submissions++; this.activeText = String(frame.params?.text); reply({ status: 'streaming' }); }
        break;
      case 'collective.session.settled': this.proofCalls++; void Promise.resolve(this.proof()).then(reply); break;
      default: throw new Error(`Unexpected fixture method: ${frame.method}`);
    }
  }
}

const until = async (check: () => boolean) => {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for controller settlement');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
let root: string, fixture: NativeFixture, controller: LocalController, binding: ReturnType<LocalController['pair']>;
const begin = async (text = 'initial message') => {
  const before = fixture.submissions;
  const run = controller.begin(binding.bindingId, { input: text, session_id: 'conversation' }, randomUUID());
  await until(() => fixture.submissions > before);
  return run;
};
const queue = (run: string, text = 'next native message') => controller.nativeControl(run, { operation: 'queue', requestId: randomUUID(), text });
const terminalEvents = (run: string) => controller.events(run, 0).events.filter(e => /^run\./.test(e.event));

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'managed-settlement-'));
  fixture = new NativeFixture();
  controller = new LocalController({ trust: 'single-user-exclusive-profile', python: '/usr/bin/python3', source: root, profileHome: root,
    workDir: root, accountHome: root, stateDir: root, socketPath: path.join(root, 'unused.sock'), label: 'Settlement fixture' },
  { validate: async () => {}, transport: () => fixture.transport });
  await controller.start();
  binding = controller.pair({ runtimeId: controller.runtimeId, ownerId: 'owner', name: 'Fixture', exclusive: true, model: '', provider: '' });
});
afterEach(async () => { await controller.stop(); await rm(root, { recursive: true, force: true }); });

describe('managed native queued worker settlement', () => {
  it('settles an acknowledged duplicate that Hermes did not retain and allows the next turn', async () => {
    const run = await begin('same message');
    expect(await queue(run, 'same message')).toMatchObject({ accepted: true });
    expect(fixture.queued).toBeUndefined();
    fixture.complete(); await until(() => controller.getRun(run).status === 'completed');
    expect(terminalEvents(run)).toHaveLength(1);
    expect((await controller.nativeView(run)).queued).toBe('');
    const release = controller.holdForSettings(); release();
    const next = await begin('legitimate next message');
    fixture.complete(); await until(() => controller.getRun(next).status === 'completed');
    expect(fixture.stops).toBe(0);
  });

  it.each(['error', 'interrupted'])('retains the accepted successor and its protected prompt after %s', async status => {
    const run = await begin(); await queue(run);
    fixture.complete(status); await until(() => fixture.proofCalls > 0);
    expect(terminalEvents(run)).toHaveLength(0);
    fixture.startQueued(); fixture.askProtected();
    const view = await controller.nativeView(run);
    expect(view.status).toBe('waiting_for_input'); expect(view.queued).toBe('');
    await controller.nativeControl(run, { operation: 'answer', requestId: view.prompts[0].id, answer: { value: 'synthetic-only' } });
    fixture.complete(); await until(() => controller.getRun(run).status === 'completed');
    expect(terminalEvents(run)).toHaveLength(1); expect(fixture.stops).toBe(0);
  });

  it.each([['error', 'failed'], ['interrupted', 'cancelled'], ['future-status', 'failed']] as const)('waits for the worker fence before ending an unqueued %s turn', async (native, portal) => {
    const run = await begin(); fixture.workerSettled = false; fixture.complete(native);
    await until(() => fixture.proofCalls > 0); expect(terminalEvents(run)).toHaveLength(0);
    fixture.workerSettled = true; await until(() => controller.getRun(run).status === portal);
    expect(terminalEvents(run)).toHaveLength(1);
  });

  it('waits for cancelled work to settle and never reports a late complete as success', async () => {
    const run = await begin(); await queue(run); fixture.workerSettled = false;
    await controller.cancel(run); fixture.complete();
    await until(() => fixture.proofCalls > 0); expect(terminalEvents(run)).toHaveLength(0);
    fixture.workerSettled = true; await until(() => controller.getRun(run).status === 'cancelled');
    expect(terminalEvents(run)).toEqual([expect.objectContaining({ event: 'run.cancelled' })]);
    expect((await controller.nativeView(run)).queued).toBe('');
  });

  it('does not apply a pre-admission idle proof to newly queued work', async () => {
    let release!: (proof: RpcObject) => void;
    fixture.proof = () => fixture.proofCalls === 1 ? new Promise(resolve => { release = resolve; })
      : { session_id: fixture.sessionId, settled: !fixture.queued };
    const run = await begin(); fixture.complete(); await until(() => !!release);
    await queue(run); release({ session_id: fixture.sessionId, settled: true });
    await until(() => fixture.proofCalls >= 2); expect(terminalEvents(run)).toHaveLength(0);
    fixture.startQueued(); fixture.complete(); await until(() => controller.getRun(run).status === 'completed');
    expect(terminalEvents(run)).toHaveLength(1);
  });

  it('stops the owned engine when a failed turn has an invalid settlement proof', async () => {
    fixture.proof = () => ({ session_id: 'foreign', settled: true });
    const run = await begin(); fixture.complete('error');
    await until(() => controller.getRun(run).status === 'interrupted');
    expect(controller.status().error).toContain('settlement could not be confirmed');
    expect(fixture.stops).toBe(1);
  });
});
