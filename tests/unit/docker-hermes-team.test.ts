import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { request as httpRequest } from 'node:http';
import { createTeamResourceSnapshot, resourceSha256, type TeamResource } from '@/lib/hermes-team/resources';
import { beginResourceUpdate, planTeamResourceUpdate } from '@/lib/hermes-team/updates';
import { DockerBroker } from '@/docker-hermes/broker';
import { BrokerConfig, runtimeKey, RESOURCE_PROTOCOL_BYTES, type RuntimeDriver, type Profile } from '@/docker-hermes/docker';
import { bindingSchema, type TeamMode, type TeamModelPolicy } from '@/docker-hermes/types';
import { listenBroker } from '@/docker-hermes/main';
import { LOCAL_ORIGIN, socketFetch } from '@/lib/local-hermes/client';
import { stopOwnedGroup } from '@/local-hermes/process-group';
import { LocalError, type LocalController } from '@/local-hermes/controller';

const until = async (fn: () => Promise<boolean>) => {
  const end = Date.now() + 8000;
  while (!await fn()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); }
};
/** Synthetic containers and native protocol; no Docker, credentials or model calls. */
class TeamFixtureDriver implements RuntimeDriver {
  active = new Set<string>(); profilesByOwner = new Map<string, Profile[]>();
  children = new Map<string, Set<ChildProcessWithoutNullStreams>>();
  createCount = 0; launches = 0; stopFailure = false;
  constructor(readonly root: string) {}
  async ensure(owner: string, stage: Parameters<RuntimeDriver['ensure']>[1]) {
    stage('checking_image');
    await mkdir(path.join(this.root, runtimeKey(owner), 'default'), { recursive: true });
    this.profilesByOwner.set(owner, this.profilesByOwner.get(owner) ?? [{ name: 'default', identity: `native-${runtimeKey(owner)}` }]);
    this.active.add(owner); stage('checking_native');
  }
  async running(owner: string) { return this.active.has(owner); }
  async stop(owner: string) {
    if (this.stopFailure) throw new Error('Synthetic unconfirmed stop');
    this.active.delete(owner);
    const children = this.children.get(owner); this.children.delete(owner);
    if (children) await Promise.all([...children].map(async child => { if (child.pid) await stopOwnedGroup(child.pid); }));
  }
  async profiles(owner: string) { return this.profilesByOwner.get(owner) ?? []; }
  async create(owner: string, name: string) {
    this.createCount++;
    const rows = this.profilesByOwner.get(owner)!;
    let p = rows.find(p => p.name === name);
    if (!p) {
      await mkdir(path.join(this.root, runtimeKey(owner), name), { recursive: true });
      p = { name, identity: `native-${runtimeKey(owner).slice(0, 8)}-${name}` }; rows.push(p);
    }
    return p;
  }
  createTeam(owner: string, name: string) { return this.create(owner, name); }
  async resources() { return { skills: [], memories: [] }; }
  transport(owner: string, profile: string) {
    return { spawn: () => {
      this.launches++;
      const child = spawn('/usr/bin/python3', ['-u', '-m', 'tui_gateway.entry'], { cwd: path.resolve('tests/fixtures/hermes-native'), detached: true,
        env: { NODE_ENV: 'test', PATH: '/usr/bin:/bin', HERMES_HOME: path.join(this.root, runtimeKey(owner), profile) }, stdio: ['pipe', 'pipe', 'pipe'] });
      const children = this.children.get(owner) ?? new Set(); children.add(child); this.children.set(owner, children); return child;
    }, stop: () => this.stop(owner) };
  }
}
let root: string, config: BrokerConfig, broker: DockerBroker, driver: TeamFixtureDriver;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hermes-team-runtime-'));
  await mkdir(path.join(root, 'state'), { mode: 0o700 }); await mkdir(path.join(root, 'ipc'), { mode: 0o700 });
  config = BrokerConfig.parse({ stateDir: path.join(root, 'state'), socketPath: path.join(root, 'ipc/b.sock'),
    bridgePath: path.resolve('src/docker-hermes/bridge.py'), namespace: 'cui-team-test',
    image: `nousresearch/hermes-agent@sha256:${'a'.repeat(64)}`, network: 'none', teamBotsEnabled: true });
  driver = new TeamFixtureDriver(root); broker = new DockerBroker(config, driver);
});
afterEach(async () => { driver.stopFailure = false; await broker.close(); await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
const grant = (actor: string, bot = 'shared-bot', mode: TeamMode = 'member', policy: TeamModelPolicy = 'personal_required') =>
  broker.authorizeTeam(actor, { teamBotId: bot, mode, modelPolicy: policy });
const ensure = (actor: string, bot = 'shared-bot', mode: TeamMode = 'member') => {
  const authorization = grant(actor, bot, mode);
  return broker.ensureTeam(actor, { teamBotId: bot, mode, name: 'Shared bot' }, authorization.grantId);
};

describe('disabled Team Bot broker foundations', () => {
  it('is opt-in and separates team provisioning from personal-bot creation authority', async () => {
    expect(BrokerConfig.parse({ ...config, teamBotsEnabled: undefined }).teamBotsEnabled).toBe(false);
    await mkdir(path.join(root, 'disabled-state'));
    const disabled = new DockerBroker({ ...config, stateDir: path.join(root, 'disabled-state'), teamBotsEnabled: false }, new TeamFixtureDriver(root));
    expect(() => disabled.authorizeTeam('alice', { teamBotId: 'shared-bot', mode: 'member', modelPolicy: 'personal_required' })).toThrow('disabled');
    await ensure('alice');
    expect(() => broker.enable('alice')).toThrow('creation');
    expect(driver.launches).toBe(0);
    expect((await broker.status('alice')).bindings).toEqual([]);
    expect((await broker.status('alice')).unlinked).toEqual([]);
  });
  it('collapses parallel requests and preserves the derived owner×bot mapping after restart', async () => {
    const authorization = grant('alice');
    const input = { teamBotId: 'shared-bot', mode: 'member', name: 'Shared bot' };
    const [one, two] = await Promise.all([broker.ensureTeam('alice', input, authorization.grantId), broker.ensureTeam('alice', input, authorization.grantId)]);
    expect(one).toEqual(two); expect(driver.createCount).toBe(1);
    await broker.close(); broker = new DockerBroker(config, driver);
    expect(await ensure('alice')).toEqual(one); expect(driver.createCount).toBe(1); expect(driver.launches).toBe(0);
  });
  it('keeps two users private and puts maintainers in one dedicated admin runtime', async () => {
    const [alice, bob, admin, secondAdmin] = await Promise.all([ensure('alice'), ensure('bob'), ensure('alice', 'shared-bot', 'admin'), ensure('carol', 'shared-bot', 'admin')]);
    expect(alice.profile).not.toBe(bob.profile); expect(alice.runtimeId).not.toBe(bob.runtimeId);
    expect(admin).toEqual(secondAdmin); expect(admin.ownerId).toBe('team-admin:shared-bot');
    expect(admin.runtimeId).not.toBe(alice.runtimeId); expect(admin.profile).not.toBe('default');
    const own = grant('bob');
    await expect(broker.forTeamRequest('bob', 'shared-bot', 'member', alice.bindingId, own.grantId)).rejects.toThrow('another context');
    expect(() => broker.authorizeTeam('team-admin:shared-bot', { teamBotId: 'shared-bot', mode: 'admin', modelPolicy: 'personal_required' })).toThrow();
  });
  it('rejects ungranted admin/member mode switching, arbitrary profiles and personal-route escape', async () => {
    const binding = await ensure('alice'); const authorization = grant('alice');
    expect(() => broker.teamBinding('alice', 'shared-bot', 'admin', authorization.grantId)).toThrow('authorization');
    await expect(broker.ensureTeam('alice', { teamBotId: 'shared-bot', mode: 'member', name: 'Shared bot', profile: '/tmp/escape' }, authorization.grantId)).rejects.toThrow();
    await expect(broker.ensureTeam('alice', { teamBotId: '../escape', mode: 'member', name: 'Shared bot' }, authorization.grantId)).rejects.toThrow();
    await expect(broker.resources('alice', binding.bindingId)).rejects.toThrow('authorization');
    await expect(broker.forRequest('alice', binding.bindingId)).rejects.toThrow('authorization');
    expect(() => broker.forCleanup('alice', binding.bindingId)).toThrow('authorization');
    await expect(broker.profileSettings('alice', binding.bindingId)).rejects.toThrow('authorization');
    await expect(broker.codexState('alice', binding.bindingId)).rejects.toThrow('authorization');
    broker.authorize('alice', true);
    await expect(broker.link('alice', { profile: binding.profile, identity: binding.identity, name: 'Imported' })).rejects.toThrow('personal');
    await expect(broker.controller(binding)).rejects.toThrow('not verified');
    expect(() => bindingSchema.parse({ ...binding, ownerId: 'alice', purpose: 'team-admin' })).toThrow();
  });
  it.each(['admin_provided', 'admin_default_personal_allowed', 'personal_required'] as const)('blocks every native request until %s is fully verified', async policy => {
    const authorization = grant('alice', 'shared-bot', 'member', policy);
    const binding = await broker.ensureTeam('alice', { teamBotId: 'shared-bot', mode: 'member', name: 'Bot' }, authorization.grantId);
    await expect(broker.forTeamRequest('alice', 'shared-bot', 'member', binding.bindingId, authorization.grantId)).rejects.toThrow('learning and subagents');
    expect(driver.launches).toBe(0);
  });
  it('retries a lost native creation response without creating another profile', async () => {
    const create = driver.createTeam.bind(driver); let uncertain = true;
    driver.createTeam = async (owner, name) => { const native = await create(owner, name); if (uncertain) { uncertain = false; throw new Error('Lost response'); } return native; };
    await expect(ensure('alice')).rejects.toThrow('Lost response');
    const recovered = await ensure('alice');
    expect((await driver.profiles('alice')).filter(p => p.name.startsWith('cui-team-'))).toEqual([{ name: recovered.profile, identity: recovered.identity }]);
    expect(await ensure('alice')).toEqual(recovered); expect(driver.launches).toBe(0);
  });
  it('refuses changed native identity and does not silently rebind the private instance', async () => {
    const binding = await ensure('alice');
    driver.profilesByOwner.get('alice')!.find(p => p.name === binding.profile)!.identity = 'replacement';
    await expect(ensure('alice')).rejects.toThrow('identity changed');
    const stored = JSON.parse(await readFile(path.join(config.stateDir, runtimeKey('alice'), 'runtime.json'), 'utf8'));
    expect(stored.bindings[0].bindingId).toBe(binding.bindingId); expect(stored.bindings[0].identity).toBe(binding.identity);
  });
  it('invalidates grants when model policy changes without enabling fallback inference', async () => {
    const previous = grant('alice'); const binding = await broker.ensureTeam('alice', { teamBotId: 'shared-bot', mode: 'member', name: 'Bot' }, previous.grantId);
    const next = grant('alice', 'shared-bot', 'member', 'admin_provided');
    expect(() => broker.teamBinding('alice', 'shared-bot', 'member', previous.grantId)).toThrow('authorization');
    expect(() => broker.teamBinding('alice', 'shared-bot', 'member', next.grantId)).toThrow('policy changed');
    await broker.ensureTeam('alice', { teamBotId: 'shared-bot', mode: 'member', name: 'Bot' }, next.grantId);
    await expect(broker.forTeamRequest('alice', 'shared-bot', 'member', binding.bindingId, next.grantId)).rejects.toThrow('not verified');
  });
  it('revokes immediately, reports runtime-wide interruption and retains sibling bindings', async () => {
    const one = await ensure('alice'), two = await ensure('alice', 'other-bot');
    const other = grant('alice', 'other-bot');
    const result = await broker.revokeTeam('alice', { teamBotId: 'shared-bot', mode: 'member' });
    expect(result).toEqual({ stopped: true, interruption: 'runtime-wide' });
    expect(() => broker.teamBinding('alice', 'other-bot', 'member', other.grantId)).toThrow('authorization');
    expect((await broker.status('alice')).phase).toBe('stopped');
    const stored = JSON.parse(await readFile(path.join(config.stateDir, runtimeKey('alice'), 'runtime.json'), 'utf8'));
    expect(stored.bindings.map((b: { bindingId: string }) => b.bindingId)).toEqual([one.bindingId, two.bindingId]);
    expect(stored.teams['member:shared-bot']).toMatchObject({ state: 'revoked', interruption: 'runtime-wide' });
  });
  it('does not let a renewed personal lease retain expired Team capabilities', async () => {
    await ensure('alice'); const authorization = grant('alice');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61000);
    try {
      broker.authorize('alice', true);
      expect(() => broker.teamBinding('alice', 'shared-bot', 'member', authorization.grantId)).toThrow('authorization');
      await broker.expireLeases(); expect(driver.active.has('alice')).toBe(false);
    } finally { clock.mockRestore(); }
  });
  it('expires a stale admin tab without revoking another maintainer of the shared working profile', async () => {
    const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const alice = grant('alice', 'shared-bot', 'admin');
      const binding = await broker.ensureTeam('alice', { teamBotId: 'shared-bot', mode: 'admin', name: 'Shared bot' }, alice.grantId);
      clock.mockReturnValue(now + 30000);
      const carol = grant('carol', 'shared-bot', 'admin');
      clock.mockReturnValue(now + 61000);
      await broker.expireLeases();
      expect(() => broker.teamBinding('alice', 'shared-bot', 'admin', alice.grantId)).toThrow('authorization');
      expect(broker.teamBinding('carol', 'shared-bot', 'admin', carol.grantId)).toEqual(binding);
      expect(driver.active.has(binding.ownerId)).toBe(true);
    } finally { clock.mockRestore(); }
  });
  it('revokes an idle maintainer without stopping another fresh maintainer or an unrelated personal runtime', async () => {
    const binding = await ensure('alice', 'shared-bot', 'admin'), carol = grant('carol', 'shared-bot', 'admin');
    expect(await broker.revokeTeam('alice', { teamBotId: 'shared-bot', mode: 'admin' })).toEqual({ stopped: false, interruption: 'none' });
    expect(broker.teamBinding('carol', 'shared-bot', 'admin', carol.grantId)).toEqual(binding);
    await ensure('alice', 'used-bot');
    expect(await broker.revokeTeam('alice', { teamBotId: 'unused-bot', mode: 'member' })).toEqual({ stopped: true, interruption: 'none' });
    expect(driver.active.has('alice')).toBe(true);
  });
  it('keeps revocation fenced when runtime-wide cleanup is unconfirmed', async () => {
    await ensure('alice'); const authorization = grant('alice'); driver.stopFailure = true;
    await expect(broker.revokeTeam('alice', { teamBotId: 'shared-bot', mode: 'member' })).rejects.toThrow('unconfirmed');
    expect(() => broker.teamBinding('alice', 'shared-bot', 'member', authorization.grantId)).toThrow('authorization');
    expect((await broker.status('alice')).phase).toBe('error');
  });
  it('protects Team bindings over the real Unix socket, including cleanup URLs and saved mode URLs', async () => {
    const listener = await listenBroker(broker);
    try {
      const fetch = socketFetch(config.socketPath), binding = await ensure('alice'), authorization = grant('alice');
      const plain = { 'x-collective-owner': 'alice' };
      const scoped = { ...plain, 'x-collective-team-bot': 'shared-bot', 'x-collective-team-mode': 'member', 'x-collective-team-grant': authorization.grantId };
      expect((await fetch(`${LOCAL_ORIGIN}/p/${binding.bindingId}/v1/capabilities`, { headers: plain })).status).toBe(403);
      expect((await fetch(`${LOCAL_ORIGIN}/p/${binding.bindingId}/v1/capabilities`, { headers: scoped })).status).toBe(409);
      expect((await fetch(`${LOCAL_ORIGIN}/p/${binding.bindingId}/v1/runs/run_abc`, { headers: plain })).status).toBe(403);
      expect((await fetch(`${LOCAL_ORIGIN}/team/binding`, { headers: { ...scoped, 'x-collective-team-mode': 'admin' } })).status).toBe(403);
      expect((await fetch(`${LOCAL_ORIGIN}/team/binding`, { headers: { ...scoped, 'x-collective-owner': 'bob' } })).status).toBe(403);
      const status = await fetch(`${LOCAL_ORIGIN}/control/status`, { headers: plain }); expect((await status.json()).bindings).toEqual([]);
      expect((await fetch(`${LOCAL_ORIGIN}/team/authorize`, { method: 'POST', headers: { ...plain, origin: 'https://attacker.example' }, body: '{}' })).status).toBe(403);
    } finally { await listener.close(); }
  });
  it('interrupts active sibling native work on revocation, then pairs the personal default without remapping', async () => {
    const team = await ensure('alice'); broker.authorize('alice', true); broker.enable('alice');
    await until(async () => (await broker.status('alice')).bindings.length === 1);
    const personal = (await broker.status('alice')).bindings[0];
    const pair = await broker.forRequest('alice', personal.bindingId);
    const run = pair.controller.begin(pair.nativeBindingId, { input: 'approve', session_id: 'personal-chat' }, 'personal-turn');
    await until(async () => pair.controller.getRun(run).status === 'waiting_for_approval');
    await broker.revokeTeam('alice', { teamBotId: 'shared-bot', mode: 'member' });
    expect(pair.controller.getRun(run).status).toBe('interrupted');
    expect((await broker.status('alice')).bindings[0]).toEqual(personal);
    expect(await ensure('alice')).toEqual(team);
    expect((await broker.status('alice')).bindings[0]).toEqual(personal);
  });
  it('keeps resource capture disabled without the bounded helper and rejects member mode and paths', async () => {
    await ensure('alice', 'shared-bot', 'admin');
    const authorization = grant('alice', 'shared-bot', 'admin');
    const request = { teamBotId: 'shared-bot', mode: 'admin', selection: { skillPackages: ['ops/checklist'], includeRole: true } };
    await expect(broker.captureTeamResources('alice', request, authorization.grantId)).rejects.toThrow('unavailable');
    await expect(broker.captureTeamResources('alice', { ...request, profileRoot: '/opt/data' }, authorization.grantId)).rejects.toThrow();
    await expect(broker.captureTeamResources('alice', { ...request, selection: { documents: ['../auth.json'] } }, authorization.grantId)).rejects.toThrow();
    const member = grant('alice');
    await expect(broker.captureTeamResources('alice', request, member.grantId)).rejects.toThrow('authorization');
    await expect(broker.captureTeamResources('alice', { ...request, mode: 'member' }, member.grantId)).rejects.toThrow();
  });
  it('stops native writers before optional capture, derives the profile root, and verifies retained identity on reopen', async () => {
    const binding = await ensure('alice', 'shared-bot', 'admin'), authorization = grant('alice', 'shared-bot', 'admin');
    const selection = { skillPackages: ['ops/checklist'], includeRole: true };
    const snapshot = createTeamResourceSnapshot([]);
    const capture = vi.fn(async (owner: string, name: string, identity: string) => {
      expect(driver.active.has(owner)).toBe(false); expect(name).toBe(binding.profile); expect(identity).toBe(binding.identity); return snapshot;
    });
    const extended: RuntimeDriver = driver;
    extended.capturePublishableResources = capture;
    extended.reopen = async owner => { driver.active.add(owner); };
    expect(await broker.captureTeamResources('alice', { teamBotId: 'shared-bot', mode: 'admin', selection }, authorization.grantId)).toEqual(snapshot);
    expect(capture).toHaveBeenCalledWith(binding.ownerId, binding.profile, binding.identity, selection);
    expect(driver.active.has(binding.ownerId)).toBe(true);
    expect(broker.teamBinding('alice', 'shared-bot', 'admin', authorization.grantId)).toEqual(binding);
  });
  it('does not return a capture after revocation while its helper is queued', async () => {
    const binding = await ensure('alice', 'shared-bot', 'admin'), authorization = grant('alice', 'shared-bot', 'admin');
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), entry = new Promise<void>(resolve => { entered = resolve; });
    const extended: RuntimeDriver = driver;
    extended.capturePublishableResources = async () => { entered(); await gate; return createTeamResourceSnapshot([]); };
    extended.reopen = async owner => { driver.active.add(owner); };
    const capture = broker.captureTeamResources('alice', { teamBotId: 'shared-bot', mode: 'admin', selection: {} }, authorization.grantId);
    const failed = expect(capture).rejects.toThrow('authorization');
    await entry;
    const revoke = broker.revokeTeam('alice', { teamBotId: 'shared-bot', mode: 'admin' }); release();
    await failed; await revoke;
    expect(driver.active.has(binding.ownerId)).toBe(false);
    expect((await broker.status(binding.ownerId)).phase).toBe('stopped');
  });
  it('refuses capture before stopping any profile that has unfinished native work', async () => {
    const binding = await ensure('alice', 'shared-bot', 'admin'), authorization = grant('alice', 'shared-bot', 'admin');
    const capture = vi.fn(async () => ({ format: 1 as const, manifestHash: 'a'.repeat(64), resources: [] }));
    const extended: RuntimeDriver = driver;
    extended.capturePublishableResources = capture; extended.reopen = async owner => { driver.active.add(owner); };
    const controller = { holdForSettings: () => { throw new LocalError(409, 'Unfinished native work'); }, stop: async () => {} } as unknown as LocalController;
    (broker as unknown as { controllers: Map<string, LocalController> }).controllers.set(binding.bindingId, controller);
    await expect(broker.captureTeamResources('alice', { teamBotId: 'shared-bot', mode: 'admin', selection: {} }, authorization.grantId)).rejects.toThrow('Unfinished native work');
    expect(capture).not.toHaveBeenCalled(); expect(driver.active.has(binding.ownerId)).toBe(true);
  });
  it.each(['cui-team-notes', `cui-team-${'b'.repeat(32)}`])('preserves a legacy personal binding named %s across upgrade', async name => {
    broker.authorize('alice', true); broker.enable('alice');
    await until(async () => (await broker.status('alice')).bindings.length === 1);
    const personal = (await broker.status('alice')).bindings[0], native = await driver.create('alice', name);
    const retained = { ...personal, bindingId: 'f'.repeat(32), botId: 'e'.repeat(32), appId: 'd'.repeat(32), profile: name, identity: native.identity, name: 'Legacy bot' };
    await broker.close();
    const file = path.join(config.stateDir, runtimeKey('alice'), 'runtime.json');
    const state = JSON.parse(await readFile(file, 'utf8'));
    state.bindings.push(retained); state.confirmed.push(retained.bindingId); delete state.teams;
    await writeFile(file, JSON.stringify(state));
    broker = new DockerBroker(config, driver);
    broker.authorize('alice', true); broker.enable('alice');
    await until(async () => (await broker.status('alice')).phase === 'ready');
    expect((await broker.status('alice')).bindings).toContainEqual(retained);
    expect(broker.binding('alice', retained.bindingId)).toEqual(retained);
    expect(await broker.link('alice', { profile: name, identity: native.identity, name: 'Legacy bot' })).toEqual(retained);
    expect((await broker.forRequest('alice', retained.bindingId)).controller).toBeDefined();
  });
});

