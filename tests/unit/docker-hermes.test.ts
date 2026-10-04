import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DockerBroker } from '@/docker-hermes/broker';
import { BrokerConfig, runtimeKey, type RuntimeDriver, type Profile } from '@/docker-hermes/docker';
import { stopOwnedGroup } from '@/local-hermes/process-group';
import { listenBroker } from '@/docker-hermes/main';
import { socketFetch, LOCAL_ORIGIN } from '@/lib/local-hermes/client';

const until = async (fn: () => Promise<boolean>) => { const end = Date.now() + 8000; while (!await fn()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); } };
/** Explicitly synthetic driver. Python protocol, persistence and Unix HTTP transport are real. */
class FixtureDriver implements RuntimeDriver {
  active = new Set<string>(); profilesByOwner = new Map<string, Profile[]>(); children = new Map<string, Set<ChildProcessWithoutNullStreams>>();
  ensureCount = 0; createCount = 0; stopFailure = false; gate?: Promise<void>;
  constructor(readonly root: string) {}
  async ensure(owner: string, stage: Parameters<RuntimeDriver['ensure']>[1]) {
    this.ensureCount++; stage('checking_image'); await this.gate; stage('creating_storage');
    this.profilesByOwner.set(owner, this.profilesByOwner.get(owner) ?? [{ name: 'default', identity: `native-${owner}` }]);
    stage('starting_container'); this.active.add(owner); stage('checking_native');
  }
  async running(owner: string) { return this.active.has(owner); }
  async stop(owner: string) {
    if (this.stopFailure) throw new Error('Unconfirmed cleanup');
    this.active.delete(owner);
    const children = this.children.get(owner); this.children.delete(owner);
    if (children) await Promise.all([...children].map(async child => { if (child.pid) await stopOwnedGroup(child.pid); }));
  }
  async profiles(owner: string) { return this.profilesByOwner.get(owner) ?? []; }
  async create(owner: string, name: string) {
    this.createCount++;
    const rows = this.profilesByOwner.get(owner)!;
    let p = rows.find(p => p.name === name);
    if (!p) { p = { name, identity: `native-${name}` }; rows.push(p); }
    return p;
  }
  async resources(owner: string, name: string, identity: string) {
    if (!(await this.profiles(owner)).some(p => p.name === name && p.identity === identity)) throw new Error('Changed identity');
    return { skills: [{ id: 'test', name: owner, content: name }], memories: [] };
  }
  transport(owner: string, profile: string) {
    return { spawn: () => {
      const child = spawn('/usr/bin/python3', ['-u', '-m', 'tui_gateway.entry'], { cwd: path.resolve('tests/fixtures/hermes-native'), detached: true,
        env: { NODE_ENV: 'test', PATH: '/usr/bin:/bin', HERMES_HOME: path.join(this.root, owner, profile) }, stdio: ['pipe', 'pipe', 'pipe'] });
      const children = this.children.get(owner) ?? new Set(); children.add(child); this.children.set(owner, children); return child;
    }, stop: () => this.stop(owner) };
  }
}
let root: string, config: BrokerConfig, driver: FixtureDriver, broker: DockerBroker;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'docker-hermes-'));
  for (const name of ['state', 'ipc', 'alice/default', 'bob/default']) await mkdir(path.join(root, name), { recursive: true, mode: 0o700 });
  config = BrokerConfig.parse({ stateDir: path.join(root, 'state'), socketPath: path.join(root, 'ipc/b.sock'), bridgePath: path.resolve('src/docker-hermes/bridge.py'),
    namespace: 'cui-test', image: `nousresearch/hermes-agent@sha256:${'a'.repeat(64)}` });
  driver = new FixtureDriver(root); broker = new DockerBroker(config, driver);
});
afterEach(async () => { driver.stopFailure = false; await broker.close(); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
async function enable(owner: string) { broker.authorize(owner, true); broker.enable(owner); await until(async () => (await broker.status(owner)).phase === 'ready'); }
describe('personal Docker Hermes durable broker', () => {
  it('is lazy, refuses unleased enable, and collapses repeat/parallel enable into one runtime and starter', async () => {
    expect(await broker.status('alice')).toMatchObject({ phase: 'disabled', bindings: [] }); expect(driver.ensureCount).toBe(0);
    expect(() => broker.enable('alice')).toThrow('authorization');
    broker.authorize('alice', true); broker.enable('alice'); broker.enable('alice');
    await until(async () => (await broker.status('alice')).phase === 'ready');
    expect(driver.ensureCount).toBe(1); expect((await broker.status('alice')).bindings).toHaveLength(1);
    expect((await broker.status('alice')).bindings[0]).toMatchObject({ name: 'Hermes', profile: 'default', ownerId: 'alice' });
  });
  it('isolates two owners at binding, resources, native sessions and Unix socket endpoints', async () => {
    await Promise.all([enable('alice'), enable('bob')]);
    const a = (await broker.status('alice')).bindings[0], b = (await broker.status('bob')).bindings[0];
    expect(a.botId).not.toBe(b.botId); expect(a.runtimeId).not.toBe(b.runtimeId);
    await expect(broker.resources('bob', a.bindingId)).rejects.toThrow('belong');
    const running = await listenBroker(broker);
    try {
      const fetch = socketFetch(config.socketPath);
      const response = await fetch(`${LOCAL_ORIGIN}/p/${a.bindingId}/v1/capabilities`, { headers: { 'x-collective-owner': 'bob' } });
      expect(response.status).toBe(403);
      const own = await fetch(`${LOCAL_ORIGIN}/p/${a.bindingId}/v1/capabilities`, { headers: { 'x-collective-owner': 'alice' } });
      expect(own.status).toBe(200);
    } finally { await running.close(); }
  });
  it('retains bindings through restart and does not replay admitted native work', async () => {
    await enable('alice'); const b = (await broker.status('alice')).bindings[0];
    const { controller, nativeBindingId } = await broker.forRequest('alice', b.bindingId);
    const run = controller.begin(nativeBindingId, { input: 'first', session_id: 'owned-conversation' }, 'same-receipt');
    await until(async () => controller.getRun(run).status === 'completed');
    await broker.close(); broker = new DockerBroker(config, driver); await enable('alice');
    expect((await broker.status('alice')).bindings[0]).toEqual(b);
    const restarted = await broker.forRequest('alice', b.bindingId);
    expect(restarted.controller.begin(restarted.nativeBindingId, { input: 'first', session_id: 'owned-conversation' }, 'same-receipt')).toBe(run);
    expect((await readFile(path.join(root, 'alice/default/fixture-prompts.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
  });
  it('creates one native profile for a replayed creation receipt and links external profiles explicitly once', async () => {
    await enable('alice');
    const original = driver.create.bind(driver);
    driver.create = async (owner, name) => { await mkdir(path.join(root, owner, name), { recursive: true }); return original(owner, name); };
    const request = { name: 'Coder', requestId: randomUUID() };
    const [a, b] = await Promise.all([broker.create('alice', request), broker.create('alice', request)]);
    expect(a).toEqual(b); expect(driver.createCount).toBe(1);
    await expect(broker.create('alice', { ...request, name: 'Changed' })).rejects.toThrow('another name');
    await mkdir(path.join(root, 'alice/external'));
    driver.profilesByOwner.get('alice')!.push({ name: 'external', identity: 'external-original' });
    expect((await broker.status('alice')).unlinked).toEqual([{ name: 'external', identity: 'external-original' }]);
    const input = { profile: 'external', identity: 'external-original', name: 'External' };
    const [one, two] = await Promise.all([broker.link('alice', input), broker.link('alice', input)]);
    expect(one).toEqual(two); expect((await broker.status('alice')).unlinked).toEqual([]);
    driver.profilesByOwner.get('alice')!.find(p => p.name === 'external')!.identity = 'replacement';
    await expect(broker.forRequest('alice', one.bindingId)).rejects.toThrow('identity changed');
    await expect(broker.link('alice', { ...input, identity: 'replacement' })).rejects.toThrow('cannot be reassigned');
  });
  it('cancels interrupted setup before it can start a container and safely retries after reload', async () => {
    let release!: () => void; driver.gate = new Promise<void>(r => { release = r; });
    broker.authorize('alice', true); broker.enable('alice');
    await until(async () => driver.ensureCount === 1);
    const stop = broker.stop('alice'); release(); await stop;
    expect(await broker.status('alice')).toMatchObject({ phase: 'stopped', bindings: [] }); expect(driver.active.size).toBe(0);
    driver.gate = undefined; await enable('alice'); expect((await broker.status('alice')).bindings).toHaveLength(1);
  });
  it('expires runtime leases during native approval waits and preserves the native profile', async () => {
    await enable('alice'); const b = (await broker.status('alice')).bindings[0];
    const { controller, nativeBindingId } = await broker.forRequest('alice', b.bindingId);
    const run = controller.begin(nativeBindingId, { input: 'approve', session_id: 'owned-chat' }, 'wait-receipt');
    await until(async () => controller.getRun(run).status === 'waiting_for_approval');
    const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 61000);
    try { await broker.expireLeases(); } finally { clock.mockRestore(); }
    expect(await broker.status('alice')).toMatchObject({ phase: 'stopped' });
    expect(controller.getRun(run).status).toBe('interrupted'); expect(driver.profilesByOwner.get('alice')).toHaveLength(1);
  });
  it('does not publish an uncertain native handshake and reuses its durable profile/bot IDs on retry', async () => {
    await enable('alice');
    const create = driver.create.bind(driver);
    driver.create = async (owner, name) => { await mkdir(path.join(root, owner, name), { recursive: true }); return create(owner, name); };
    const launch = broker.controller.bind(broker);
    broker.controller = async () => { throw new Error('Uncertain handshake'); };
    const request = { name: 'Recoverable', requestId: randomUUID() };
    await expect(broker.create('alice', request)).rejects.toThrow('Uncertain');
    expect((await broker.status('alice')).bindings).toHaveLength(1);
    const pending = JSON.parse(await readFile(path.join(config.stateDir, runtimeKey('alice'), 'runtime.json'), 'utf8')).bindings[1];
    broker.controller = launch;
    const recovered = await broker.create('alice', request);
    expect(recovered).toEqual(pending); expect(driver.createCount).toBe(1);
    expect((await broker.status('alice')).bindings).toHaveLength(2);
  });
  it('does not relink a renamed directory identity and separates create authority from existing reads', async () => {
    await enable('alice'); const binding = (await broker.status('alice')).bindings[0];
    driver.profilesByOwner.get('alice')!.push({ name: 'renamed', identity: binding.identity });
    expect((await broker.status('alice')).unlinked).toEqual([]);
    await expect(broker.link('alice', { profile: 'renamed', identity: binding.identity, name: 'Duplicate' })).rejects.toThrow('already bound');
    broker.authorize('alice', false);
    await expect(broker.resources('alice', binding.bindingId)).resolves.toBeDefined();
    await expect(broker.create('alice', { name: 'Denied', requestId: randomUUID() })).rejects.toThrow('Bot-creation');
    expect(() => broker.enable('alice')).toThrow('Bot-creation');
  });
  it('refuses namespace/image drift instead of orphaning the old runtime and adopting new storage', async () => {
    await enable('alice');
    expect(() => new DockerBroker({ ...config, namespace: 'cui-other' }, driver)).toThrow('configuration changed');
    expect(() => new DockerBroker({ ...config, image: `nousresearch/hermes-agent@sha256:${'b'.repeat(64)}` }, driver)).toThrow('configuration changed');
    expect(driver.active.has('alice')).toBe(true); // The rejected broker cannot misreport a stop or adopt another runtime.
  });
  it('rejects arbitrary browser paths, images and owner values', () => {
    expect(() => runtimeKey('../bob')).toThrow();
    expect(() => BrokerConfig.parse({ ...config, image: 'nousresearch/hermes-agent:latest' })).toThrow();
    expect(() => BrokerConfig.parse({ ...config, dockerSocket: '/run/docker.sock' })).toThrow();
  });

  it('invalidates leases before failed revocation cleanup and retains bindings across re-enrollment', async () => {
    await enable('alice'); const binding = (await broker.status('alice')).bindings[0];
    driver.stopFailure = true;
    await expect(broker.revoke('alice')).rejects.toThrow('cleanup');
    expect(() => broker.enable('alice')).toThrow('authorization');
    await expect(broker.resources('alice', binding.bindingId)).rejects.toThrow('authorization');
    driver.stopFailure = false; await broker.expireLeases();
    expect((await broker.status('alice')).phase).toBe('stopped');
    await enable('alice'); expect((await broker.status('alice')).bindings[0]).toEqual(binding);
  });
  it('revocation cancels an in-flight enable without discarding its retained runtime journal', async () => {
    let release!: () => void; driver.gate = new Promise<void>(resolve => { release = resolve; });
    broker.authorize('alice', true); broker.enable('alice');
    await until(async () => driver.ensureCount === 1);
    const stop = broker.revoke('alice'); release(); await stop;
    expect((await broker.status('alice')).phase).toBe('stopped'); expect(driver.active.has('alice')).toBe(false);
    expect(() => broker.enable('alice')).toThrow('authorization');
  });

  it('requests revocation promptly while native cleanup is slow, without duplicating queued stops', async () => {
    await enable('alice'); const stop = driver.stop.bind(driver);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    driver.stop = async owner => { await gate; return stop(owner); };
    const requestedStops = vi.spyOn(broker, 'stop');
    expect(broker.requestRevoke('alice')).toEqual({ stopped: false, failed: false });
    expect(broker.requestRevoke('alice')).toEqual({ stopped: false, failed: false });
    expect(() => broker.enable('alice')).toThrow('authorization');
    release(); await until(async () => (await broker.status('alice')).phase === 'stopped');
    expect(requestedStops).toHaveBeenCalledTimes(1);
    expect(broker.requestRevoke('alice')).toEqual({ stopped: true, failed: false });
  });

});

describe('personal native profile settings transactions', () => {
  const revision = 'a'.repeat(64);
  const initial = () => ({ revision, provider: 'openai-api' as const, model: 'fixture-model', reasoningEffort: '' as const, maxTurns: null, advancedSupported: true, editableProviders: { 'openai-api': true, anthropic: true, openrouter: true }, credentials: { 'openai-api': false, anthropic: false, openrouter: false } });
  async function fixture() {
    await enable('alice'); const b = (await broker.status('alice')).bindings[0];
    let saved: import('@/docker-hermes/settings').ProfileSettings = initial();
    const d: RuntimeDriver = driver;
    d.settings = vi.fn(async (_owner, _profile, _identity, update) => {
      if (update) saved = { ...saved, revision: 'b'.repeat(64), model: update.model, credentials: { ...saved.credentials, [update.provider]: update.credential.action !== 'clear' } };
      return saved;
    });
    d.reopen = vi.fn(async owner => { driver.active.add(owner); });
    d.testSettings = vi.fn(async () => ({ code: 'verified' as const }));
    const input = { revision, provider: 'openai-api', model: 'fixture-changed', reasoningEffort: '', maxTurns: null, credential: { action: 'replace', value: 'sk-synthetic-never-persist-in-broker' } };
    return { b, d, input };
  }
  it('uses owner binding, rejects stale edits, and never journals plaintext credentials', async () => {
    const { b, d, input } = await fixture(); await enable('bob');
    await expect(broker.profileSettings('bob', b.bindingId)).rejects.toThrow('belong');
    await expect(broker.updateProfile('bob', b.bindingId, input)).rejects.toThrow('belong');
    await expect(broker.updateProfile('alice', b.bindingId, { ...input, revision: 'c'.repeat(64) })).rejects.toThrow('changed');
    expect(d.reopen).not.toHaveBeenCalled();
    expect(await broker.updateProfile('alice', b.bindingId, input)).toMatchObject({ model: 'fixture-changed' });
    expect(d.reopen).toHaveBeenCalledTimes(1);
    const journal = await readFile(path.join(config.stateDir, runtimeKey('alice'), 'runtime.json'), 'utf8');
    expect(journal).not.toContain(input.credential.value);
    await expect(broker.updateProfile('alice', b.bindingId, input)).rejects.toThrow('changed');
  });
  it('does not restart on unchanged defaults and refuses unknown settings', async () => {
    const { b, d, input } = await fixture();
    await broker.updateProfile('alice', b.bindingId, { ...input, model: 'fixture-model', credential: { action: 'keep' } });
    expect(d.reopen).not.toHaveBeenCalled();
    await expect(broker.updateProfile('alice', b.bindingId, { ...input, network: 'host' })).rejects.toThrow();
    await expect(broker.updateProfile('alice', b.bindingId, { ...input, credential: { action: 'keep', value: 'secret' } })).rejects.toThrow();
  });
  it('rejects active and approval-waiting work before stopping any profile', async () => {
    const { b, d, input } = await fixture();
    const pair = await broker.forRequest('alice', b.bindingId);
    const run = pair.controller.begin(pair.nativeBindingId, { input: 'approve', session_id: 'settings-busy' }, 'settings-busy-receipt');
    await until(async () => pair.controller.getRun(run).status === 'waiting_for_approval');
    await expect(broker.updateProfile('alice', b.bindingId, input)).rejects.toThrow('unfinished');
    expect(driver.active.has('alice')).toBe(true); expect(d.reopen).not.toHaveBeenCalled();
    expect(pair.controller.getRun(run).status).toBe('waiting_for_approval');
  });
  it('fences already-dispatched begin calls and serializes concurrent edits/readers', async () => {
    const { b, d, input } = await fixture();
    const pair = await broker.forRequest('alice', b.bindingId);
    let release!: () => void, entered = false;
    const reopen = d.reopen!;
    d.reopen = async owner => { entered = true; await new Promise<void>(r => { release = r; }); await reopen(owner); };
    const first = broker.updateProfile('alice', b.bindingId, input);
    await until(async () => entered);
    expect(() => pair.controller.begin(pair.nativeBindingId, { input: 'do not admit', session_id: 'blocked' }, 'blocked')).toThrow('settings');
    let readFinished = false; const read = broker.profileSettings('alice', b.bindingId).then(v => { readFinished = true; return v; });
    const second = broker.updateProfile('alice', b.bindingId, input).catch(e => e);
    expect(readFinished).toBe(false); release(); await first;
    expect((await read).revision).toBe('b'.repeat(64)); expect(await second).toBeInstanceOf(Error);
  });
  it('retains a stopped error when native update cannot be confirmed', async () => {
    const { b, d, input } = await fixture();
    const read = d.settings!; d.settings = async (owner, name, identity, update) => { if (update) throw new Error('Synthetic failed native transaction'); return read(owner, name, identity); };
    await expect(broker.updateProfile('alice', b.bindingId, input)).rejects.toThrow('Synthetic');
    expect(driver.active.has('alice')).toBe(false);
    expect(await broker.status('alice')).toMatchObject({ phase: 'error' });
    await expect(broker.forRequest('alice', b.bindingId)).rejects.toThrow('Enable');
  });
  it('revocation during reopen prevents the settings write and new native admission', async () => {
    const { b, d, input } = await fixture();
    let release!: () => void, entered = false;
    const reopen = d.reopen!;
    d.reopen = async owner => { entered = true; await new Promise<void>(r => { release = r; }); await reopen(owner); };
    const save = broker.updateProfile('alice', b.bindingId, input).catch(e => e);
    await until(async () => entered);
    expect(broker.requestRevoke('alice')).toEqual({ stopped: false, failed: false });
    release(); expect(await save).toBeInstanceOf(Error);
    await until(async () => (await broker.status('alice')).phase === 'stopped');
    expect(vi.mocked(d.settings!).mock.calls.every(call => call[3] === undefined)).toBe(true);
    await expect(broker.forRequest('alice', b.bindingId)).rejects.toThrow('authorization');
    expect(driver.active.has('alice')).toBe(false);
  });
  it('offline explicit tests send no inference and receipt retries never dispatch again', async () => {
    const { b, d } = await fixture(); const input = { revision, requestId: randomUUID(), consent: true };
    const [a, again] = await Promise.all([broker.testProfile('alice', b.bindingId, input), broker.testProfile('alice', b.bindingId, input)]);
    expect(a).toEqual(again); expect(a.code).toBe('network_blocked'); expect(d.testSettings).not.toHaveBeenCalled();
    expect((await broker.profileSettings('alice', b.bindingId)).lastTest).toMatchObject({ code: 'network_blocked' });
    await expect(broker.testProfile('alice', b.bindingId, { ...input, consent: false })).rejects.toThrow();
    await expect(broker.testProfile('alice', b.bindingId, { ...input, revision: 'b'.repeat(64) })).rejects.toThrow('another');
  });
  it('proxy test failures are uncertain, durably recorded and not automatically replayed', async () => {
    const { b, d } = await fixture();
    // Fixture-only policy: no Docker networking or external requests are involved.
    broker.config.network = 'proxy';
    d.testSettings = vi.fn(async () => { throw new Error('Timeout after possible inference'); });
    const input = { revision, requestId: randomUUID(), consent: true };
    expect((await broker.testProfile('alice', b.bindingId, input)).code).toBe('uncertain');
    await broker.testProfile('alice', b.bindingId, input);
    expect(d.testSettings).toHaveBeenCalledTimes(1);
    expect(await readFile(path.join(config.stateDir, runtimeKey('alice'), 'runtime.json'), 'utf8')).toContain('uncertain');
  });
});
