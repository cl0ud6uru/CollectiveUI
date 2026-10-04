import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LocalController, LocalError } from '../local-hermes/controller';
import { runtimeKey, BrokerConfig, type RuntimeDriver } from './docker';
import { bindingSchema, ownerId, phases, profileName, type DockerBinding, type DockerStatus } from './types';
import { profileUpdate, profileTest, testCodes, type ProfileSettings, type ProfileTestResult } from './settings';
const key = () => randomUUID().replaceAll('-', '');
const storedSchema = z.object({ owner: ownerId, generation: z.number().int(), phase: z.enum(phases), error: z.string().nullable(), cleanupRequired: z.boolean().default(false),
  bindings: z.array(bindingSchema), confirmed: z.array(z.string()).default([]), pending: z.record(z.string(), z.object({ profile: profileName, name: z.string() })),
  tests: z.record(z.string(), z.object({ bindingId: z.string(), revision: z.string(), checkedAt: z.string(), code: z.enum(testCodes) })).default({}) });
type Stored = z.infer<typeof storedSchema>;

/** Durable control journal is outside every native container. Profiles cannot edit their app binding. */
export class DockerBroker {
  private states = new Map<string, Stored>();
  private jobs = new Map<string, Promise<void>>();
  private controllers = new Map<string, LocalController>();
  private queues = new Map<string, Promise<unknown>>();
  private failed = false;
  private leases = new Map<string, { until: number; canCreate: boolean }>();
  private maintaining = new Set<string>();
  authorize(owner: string, canCreate: boolean) {
    ownerId.parse(owner); this.leases.set(owner, { until: Date.now() + 60000, canCreate });
    const s = this.states.get(owner);
    if (!canCreate && s && this.jobs.has(owner)) void this.stop(owner).catch(() => {});
  }
  owners() { return [...this.states.keys()]; }
  async expireLeases() {
    for (const [owner, s] of this.states) if (!['disabled', 'stopped', 'stopping'].includes(s.phase) && ((this.leases.get(owner)?.until ?? 0) <= Date.now() || s.cleanupRequired))
      await this.stop(owner).catch(() => {});
  }
  private authorized(owner: string, create = false) {
    if ((this.leases.get(owner)?.until ?? 0) <= Date.now()) throw new LocalError(403, 'Runtime authorization expired. The application worker must renew it.');
    if (create && !this.leases.get(owner)?.canCreate) throw new LocalError(403, 'Bot-creation authorization is required.');
  }
  constructor(readonly config: BrokerConfig, readonly driver: RuntimeDriver) {
    // Changing a namespace would otherwise strand a live old container and select new storage.
    // Configuration migration is an explicit stopped-runtime operator task, never automatic adoption.
    const deployment = path.join(config.stateDir, 'deployment.json');
    try {
      const fd = openSync(deployment, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify(config)); fsyncSync(fd); } finally { closeSync(fd); }
      const directory = openSync(config.stateDir, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    if (lstatSync(deployment).isSymbolicLink() || JSON.stringify(BrokerConfig.parse(JSON.parse(readFileSync(deployment, 'utf8')))) !== JSON.stringify(config))
      throw new Error('Broker configuration changed. Stop retained runtimes with their original configuration before an operator-planned migration.');
    for (const name of readdirSync(config.stateDir)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      const dir = path.join(config.stateDir, name);
      if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error('Unsafe broker state');
      const state = storedSchema.parse(JSON.parse(readFileSync(path.join(dir, 'runtime.json'), 'utf8')));
      if (runtimeKey(state.owner) !== name) throw new Error('Runtime owner mismatch');
      if (!['stopped', 'disabled'].includes(state.phase)) {
        state.phase = 'interrupted'; state.cleanupRequired = true; state.error = 'Broker restarted. Retry to reconcile the retained runtime and profiles; uncertain chat work is not replayed.';
      }
      this.states.set(state.owner, state);
    }
  }
  private state(owner: string, create = false) {
    ownerId.parse(owner);
    if (this.failed) throw new LocalError(503, 'Broker storage needs repair and restart.');
    let s = this.states.get(owner);
    if (!s && create) {
      if (this.states.size >= this.config.maxUsers) throw new LocalError(409, 'Personal runtime capacity reached.');
      s = { owner, generation: 0, phase: 'disabled', error: null, cleanupRequired: false, bindings: [], confirmed: [], pending: {}, tests: {} };
      const dir = path.join(this.config.stateDir, runtimeKey(owner));
      mkdirSync(dir, { mode: 0o700 }); this.states.set(owner, s); this.save(s);
    }
    return s;
  }
  private save(s: Stored) {
    try {
      const dir = path.join(this.config.stateDir, runtimeKey(s.owner));
      const file = path.join(dir, 'runtime.json'), temp = `${file}.tmp`;
      const fd = openSync(temp, 'w', 0o600);
      try { writeFileSync(fd, JSON.stringify(s)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, file);
      const d = openSync(dir, 'r'); try { fsyncSync(d); } finally { closeSync(d); }
    } catch {
      this.failed = true;
      for (const owner of this.states.keys()) void this.driver.stop(owner).catch(() => {});
      throw new LocalError(503, 'Broker metadata could not be persisted. Runtimes are stopping; repair storage without deleting bindings.');
    }
  }
  private exclusive<T>(owner: string, run: () => Promise<T>) {
    const before = this.queues.get(owner) ?? Promise.resolve();
    const task = before.catch(() => {}).then(run); this.queues.set(owner, task);
    void task.finally(() => { if (this.queues.get(owner) === task) this.queues.delete(owner); }).catch(() => {});
    return task;
  }
  async status(owner: string): Promise<DockerStatus> {
    const s = this.state(owner);
    if (!s) return { network: this.config.network, phase: 'disabled', error: null, generation: 0, bindings: [], unlinked: [] };
    if (s.phase === 'ready' && !this.maintaining.has(owner) && !await this.driver.running(owner) && s.phase === 'ready' && !this.maintaining.has(owner)) {
      s.phase = 'stopped'; s.error = 'Native runtime stopped. Retry to reopen retained profiles.'; this.save(s);
    }
    const unlinked = s.phase === 'ready' && !this.maintaining.has(owner) ? (await this.driver.profiles(owner)).filter(p => p.name !== 'default' &&
      !s.bindings.some(b => (b.profile === p.name || b.identity === p.identity) && s.confirmed.includes(b.bindingId)) && !Object.values(s.pending).some(b => b.profile === p.name)) : [];
    return { network: this.config.network, phase: s.phase, error: s.error, generation: s.generation, bindings: s.bindings.filter(b => s.confirmed.includes(b.bindingId)), unlinked };
  }
  enable(owner: string) {
    this.authorized(owner, true);
    const s = this.state(owner, true)!;
    if (this.jobs.has(owner) || s.phase === 'ready') return;
    if (s.phase === 'stopping') throw new LocalError(409, 'Wait for cancellation to settle before retrying.');
    const generation = ++s.generation;
    s.phase = 'checking_image'; s.cleanupRequired = false; s.error = null; this.save(s);
    const current = () => { this.authorized(owner, true); if (s.generation !== generation) throw new LocalError(409, 'Provisioning cancelled.'); };
    const task = this.exclusive(owner, async () => {
      try {
        // Cold recovery first proves all prior native processes ended. No automatic turn replay.
        await this.driver.stop(owner); current();
        for (const b of s.bindings) { await this.controllers.get(b.bindingId)?.stop(); this.controllers.delete(b.bindingId); }
        current();
        await this.driver.ensure(owner, phase => { current(); s.phase = phase; this.save(s); }); current();
        s.phase = 'pairing'; this.save(s);
        const defaultProfile = (await this.driver.profiles(owner)).find(p => p.name === 'default');
        if (!defaultProfile) throw new LocalError(409, 'The native default profile is not initialized. Inspect this runtime in Hermes.');
        await this.bind(s, 'default', defaultProfile.identity, 'Hermes'); current();
        // Persisting the default mapping before ready makes polling/reload pairing deterministic.
        s.phase = 'ready'; s.error = null; this.save(s);
      } catch (e) {
        try { await this.driver.stop(owner); s.cleanupRequired = false; }
        catch { s.cleanupRequired = true; s.phase = 'error'; s.error = 'Native cleanup is unconfirmed. Ask the operator to stop the owned runtime before retrying.'; this.save(s); return; }
        s.phase = s.generation !== generation ? 'stopped' : 'error';
        s.error = s.phase === 'stopped' ? null : e instanceof LocalError ? e.message : 'Native setup failed. Data is retained; inspect the runtime before retrying.';
        this.save(s);
      }
    });
    this.jobs.set(owner, task);
    void task.finally(() => { this.jobs.delete(owner); }).catch(() => {});
  }
  requestRevoke(owner: string) {
    // Return promptly: a slow Docker stop must not starve other owners' lease renewal.
    this.leases.delete(owner);
    const s = this.state(owner);
    if (!s || ['disabled', 'stopped'].includes(s.phase)) return { stopped: true, failed: false };
    const failed = s.cleanupRequired && s.phase === 'error';
    if (s.phase !== 'stopping') void this.stop(owner).catch(() => {});
    return { stopped: false, failed };
  }
  async revoke(owner: string) {
    // Invalidate before awaiting cleanup, including when Docker cannot confirm stop.
    this.leases.delete(owner);
    await this.stop(owner);
  }
  async stop(owner: string) {
    const s = this.state(owner); if (!s) return;
    ++s.generation; s.cleanupRequired = true; s.phase = 'stopping'; s.error = null; this.save(s);
    await this.exclusive(owner, async () => {
      try { await this.driver.stop(owner); }
      catch { s.phase = 'error'; s.error = 'Native cleanup is unconfirmed. Data is retained; operator reconciliation is required.'; this.save(s); throw new LocalError(503, s.error); }
      for (const b of s.bindings) { await this.controllers.get(b.bindingId)?.stop(); this.controllers.delete(b.bindingId); }
      s.cleanupRequired = false; s.phase = 'stopped'; this.save(s);
    });
  }
  private async ready(owner: string) {
    this.authorized(owner);
    const s = this.state(owner);
    if (!s || s.phase !== 'ready' || !await this.driver.running(owner)) throw new LocalError(409, 'Enable your Hermes runtime first.');
    return s;
  }
  private async bind(s: Stored, profile: string, identity: string, name: string) {
    if (s.bindings.some(b => b.identity === identity && b.profile !== profile)) throw new LocalError(409, 'This native profile identity is already bound under another name. Operator rename reconciliation is required.');
    const existing = s.bindings.find(b => b.profile === profile);
    if (existing) {
      if (existing.identity !== identity) throw new LocalError(409, 'The native profile was replaced or renamed. Its prior bot binding cannot be reassigned.');
      await this.controller(existing);
      if (!s.confirmed.includes(existing.bindingId)) { s.confirmed.push(existing.bindingId); this.save(s); }
      return existing;
    }
    if (s.bindings.length >= this.config.maxProfiles) throw new LocalError(409, 'Profile capacity reached.');
    const b: DockerBinding = { bindingId: key(), botId: key(), appId: key(), ownerId: s.owner, runtimeId: runtimeKey(s.owner), profile, identity, name };
    // Write-ahead app identity; retry after an uncertain handshake reuses these IDs.
    s.bindings.push(b); this.save(s);
    await this.controller(b); s.confirmed.push(b.bindingId); this.save(s); return b;
  }
  async link(owner: string, raw: unknown) {
    const input = z.object({ profile: profileName, identity: z.string().max(100), name: z.string().trim().min(1).max(80) }).strict().parse(raw);
    if (input.profile === 'default') throw new LocalError(400, 'The default profile is paired automatically.');
    return this.exclusive(owner, async () => {
      this.authorized(owner, true);
      const s = await this.ready(owner);
      const found = (await this.driver.profiles(owner)).find(p => p.name === input.profile && p.identity === input.identity);
      if (!found) throw new LocalError(409, 'The discovered profile changed. Refresh Unlinked profiles.');
      return this.bind(s, found.name, found.identity, input.name);
    });
  }
  async create(owner: string, raw: unknown) {
    const input = z.object({ requestId: z.string().uuid(), name: z.string().trim().min(1).max(80) }).strict().parse(raw);
    return this.exclusive(owner, async () => {
      this.authorized(owner, true);
      const s = await this.ready(owner);
      let pending = s.pending[input.requestId];
      if (!pending) {
        if (Object.keys(s.pending).length + s.bindings.filter(b => !b.profile.startsWith('cui-')).length >= this.config.maxProfiles)
          throw new LocalError(409, 'Profile capacity reached.');
        pending = { name: input.name, profile: `cui-${key()}` };
        s.pending[input.requestId] = pending; this.save(s);
      } else if (pending.name !== input.name) throw new LocalError(409, 'This creation request already has another name.');
      const existing = s.bindings.find(b => b.profile === pending.profile);
      if (existing) return this.bind(s, existing.profile, existing.identity, existing.name);
      const native = await this.driver.create(owner, pending.profile);
      return this.bind(s, native.name, native.identity, pending.name);
    });
  }
  binding(owner: string, id: string) {
    const s = this.state(owner);
    const b = s?.bindings.find(b => b.bindingId === id && s.confirmed.includes(b.bindingId));
    if (!b) throw new LocalError(403, 'This native profile does not belong to your runtime.');
    return b;
  }
  async resources(owner: string, id: string) {
    const b = this.binding(owner, id); await this.ready(owner);
    return this.driver.resources(owner, b.profile, b.identity);
  }
  async profileSettings(owner: string, id: string): Promise<ProfileSettings> {
    return this.exclusive(owner, async () => {
    await this.ready(owner); const b = this.binding(owner, id);
    if (this.maintaining.has(owner)) throw new LocalError(409, 'Profile settings are being updated. Reload after they settle.');
    if (!this.driver.settings) throw new LocalError(503, 'This runtime does not support profile settings.');
    const value = await this.driver.settings(owner, b.profile, b.identity);
    const lastTest = Object.values(this.state(owner)!.tests).filter(t => t.bindingId === id && t.revision === value.revision).at(-1);
    return { ...value, lastTest: lastTest ? { code: lastTest.code, checkedAt: lastTest.checkedAt, revision: lastTest.revision } : null };
    });
  }
  private async maintain<T>(owner: string, id: string, run: (s: Stored, b: DockerBinding, current: () => void) => Promise<T>) {
    return this.exclusive(owner, async () => {
      const s = await this.ready(owner), b = this.binding(owner, id), generation = s.generation;
      this.maintaining.add(owner);
      const release: (() => void)[] = [];
      const current = () => { this.authorized(owner); if (s.generation !== generation || s.phase !== 'ready') throw new LocalError(409, 'Runtime access changed. Reload before continuing.'); };
      try {
        // An already-dispatched request may hold a controller reference. Fence begin() too.
        for (const binding of s.bindings) { const controller = this.controllers.get(binding.bindingId); if (controller) release.push(controller.holdForSettings()); }
        current(); return await run(s, b, current);
      } finally { release.forEach(fn => fn()); this.maintaining.delete(owner); }
    });
  }
  async updateProfile(owner: string, id: string, raw: unknown) {
    const input = profileUpdate.parse(raw);
    return this.maintain(owner, id, async (s, b, current) => {
      if (!this.driver.settings || !this.driver.reopen) throw new LocalError(503, 'This runtime does not support profile settings.');
      const before = await this.driver.settings(owner, b.profile, b.identity); current();
      if (before.revision !== input.revision) throw new LocalError(409, 'Profile settings changed. Reload before saving.');
      const unchanged = input.credential.action === 'keep' && (['provider', 'model', 'maxTurns', 'reasoningEffort'] as const).every(k => input[k] === before[k]);
      if (unchanged) return { ...before, lastTest: null };
      if (!before.advancedSupported || !before.editableProviders[input.provider]) throw new LocalError(409, 'This profile has native routing, credentials or advanced values outside this editor. Use native maintenance before changing them.');
      try {
        // Stop all native writers before the transaction. Holds above ensure no sibling work is lost.
        await this.driver.stop(owner);
        for (const binding of s.bindings) await this.controllers.get(binding.bindingId)?.stop();
        current(); await this.driver.reopen(owner); current();
        const value = await this.driver.settings(owner, b.profile, b.identity, input); current();
        // Lazy controller startup on the next chat reloads native settings; receipts remain on disk.
        for (const binding of s.bindings) this.controllers.delete(binding.bindingId);
        return { ...value, lastTest: null };
      } catch (e) {
        // A timed-out bridge may still be writing. Stop before permitting any native admission.
        try { await this.driver.stop(owner); s.cleanupRequired = false; }
        catch { s.cleanupRequired = true; }
        s.phase = 'error'; s.error = 'Settings could not be fully applied. Data is retained. Restart your runtime, then reload settings to see the committed values.'; this.save(s);
        throw e;
      }
    });
  }
  async testProfile(owner: string, id: string, raw: unknown): Promise<ProfileTestResult> {
    const input = profileTest.parse(raw);
    return this.maintain(owner, id, async (s, b, current) => {
      const previous = s.tests[input.requestId];
      if (previous) {
        if (previous.bindingId !== id || previous.revision !== input.revision) throw new LocalError(409, 'This test request belongs to another settings revision.');
        return { code: previous.code, revision: previous.revision, checkedAt: previous.checkedAt };
      }
      if (!this.driver.settings || !this.driver.testSettings) throw new LocalError(503, 'This runtime does not support connection tests.');
      const value = await this.driver.settings(owner, b.profile, b.identity); current();
      if (value.revision !== input.revision) throw new LocalError(409, 'Profile settings changed. Reload before testing.');
      if (Object.keys(s.tests).length >= 1000) throw new LocalError(409, 'Connection-test receipt capacity reached. Ask the operator to archive settled receipts.');
      const result = { bindingId: id, revision: input.revision, checkedAt: new Date().toISOString(), code: 'uncertain' as ProfileTestResult['code'] };
      s.tests[input.requestId] = result; this.save(s); // Never replay a possibly charged request after a crash.
      if (this.config.network === 'none') result.code = 'network_blocked';
      else {
        try { result.code = z.enum(testCodes).parse((await this.driver.testSettings(owner, b.profile, b.identity, input.revision)).code); }
        catch { result.code = 'uncertain'; }
      }
      current(); this.save(s);
      return { code: result.code, revision: result.revision, checkedAt: result.checkedAt };
    });
  }
  async controller(b: DockerBinding) {
    const profiles = await this.driver.profiles(b.ownerId);
    if (!profiles.some(p => p.name === b.profile && p.identity === b.identity)) throw new LocalError(409, 'Retained native profile identity changed.');
    let controller = this.controllers.get(b.bindingId);
    if (!controller) {
      const dir = path.join(this.config.stateDir, runtimeKey(b.ownerId), b.bindingId); mkdirSync(dir, { recursive: true, mode: 0o700 });
      controller = new LocalController({ trust: 'single-user-exclusive-profile', source: '/opt/hermes', python: '/opt/hermes/.venv/bin/python',
        profileHome: `/opt/data/${b.profile === 'default' ? '' : `profiles/${b.profile}`}`, workDir: b.profile === 'default' ? '/opt/data/workspace' : `/opt/data/profiles/${b.profile}/workspace`, accountHome: '/opt/data/home',
        stateDir: dir, socketPath: this.config.socketPath, label: 'Personal Docker Hermes' }, {
        validate: async () => { if (!await this.driver.running(b.ownerId)) throw new LocalError(409, 'Your runtime is stopped.'); },
        transport: () => this.driver.transport(b.ownerId, b.profile, b.identity),
      });
      this.controllers.set(b.bindingId, controller);
    }
    await controller.start();
    const paired = controller.pair({ runtimeId: controller.runtimeId, ownerId: b.ownerId, name: b.name, exclusive: true });
    return { controller, nativeBindingId: paired.bindingId };
  }
  forCleanup(owner: string, id: string) {
    this.binding(owner, id);
    const controller = this.controllers.get(id);
    if (!controller) throw new LocalError(409, 'Native replay unavailable after restart. The runtime must be stopped or reconciled.');
    const binding = controller.status().binding;
    if (!binding) throw new LocalError(409, 'Native binding is unavailable.');
    return { controller, nativeBindingId: binding.bindingId };
  }
  async forRequest(owner: string, id: string) {
    return this.exclusive(owner, async () => {
    await this.ready(owner);
    if (this.maintaining.has(owner)) throw new LocalError(409, 'Profile settings are being updated or tested. Try again after they settle.');
    const value = await this.controller(this.binding(owner, id));
    if (this.maintaining.has(owner)) throw new LocalError(409, 'Profile settings are being updated or tested. Try again after they settle.');
    return value;
    });
  }
  async close() { await Promise.all([...this.states.keys()].map(owner => this.stop(owner))); }
}