describe('Team resource maintenance and replay', () => {
  const skill = (content: string): TeamResource => ({ path: 'skills/support/SKILL.md', packageId: 'skills/support', kind: 'skill', encoding: 'utf8', content, size: Buffer.byteLength(content), sha256: resourceSha256(content) });
  const update = () => planTeamResourceUpdate({ installed: createTeamResourceSnapshot([skill('v1')]), release: createTeamResourceSnapshot([skill('v2')]), current: createTeamResourceSnapshot([skill('v1')]) });
  const hooks = () => { const extended: RuntimeDriver = driver; extended.reopen = async owner => { driver.active.add(owner); }; return extended; };
  it('discovers admin selection with derived binding, rejects member/admin cross-grants and caller paths', async () => {
    const binding = await ensure('alice', 'shared-bot', 'admin'), authorization = grant('alice', 'shared-bot', 'admin'), extended = hooks();
    const inventory = vi.fn(async (owner: string, name: string, identity: string) => { expect(driver.active.has(owner)).toBe(false); expect([owner, name, identity]).toEqual([binding.ownerId, binding.profile, binding.identity]); return { skillPackages: ['support', 'catégories/a/b/c/d/e/f'], includeRole: true, documents: ['shared guide.md'] }; });
    extended.inventoryPublishableResources = inventory;
    expect(await broker.inventoryTeamResources('alice', { teamBotId: 'shared-bot', mode: 'admin' }, authorization.grantId)).toEqual({ skillPackages: ['support', 'catégories/a/b/c/d/e/f'], includeRole: true, documents: ['shared guide.md'] });
    await expect(broker.inventoryTeamResources('bob', { teamBotId: 'shared-bot', mode: 'admin' }, authorization.grantId)).rejects.toThrow('authorization');
    await expect(broker.inventoryTeamResources('alice', { teamBotId: 'shared-bot', mode: 'member' }, grant('alice').grantId)).rejects.toThrow();
    await expect(broker.inventoryTeamResources('alice', { teamBotId: 'shared-bot', mode: 'admin', profileRoot: '/private' }, authorization.grantId)).rejects.toThrow();
    expect(inventory).toHaveBeenCalledTimes(1);
  });
  it('offers explicit discovery unavailable state through real IPC rather than an unknown operation', async () => {
    const running = await listenBroker(broker);
    try {
      await ensure('alice', 'shared-bot', 'admin'); const authorization = grant('alice', 'shared-bot', 'admin');
      const response = await socketFetch(config.socketPath)(`${LOCAL_ORIGIN}/team/inventory`, { method: 'POST', headers: { 'x-collective-owner': 'alice', 'x-collective-team-grant': authorization.grantId }, body: JSON.stringify({ teamBotId: 'shared-bot', mode: 'admin' }) });
      expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ error: expect.stringContaining('unavailable') });
      expect(() => broker.teamBinding('alice', 'shared-bot', 'admin', authorization.grantId)).not.toThrow();
    } finally { await running.close(); }
  });
  it('bounds browser discovery selectors before a helper or native stop', async () => {
    const running = await listenBroker(broker);
    try {
      const binding = await ensure('alice', 'shared-bot', 'admin'), authorization = grant('alice', 'shared-bot', 'admin'); const inventory = vi.fn(); hooks().inventoryPublishableResources = inventory;
      const response = await socketFetch(config.socketPath)(`${LOCAL_ORIGIN}/team/inventory`, { method: 'POST', headers: { 'x-collective-owner': 'alice', 'x-collective-team-grant': authorization.grantId }, body: JSON.stringify({ teamBotId: 'shared-bot', mode: 'admin', junk: 'a'.repeat(97 * 1024) }) });
      expect(response.status).toBe(413); expect(inventory).not.toHaveBeenCalled(); expect(driver.active.has(binding.ownerId)).toBe(true);
    } finally { await running.close(); }
  });
  it('accepts bounded server-derived historical member IDs over the browser selector limit through real IPC', async () => {
    const running = await listenBroker(broker);
    try {
      const binding = await ensure('alice'), authorization = grant('alice'), extended = hooks();
      const trackedPackageIds = Array.from({ length: 512 }, (_, i) => `skills/deleted-${String(i).padStart(4, '0')}-${'a'.repeat(220)}`);
      const inventory = vi.fn(async (owner: string, profile: string, identity: string, ids: readonly string[]) => { expect([owner, profile, identity]).toEqual([binding.ownerId, binding.profile, binding.identity]); expect(ids).toEqual(trackedPackageIds); return createTeamResourceSnapshot([]); });
      extended.inventoryMemberResources = inventory;
      const payload = JSON.stringify({ teamBotId: 'shared-bot', mode: 'member', trackedPackageIds }); expect(Buffer.byteLength(payload)).toBeGreaterThan(96 * 1024);
      const response = await socketFetch(config.socketPath)(`${LOCAL_ORIGIN}/team/member-inventory`, { method: 'POST', headers: { 'x-collective-owner': 'alice', 'x-collective-team-grant': authorization.grantId }, body: payload });
      expect(response.status).toBe(200); expect(inventory).toHaveBeenCalledTimes(1); expect(driver.launches).toBe(0);
    } finally { await running.close(); }
  });
  it('rejects oversized trusted apply bodies before reading input, stopping native work or writing files', async () => {
    const running = await listenBroker(broker);
    try {
      await ensure('alice'); const authorization = grant('alice'), apply = vi.fn(); hooks().applyTeamResourceUpdate = apply;
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest({ socketPath: config.socketPath, path: '/team/apply', method: 'POST', headers: { 'x-collective-owner': 'alice', 'x-collective-team-grant': authorization.grantId, 'content-length': String(RESOURCE_PROTOCOL_BYTES + 1) } }, response => { response.resume(); resolve(response.statusCode!); });
        request.on('error', reject); request.end();
      });
      expect(status).toBe(413); expect(apply).not.toHaveBeenCalled(); expect(driver.active.has('alice')).toBe(true);
      const stored = JSON.parse(await readFile(path.join(config.stateDir, runtimeKey('alice'), 'runtime.json'), 'utf8')); expect(stored.resourceOperations).toEqual({});
    } finally { await running.close(); }
  });
  it('preserves member scope, receipts and immutable plan identity across replay/restart', async () => {
    const binding = await ensure('alice'), authorization = grant('alice'), extended = hooks(), plan = update();
    const complete = { ...beginResourceUpdate('release-1', plan), status: 'complete' as const, completedGroups: ['skills/support'] };
    extended.inventoryMemberResources = vi.fn(async (owner, name, identity, tracked) => { expect(driver.active.has(owner)).toBe(false); expect([name, identity, tracked]).toEqual([binding.profile, binding.identity, ['skills/support']]); return createTeamResourceSnapshot([skill('v1')]); });
    await broker.inventoryTeamMemberResources('alice', { teamBotId: 'shared-bot', mode: 'member', trackedPackageIds: ['skills/support'] }, authorization.grantId);
    const apply = vi.fn(async (owner: string) => { expect(driver.active.has(owner)).toBe(false); return complete; }); extended.applyTeamResourceUpdate = apply;
    const input = { teamBotId: 'shared-bot', mode: 'member', operationId: 'release-1', plan };
    expect(await broker.applyTeamMemberResources('alice', input, authorization.grantId)).toEqual(complete);
    expect(await broker.applyTeamMemberResources('alice', input, authorization.grantId)).toEqual(complete);
    await broker.close(); broker = new DockerBroker(config, driver); const fresh = grant('alice');
    expect(await broker.applyTeamMemberResources('alice', input, fresh.grantId)).toEqual(complete);
    const stored = JSON.parse(await readFile(path.join(config.stateDir, runtimeKey('alice'), 'runtime.json'), 'utf8'));
    expect(stored.resourceOperations['release-1']).toMatchObject({ bindingId: binding.bindingId, planHash: plan.planHash, status: 'complete', receipt: complete });
    const otherPlan = planTeamResourceUpdate({ installed: createTeamResourceSnapshot([skill('v1')]), current: createTeamResourceSnapshot([skill('v1')]), release: createTeamResourceSnapshot([skill('v3')]) });
    await expect(broker.applyTeamMemberResources('alice', { ...input, plan: otherPlan }, fresh.grantId)).rejects.toThrow('immutable'); expect(apply).toHaveBeenCalledTimes(3);
  });
  it('accepts bounded plans with many preserved deleted and independently learned packages', async () => {
    await ensure('alice'); const authorization = grant('alice'), extended = hooks();
    const named = (name: string) => ({ ...skill(name), path: `skills/${name}/SKILL.md`, packageId: `skills/${name}` });
    const plan = planTeamResourceUpdate({ installed: createTeamResourceSnapshot(Array.from({ length: 256 }, (_, i) => named(`prior-${i}`))), current: createTeamResourceSnapshot(Array.from({ length: 256 }, (_, i) => named(`learned-${i}`))), release: createTeamResourceSnapshot([named('zz-new')]) });
    expect(plan.actions).toHaveLength(513);
    const receipt = { ...beginResourceUpdate('large-plan', plan), status: 'complete' as const, completedGroups: ['skills/zz-new'] };
    extended.applyTeamResourceUpdate = async () => receipt;
    expect(await broker.applyTeamMemberResources('alice', { teamBotId: 'shared-bot', mode: 'member', operationId: 'large-plan', plan }, authorization.grantId)).toEqual(receipt);
  });
  it('stays stopped on needs-attention and permits protected untouched-abort recovery', async () => {
    await ensure('alice'); const authorization = grant('alice'), extended = hooks(), plan = update();
    extended.applyTeamResourceUpdate = async () => ({ ...beginResourceUpdate('stale', plan), status: 'needs-attention', blockedGroup: 'skills/support' });
    const input = { teamBotId: 'shared-bot', mode: 'member', operationId: 'stale', plan };
    expect(await broker.applyTeamMemberResources('alice', input, authorization.grantId)).toMatchObject({ status: 'needs-attention' });
    expect(driver.active.has('alice')).toBe(false); expect((await broker.status('alice')).error).toContain('needs attention');
    extended.abortTeamResourceUpdate = async () => ({ aborted: true }); expect(await broker.abortTeamMemberResources('alice', input, authorization.grantId)).toEqual({ aborted: true });
    await expect(broker.applyTeamMemberResources('alice', input, authorization.grantId)).rejects.toThrow('cancelled');
  });
  it('rejects stale hashes and unsafe plans before stopping native siblings', async () => {
    await ensure('alice'); const authorization = grant('alice'), apply = vi.fn(); hooks().applyTeamResourceUpdate = apply;
    await expect(broker.applyTeamMemberResources('alice', { teamBotId: 'shared-bot', mode: 'member', operationId: 'invalid', plan: { ...update(), planHash: 'a'.repeat(64) } }, authorization.grantId)).rejects.toThrow('invalid');
    expect(apply).not.toHaveBeenCalled(); expect(driver.active.has('alice')).toBe(true);
  });
  it('blocks member apply if an idle sibling hold cannot be obtained', async () => {
    const one = await ensure('alice'), sibling = await ensure('alice', 'sibling'); const authorization = grant('alice'), apply = vi.fn(); hooks().applyTeamResourceUpdate = apply;
    const controller = { holdForSettings: () => { throw new LocalError(409, 'Unfinished native work blocks runtime-wide maintenance.'); }, stop: async () => {} } as unknown as LocalController;
    (broker as unknown as { controllers: Map<string, LocalController> }).controllers.set(sibling.bindingId, controller);
    await expect(broker.applyTeamMemberResources('alice', { teamBotId: one.teamBotId, mode: 'member', operationId: 'busy', plan: update() }, authorization.grantId)).rejects.toThrow('runtime-wide');
    expect(apply).not.toHaveBeenCalled(); expect(driver.active.has('alice')).toBe(true);
  });
  it('reaches helper cancellation immediately when revocation interrupts maintenance', async () => {
    await ensure('alice'); const authorization = grant('alice'), extended = hooks(); let entered!: () => void, release!: () => void;
    const entry = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    extended.inventoryMemberResources = async () => { entered(); await gate; return createTeamResourceSnapshot([]); };
    const stop = vi.spyOn(driver, 'stop'); const inventory = broker.inventoryTeamMemberResources('alice', { teamBotId: 'shared-bot', mode: 'member', trackedPackageIds: [] }, authorization.grantId);
    const failed = expect(inventory).rejects.toThrow('authorization'); await entry; const before = stop.mock.calls.length;
    const revoke = broker.revokeTeam('alice', { teamBotId: 'shared-bot', mode: 'member' }); expect(stop.mock.calls.length).toBeGreaterThan(before); release(); await failed; await revoke;
    expect(driver.active.has('alice')).toBe(false);
  });
  it('returns completed durable revoke receipts without revoking a new grant, including after broker restart', async () => {
    await ensure('alice'); const input = { teamBotId: 'shared-bot', mode: 'member', requestId: `revoke:${'a'.repeat(64)}`, digest: 'b'.repeat(64) };
    const results = await Promise.all([broker.revokeTeam('alice', input), broker.revokeTeam('alice', input)]); expect(results[0]).toEqual(results[1]);
    await ensure('alice'); const fresh = grant('alice'); const stop = vi.spyOn(driver, 'stop'); expect(await broker.revokeTeam('alice', input)).toEqual(results[0]);
    expect(stop).not.toHaveBeenCalled(); expect(broker.teamBinding('alice', 'shared-bot', 'member', fresh.grantId)).toBeDefined();
    await broker.close(); broker = new DockerBroker(config, driver); await ensure('alice'); const afterRestart = grant('alice'); stop.mockClear();
    expect(await broker.revokeTeam('alice', input)).toEqual(results[0]); expect(stop).not.toHaveBeenCalled(); expect(() => broker.teamBinding('alice', 'shared-bot', 'member', afterRestart.grantId)).not.toThrow();
    await expect(broker.revokeTeam('alice', { ...input, digest: 'c'.repeat(64) })).rejects.toThrow('immutable');
    await expect(broker.revokeTeam('alice', { ...input, mode: 'admin', teamBotId: 'another-owner' })).rejects.toThrow('immutable');
  });
});

describe('pinned Team profile bridge', () => {
  it.each(['blank', 'unsafe', 'crash', 'gateway', 'parked', 'legacy'])('verifies the %s contract without Docker or model access', async scenario => {
    const run = promisify(execFile);
    const output = await run('/usr/bin/python3', ['tests/fixtures/hermes-team-bridge.py', path.resolve('src/docker-hermes/bridge.py'), root, scenario],
      { env: { NODE_ENV: 'test', PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' }, timeout: 10000 });
    expect(JSON.parse(output.stdout)).toEqual({ passed: scenario });
  });
});
