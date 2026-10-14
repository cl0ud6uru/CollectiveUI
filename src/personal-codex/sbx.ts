import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { execFile } from 'node:child_process';
import { access, lstat, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { constants as fsConstants } from 'node:fs';
import { z } from 'zod';
import { ComputerInputSchema } from '../lib/computer/contracts';
import { ownerId, tokenFingerprint } from './contracts';
import type { ComputerInput, ComputerStatus, PersonalCodexRuntimeDriver } from './driver';
import { SbxBrokerConfigSchema, runtimeKey, type SbxBrokerConfig } from './docker';
import { AdminTemplateReference, NetworkDestination, type AdminCheck } from './admin-contracts';

const execFileAsync = promisify(execFile);
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const sbxEnv = (home: string): NodeJS.ProcessEnv => ({ HOME: home, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', NODE_ENV: 'production' });
const unavailable = () => new Error('Personal Codex sbx runtime is unavailable or needs operator reconciliation. Runtime data is retained.');
const rowSchema = z.object({
  id: z.string().min(1).max(256), name: z.string().min(2).max(128),
  status: z.string().min(1).max(80).optional(), state: z.string().min(1).max(80).optional(),
}).passthrough().refine(row => !!(row.status ?? row.state));
const inspectSchema = z.object({
  name: z.string().min(2).max(128), state: z.string().min(1).max(80), workspace: z.string(),
  image_digest: z.string().min(1).max(256),
}).passthrough();
const bindingSchema = z.object({ id: z.string().min(1).max(256), name: z.string().min(2).max(128), template: z.string(), cpus: z.number().int(), memoryMb: z.number().int() }).strict();
const ledgerSchema = z.object({ version: z.literal(1), namespace: z.string(), bindings: z.record(z.string(), bindingSchema) }).strict();
const adminStateSchema = z.object({
  version: z.literal(1), namespace: z.string(), revision: z.number().int().nonnegative(),
  cpus: z.number().int().min(1).max(64), memoryMb: z.number().int().min(512).max(65536),
  maxRunning: z.number().int().min(1).max(1000), defaultTemplate: AdminTemplateReference,
  knownOwners: z.array(ownerId).max(1000), admittedOwners: z.array(ownerId).max(1000),
}).strict().refine(state => new Set(state.knownOwners).size === state.knownOwners.length &&
  new Set(state.admittedOwners).size === state.admittedOwners.length && state.admittedOwners.every(id => state.knownOwners.includes(id)));
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_ARCHIVES = 100;
const MAX_NETWORK_EVENTS = 50;
const emptyNetworkEvents = () => ({ events: [] as Array<{ at: string | null; destination: string; decision: 'allowed' | 'denied' | 'unknown' }>, eventsObserved: false });

/** Docker Sandboxes CLI 0.48.0 adapter. It only addresses names derived from enrolled owner IDs. */
export class SbxPersonalCodexDriver implements PersonalCodexRuntimeDriver {
  readonly config: SbxBrokerConfig;
  private readonly paused = new Set<string>();
  private versionVerified = false;
  private ledgerQueue: Promise<unknown> = Promise.resolve();
  private adminSettings: z.infer<typeof adminStateSchema>;

  constructor(config: SbxBrokerConfig) {
    try { this.config = SbxBrokerConfigSchema.parse(config); }
    catch { throw unavailable(); }
    this.adminSettings = adminStateSchema.parse({ version: 1, namespace: this.config.namespace, revision: 0,
      cpus: this.config.cpus, memoryMb: this.config.memoryMb, maxRunning: 1, defaultTemplate: this.config.template,
      knownOwners: [...this.config.owners], admittedOwners: [...this.config.owners] });
  }

  name(owner: string) {
    const normalized = ownerId.parse(owner);
    if (!this.config.adminEnabled && !this.config.owners.includes(normalized)) throw unavailable();
    return `${this.config.namespace}-${runtimeKey(normalized)}`;
  }

  admitted(owner: string) {
    const normalized = ownerId.parse(owner);
    if (!this.config.adminEnabled) return this.config.owners.includes(normalized);
    return this.adminSettings.knownOwners.includes(normalized) && this.adminSettings.admittedOwners.includes(normalized);
  }

  private async command(args: string[], timeout = 45000): Promise<Buffer> {
    const cwd = await this.protectedCwd();
    try {
      const result = await execFileAsync(this.config.sbxExecutable, args, {
        cwd, env: sbxEnv(this.config.sbxHome), timeout, maxBuffer: MAX_CAPTURE_BYTES,
        encoding: 'buffer',
      });
      return Buffer.from(result.stdout);
    } catch {
      // CLI stderr can include paths and credentials. Do not forward it to callers or logs.
      throw unavailable();
    }
  }

  private async verifyVersion() {
    if (this.versionVerified) return;
    let document: unknown;
    try { document = JSON.parse((await this.command(['version', '--format', 'json'])).toString('utf8')); }
    catch { throw unavailable(); }
    const version = z.object({ client: z.object({ version: z.string() }).passthrough() }).passthrough().safeParse(document);
    if (!version.success || version.data.client.version !== `v${this.config.sbxVersion}`) throw unavailable();
    this.versionVerified = true;
  }

  private async verifyHostSettings() {
    await this.verifyVersion();
    const forwarding = await this.setting('ssh.agentForwardingEnabled');
    const fixedSocket = await this.setting('ssh.agentSocketPath');
    if (forwarding !== false || fixedSocket !== '') throw unavailable();
  }

  private async setting(key: 'ssh.agentForwardingEnabled' | 'ssh.agentSocketPath'): Promise<unknown> {
    let raw: unknown;
    try { raw = JSON.parse((await this.command(['settings', 'get', key, '--json'])).toString('utf8')); }
    catch { throw unavailable(); }
    const parsed = z.object({ value: z.unknown() }).passthrough().safeParse(raw);
    if (!parsed.success) throw unavailable();
    return parsed.data.value;
  }

  private ledgerPath() { return join(this.config.sbxHome, 'collectiveui-personal-codex-bindings.json'); }
  private archiveDirectory() { return join(this.config.sbxHome, 'template-imports'); }

  private requireAdmin() {
    if (!this.config.adminEnabled) throw new Error('Personal Codex sandbox administration is disabled by the operator.');
  }

  private async readAdminState() {
    this.requireAdmin();
    return this.adminSettings;
  }

  private async writeAdminState(state: z.infer<typeof adminStateSchema>) {
    const validated = adminStateSchema.parse(state);
    if (validated.namespace !== this.config.namespace || !this.config.owners.every(owner => validated.knownOwners.includes(owner))) throw unavailable();
    this.adminSettings = validated;
  }

  private async assertKnown(owner: string) {
    const normalized = ownerId.parse(owner);
    if (this.config.adminEnabled) {
      if (!(await this.readAdminState()).knownOwners.includes(normalized)) throw unavailable();
    } else if (!this.config.owners.includes(normalized)) throw unavailable();
    return normalized;
  }

  private async assertAdmitted(owner: string) {
    const normalized = await this.assertKnown(owner);
    if (this.config.adminEnabled) {
      if (!(await this.readAdminState()).admittedOwners.includes(normalized)) throw unavailable();
    } else if (!this.config.owners.includes(normalized)) throw unavailable();
    return normalized;
  }

  private async protectedCwd() {
    try {
      const uid = process.getuid?.();
      const home = await lstat(this.config.sbxHome);
      if (uid === undefined || !home.isDirectory() || home.isSymbolicLink() || home.uid !== uid || (home.mode & 0o077)) throw unavailable();
      const path = join(this.config.sbxHome, 'collectiveui-empty-cwd');
      await mkdir(path, { mode: 0o700 }).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
      const cwd = await lstat(path);
      if (!cwd.isDirectory() || cwd.isSymbolicLink() || cwd.uid !== uid || (cwd.mode & 0o077)) throw unavailable();
      if ((await readdir(path)).length !== 0) throw unavailable();
      return path;
    } catch { throw unavailable(); }
  }

  private async readLedger() {
    try {
      const home = await lstat(this.config.sbxHome);
      if (!home.isDirectory() || home.isSymbolicLink() || home.uid !== process.getuid?.() || home.mode & 0o077) throw unavailable();
      const path = this.ledgerPath();
      const stat = await lstat(path).catch(err => (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : Promise.reject(err));
      if (!stat) return { version: 1 as const, namespace: this.config.namespace, bindings: {} as Record<string, z.infer<typeof bindingSchema>> };
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 1024 * 1024) throw unavailable();
      const parsed = ledgerSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
      if (!parsed.success || parsed.data.namespace !== this.config.namespace) throw unavailable();
      return parsed.data;
    } catch { throw unavailable(); }
  }

  private async writeLedger(ledger: z.infer<typeof ledgerSchema>) {
    try {
      const temp = `${this.ledgerPath()}.${randomBytes(12).toString('hex')}.tmp`;
      await writeFile(temp, JSON.stringify(ledger), { mode: 0o600, flag: 'wx' });
      await rename(temp, this.ledgerPath());
    } catch { throw unavailable(); }
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.ledgerQueue.then(fn, fn);
    this.ledgerQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async rows() {
    await this.verifyVersion();
    let raw: unknown;
    try { raw = JSON.parse((await this.command(['ls', '--format', 'json'])).toString('utf8')); }
    catch { throw unavailable(); }
    // Since 0.48.0, `sbx ls --format json` returns the sandbox array directly.
    if (!Array.isArray(raw) || raw.length > 10000) throw unavailable();
    const parsed = z.array(rowSchema).safeParse(raw);
    if (!parsed.success) throw unavailable();
    return parsed.data;
  }

  private async snapshot(name: string, knownRows?: Awaited<ReturnType<SbxPersonalCodexDriver['rows']>>) {
    const row = (knownRows ?? await this.rows()).find(item => item.name === name);
    if (!row) return null;
    let raw: unknown;
    try { raw = JSON.parse((await this.command(['inspect', '--format', 'json', name])).toString('utf8')); }
    catch { throw unavailable(); }
    const parsed = inspectSchema.safeParse(raw);
    if (!parsed.success || parsed.data.name !== name) throw unavailable();
    return { row, details: parsed.data };
  }

  private validateSnapshot(snapshot: NonNullable<Awaited<ReturnType<SbxPersonalCodexDriver['snapshot']>>>, expected: {
    template: string; cpus: number; memoryMb: number;
  }, requireNoSessions = false) {
    const { row, details } = snapshot;
    const state = details.state.toLowerCase().trim();
    if (!['running', 'stopped'].includes(state) || (row.status ?? row.state)?.toLowerCase().trim() !== state) throw unavailable();
    const expectedDigest = expected.template.slice(expected.template.lastIndexOf('@sha256:') + 8);
    if (details.image_digest !== expectedDigest || details.workspace.trim() !== '') throw unavailable();
    const raw = details as Record<string, unknown>;
    const cpus = raw.cpus ?? raw.cpu_count ?? row.cpus ?? row.cpu_count;
    const memory = raw.memory_mib ?? raw.memory_mb ?? raw.memoryMiB ?? row.memory_mib ?? row.memory_mb;
    if (cpus !== expected.cpus || memory !== expected.memoryMb) throw unavailable();
    const emptyArray = (...keys: string[]) => {
      const key = keys.find(candidate => raw[candidate] !== undefined);
      return key !== undefined && Array.isArray(raw[key]) && (raw[key] as unknown[]).length === 0;
    };
    if (!emptyArray('kits') || !emptyArray('mounts') || !emptyArray('secrets') || !emptyArray('published_ports', 'ports')) throw unavailable();
    const sessionsKey = ['active_sessions', 'sessions'].find(key => raw[key] !== undefined);
    if (!sessionsKey || !(Number.isSafeInteger(raw[sessionsKey]) && Number(raw[sessionsKey]) >= 0 || Array.isArray(raw[sessionsKey]))) throw unavailable();
    const activeSessions = Array.isArray(raw[sessionsKey]) ? raw[sessionsKey].length : Number(raw[sessionsKey]);
    // A healthy app-server bridge is a live sbx exec session. Only newly provisioned
    // sandboxes must have no sessions before the first bridge is opened.
    if (requireNoSessions && activeSessions !== 0) throw unavailable();
    if (raw.mcp_gateway !== undefined && raw.mcp_gateway !== false && raw.mcp_gateway !== null) throw unavailable();
    if (raw.shared_skills !== undefined && raw.shared_skills !== false && raw.shared_skills !== 'off') throw unavailable();
    if (raw.auth_mode !== undefined && !['', 'none', 'not configured'].includes(String(raw.auth_mode).toLowerCase())) throw unavailable();
    return { id: row.id, name: row.name, template: expected.template, cpus: expected.cpus, memoryMb: expected.memoryMb };
  }

  async inspect(owner: string) {
    const name = this.name(owner);
    await this.assertKnown(owner);
    const ledger = await this.readLedger();
    const binding = ledger.bindings[runtimeKey(owner)];
    const matching = (await this.rows()).filter(row => row.name === name);
    if (!matching.length) {
      if (binding) throw unavailable();
      return null;
    }
    if (matching.length !== 1 || !binding) throw unavailable();
    const snapshot = await this.snapshot(name);
    if (!snapshot) throw unavailable();
    const actual = this.validateSnapshot(snapshot, binding);
    if (JSON.stringify(actual) !== JSON.stringify(binding) || snapshot.row.id !== binding.id) throw unavailable();
    const status = snapshot.details.state.toLowerCase().trim();
    return { State: { Running: status === 'running' } };
  }

  async ensure(owner: string) {
    return this.exclusive(() => this.ensureExclusive(owner));
  }

  private async ensureExclusive(owner: string) {
    const name = this.name(owner);
    await this.assertAdmitted(owner);
    await this.verifyHostSettings();
    const current = await this.inspect(owner);
    if (!current) {
      await this.assertCapacity(owner);
      const settings = this.config.adminEnabled ? await this.readAdminState() : { cpus: this.config.cpus, memoryMb: this.config.memoryMb, defaultTemplate: this.config.template };
      // Empty cwd, no workspace path, no kit/hooks, no env-file, no shared skills or MCP.
      // The digest-pinned template owns the guest entrypoint and includes the stock Codex app-server.
      await this.command(['create', 'shell', '--name', name, '--template', settings.defaultTemplate,
        '--cpus', String(settings.cpus), '--memory', `${settings.memoryMb}m`, '--no-progress',
        '--pull', 'never', '--skills', 'off']);
      const snapshot = await this.snapshot(name);
      if (!snapshot) throw unavailable();
      const binding = this.validateSnapshot(snapshot, { template: settings.defaultTemplate, cpus: settings.cpus, memoryMb: settings.memoryMb }, true);
      const ledger = await this.readLedger();
      if (ledger.bindings[runtimeKey(owner)]) throw unavailable();
      ledger.bindings[runtimeKey(owner)] = binding;
      await this.writeLedger(ledger);
    }
    await this.startRetainedExclusive(owner);
  }

  async startRetained(owner: string) {
    return this.exclusive(() => this.startRetainedExclusive(owner));
  }

  private async startRetainedExclusive(owner: string) {
    const name = this.name(owner);
    await this.assertAdmitted(owner);
    const current = await this.inspect(owner);
    if (!current) throw unavailable();
    if (!current.State.Running) {
      await this.assertCapacity(owner);
      // 0.48.0 `sbx exec` starts a stopped local sandbox before executing the command.
      await this.command(['exec', name, '/bin/true']);
    }
    if (!(await this.inspect(owner))?.State.Running) throw unavailable();
  }

  private async assertCapacity(owner: string) {
    if (!this.config.adminEnabled) return;
    const settings = await this.readAdminState();
    let running = 0;
    for (const candidate of settings.knownOwners) {
      if (candidate === owner) continue;
      const current = await this.inspect(candidate);
      if (current?.State.Running) running++;
    }
    if (running >= settings.maxRunning) throw new Error('Personal Codex sandbox capacity is full. Stop another runtime or raise the configured limit.');
  }

  async adminConfigure(input: {
    cpus: number; memoryMb: number; defaultTemplate: string; knownOwners: string[]; admittedOwners: string[]; maxRunning: number;
  }): Promise<void> {
    this.requireAdmin();
    const schema = z.object({
      cpus: z.number().int().min(1).max(64), memoryMb: z.number().int().min(512).max(65536),
      defaultTemplate: AdminTemplateReference, knownOwners: z.array(ownerId).max(1000),
      admittedOwners: z.array(ownerId).max(1000), maxRunning: z.number().int().min(1).max(1000),
    }).strict().refine(value => new Set(value.knownOwners).size === value.knownOwners.length &&
      new Set(value.admittedOwners).size === value.admittedOwners.length && value.admittedOwners.every(id => value.knownOwners.includes(id)) &&
      this.config.owners.every(id => value.knownOwners.includes(id)));
    const value = schema.parse(input);
    await this.exclusive(async () => {
      const current = await this.readAdminState();
      await this.writeAdminState({ ...value, version: 1, namespace: this.config.namespace, revision: current.revision + 1 });
    });
  }

  async adminOwnerAccess(owner: string): Promise<{ known: boolean; admitted: boolean }> {
    this.requireAdmin();
    const normalized = ownerId.parse(owner);
    const settings = await this.readAdminState();
    const known = settings.knownOwners.includes(normalized);
    return { known, admitted: known && settings.admittedOwners.includes(normalized) };
  }

  async adminKnownOwners(): Promise<string[]> {
    this.requireAdmin();
    return [...(await this.readAdminState()).knownOwners];
  }

  async siwcVerified(owner: string): Promise<boolean> {
    if (!this.config.siwcSandboxVerified) return false;
    const normalized = ownerId.safeParse(owner);
    if (!normalized.success) return false;
    try {
      await this.assertKnown(normalized.data);
      const binding = (await this.readLedger()).bindings[runtimeKey(normalized.data)];
      const template = binding?.template ?? (this.config.adminEnabled ? (await this.readAdminState()).defaultTemplate : this.config.template);
      return template === this.config.template;
    } catch { return false; }
  }

  private async daemonStatusState(): Promise<AdminCheck['state']> {
    try {
      const raw = JSON.parse((await this.command(['daemon', 'status', '--format', 'json'])).toString('utf8')) as unknown;
      const parsed = z.object({ running: z.boolean().optional(), status: z.string().optional(), state: z.string().optional() }).passthrough().safeParse(raw);
      if (!parsed.success) return 'unknown';
      if (typeof parsed.data.running === 'boolean') return parsed.data.running ? 'passed' : 'failed';
      const value = (parsed.data.status ?? parsed.data.state ?? '').trim().toLowerCase();
      if (['running', 'ready', 'healthy'].includes(value)) return 'passed';
      if (['stopped', 'not running', 'unavailable', 'failed'].includes(value)) return 'failed';
      return 'unknown';
    } catch { return 'unknown'; }
  }

  async adminHealth(): Promise<{ version: string | null; checks: AdminCheck[] }> {
    this.requireAdmin();
    let version: string | null = null;
    try { await this.verifyVersion(); version = `v${this.config.sbxVersion}`; } catch { /* reported below */ }
    const checks: AdminCheck[] = [{ id: 'sbx-version', label: 'Docker Sandboxes CLI', state: version ? 'passed' : 'failed',
      detail: version ? `Verified ${version}.` : 'The configured CLI version could not be verified.' }];
    try {
      const kvmPath = '/dev/kvm';
      const kvm = await lstat(kvmPath);
      if (!kvm.isCharacterDevice()) throw unavailable();
      await access(kvmPath, fsConstants.R_OK | fsConstants.W_OK);
      checks.push({ id: 'kvm-device', label: 'KVM device access', state: 'passed', detail: 'A KVM character device is accessible to the broker process; this does not verify a live sandbox boot.' });
    } catch { checks.push({ id: 'kvm-device', label: 'KVM device access', state: 'failed', detail: 'The broker process cannot access a KVM character device at /dev/kvm.' }); }
    try { await this.protectedCwd(); checks.push({ id: 'sbx-home', label: 'Protected runtime home', state: 'passed', detail: 'The runtime home and command directory are private and owned by the service account.' }); }
    catch { checks.push({ id: 'sbx-home', label: 'Protected runtime home', state: 'failed', detail: 'The configured runtime home is missing or has unsafe ownership or permissions.' }); }
    const daemonState = await this.daemonStatusState();
    checks.push({ id: 'sbx-daemon', label: 'Sandbox daemon', state: daemonState,
      detail: daemonState === 'passed' ? 'The daemon status response indicates it is running.'
        : daemonState === 'failed' ? 'The daemon status response indicates it is stopped.' : 'The daemon status response schema or state is not recognized.' });
    for (const [id, label, key, expected] of [
      ['agent-forwarding', 'SSH agent forwarding', 'ssh.agentForwardingEnabled', false],
      ['agent-socket', 'SSH agent socket', 'ssh.agentSocketPath', ''],
    ] as const) {
      if (daemonState !== 'passed') {
        checks.push({ id, label, state: 'unknown', detail: 'The host setting was not queried because the daemon is not confirmed running.' });
        continue;
      }
      try {
        const value = await this.setting(key);
        checks.push({ id, label, state: value === expected ? 'passed' : 'failed',
          detail: value === expected ? 'The host setting matches the required sandbox boundary.' : 'The host setting does not match the required sandbox boundary.' });
      } catch { checks.push({ id, label, state: 'unknown', detail: 'The host setting could not be verified.' }); }
    }
    return { version, checks };
  }

  async adminInventory(): Promise<Array<{ ownerId: string; state: 'running' | 'stopped' | 'missing' | 'unavailable'; cpus: number; memoryMb: number; template: string; activeSessions: number | null }>> {
    this.requireAdmin();
    const settings = await this.readAdminState();
    const ledger = await this.readLedger();
    const rows = await this.rows();
    const result = [] as Array<{ ownerId: string; state: 'running' | 'stopped' | 'missing' | 'unavailable'; cpus: number; memoryMb: number; template: string; activeSessions: number | null }>;
    for (const owner of settings.knownOwners) {
      const binding = ledger.bindings[runtimeKey(owner)];
      const fallback = binding ?? { cpus: settings.cpus, memoryMb: settings.memoryMb, template: settings.defaultTemplate };
      try {
        const name = this.name(owner);
        const row = rows.filter(item => item.name === name);
        if (!row.length && !binding) { result.push({ ownerId: owner, cpus: fallback.cpus, memoryMb: fallback.memoryMb, template: fallback.template, state: 'missing', activeSessions: null }); continue; }
        if (row.length !== 1 || !binding) throw unavailable();
        const snapshot = await this.snapshot(name, row);
        if (!snapshot) throw unavailable();
        const actual = this.validateSnapshot(snapshot, binding);
        if (JSON.stringify(actual) !== JSON.stringify(binding) || snapshot.row.id !== binding.id) throw unavailable();
        const raw = snapshot.details as Record<string, unknown>;
        const key = ['active_sessions', 'sessions'].find(candidate => raw[candidate] !== undefined);
        const activeSessions = key ? Array.isArray(raw[key]) ? (raw[key] as unknown[]).length : Number(raw[key]) : null;
        result.push({ ownerId: owner, cpus: fallback.cpus, memoryMb: fallback.memoryMb, template: fallback.template,
          state: snapshot.details.state.toLowerCase() === 'running' ? 'running' : 'stopped',
          activeSessions: Number.isSafeInteger(activeSessions) && Number(activeSessions) >= 0 ? Number(activeSessions) : null });
      } catch { result.push({ ownerId: owner, cpus: fallback.cpus, memoryMb: fallback.memoryMb, template: fallback.template, state: 'unavailable', activeSessions: null }); }
    }
    return result;
  }

  async adminTemplates(references: string[]): Promise<Array<{ reference: string; available: boolean | null }>> {
    this.requireAdmin();
    const parsed = z.array(AdminTemplateReference).max(1000).parse(references);
    let rows: unknown;
    try { rows = JSON.parse((await this.command(['template', 'ls', '--format', 'json'])).toString('utf8')); }
    catch { return parsed.map(reference => ({ reference, available: null })); }
    // The v0.48.0 help promises JSON but does not specify fields; only recognize an exact pinned-reference schema.
    const list = z.array(z.object({ reference: AdminTemplateReference }).passthrough()).safeParse(rows);
    if (!list.success) return parsed.map(reference => ({ reference, available: null }));
    const available = new Set(list.data.map(row => row.reference));
    return parsed.map(reference => ({ reference, available: available.has(reference) }));
  }

  async adminArchives(): Promise<Array<{ name: string; sizeBytes: number }>> {
    this.requireAdmin();
    try {
      await mkdir(this.archiveDirectory(), { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const directory = await lstat(this.archiveDirectory());
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || directory.mode & 0o077) throw unavailable();
      const files = (await readdir(this.archiveDirectory())).filter(name => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,122}\.tar$/.test(name)).slice(0, MAX_ARCHIVES);
      const archives: Array<{ name: string; sizeBytes: number }> = [];
      for (const name of files) {
        const stat = await lstat(join(this.archiveDirectory(), name));
        if (stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && !(stat.mode & 0o077) && stat.size <= MAX_ARCHIVE_BYTES)
          archives.push({ name, sizeBytes: stat.size });
      }
      return archives;
    } catch { throw unavailable(); }
  }

  async adminImportTemplate(archive: string, reference: string): Promise<void> {
    this.requireAdmin();
    const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,122}\.tar$/).parse(archive);
    const ref = AdminTemplateReference.parse(reference);
    const entries = await this.adminArchives();
    if (!entries.some(entry => entry.name === name)) throw unavailable();
    await this.command(['template', 'load', join(this.archiveDirectory(), name), ref], 15 * 60_000);
  }

  private async adminNetworkEvents(owner: string) {
    const name = this.name(owner);
    let raw: unknown;
    try { raw = JSON.parse((await this.command(['policy', 'log', name, '--limit', String(MAX_NETWORK_EVENTS), '--type', 'network', '--json'])).toString('utf8')); }
    catch { return emptyNetworkEvents(); }
    let values: unknown;
    if (Array.isArray(raw)) values = raw;
    else {
      const parsed = z.object({ events: z.array(z.unknown()).optional(), logs: z.array(z.unknown()).optional(), entries: z.array(z.unknown()).optional() }).passthrough().safeParse(raw);
      values = parsed.success ? parsed.data.events ?? parsed.data.logs ?? parsed.data.entries : undefined;
    }
    const rows = z.array(z.unknown()).max(MAX_NETWORK_EVENTS).safeParse(values);
    if (!rows.success) return emptyNetworkEvents();
    const events: Array<{ at: string | null; destination: string; decision: 'allowed' | 'denied' | 'unknown' }> = [];
    for (const item of rows.data) {
      const row = z.object({ host: z.string().optional(), destination: z.string().optional(), resource: z.string().optional(),
        allowed: z.boolean().optional(), decision: z.string().optional(), action: z.string().optional(),
        timestamp: z.string().optional(), at: z.string().optional(), time: z.string().optional() }).passthrough().safeParse(item);
      if (!row.success) return emptyNetworkEvents();
      const host = NetworkDestination.safeParse(row.data.host ?? row.data.destination ?? row.data.resource);
      if (!host.success) return emptyNetworkEvents();
      let decision: 'allowed' | 'denied' | 'unknown' = 'unknown';
      if (typeof row.data.allowed === 'boolean') decision = row.data.allowed ? 'allowed' : 'denied';
      else {
        const choice = (row.data.decision ?? row.data.action ?? '').trim().toLowerCase();
        if (['allow', 'allowed', 'pass'].includes(choice)) decision = 'allowed';
        else if (['deny', 'denied', 'block', 'blocked'].includes(choice)) decision = 'denied';
        else if (choice) return emptyNetworkEvents();
      }
      const atValue = row.data.timestamp ?? row.data.at ?? row.data.time;
      const at = atValue === undefined ? null : new Date(atValue);
      if (at && !Number.isFinite(at.getTime())) return emptyNetworkEvents();
      events.push({ at: at?.toISOString() ?? null, destination: host.data, decision });
    }
    return { events, eventsObserved: true };
  }

  private async adminNetworkRules(owner: string) {
    this.requireAdmin();
    await this.assertKnown(owner);
    const name = this.name(owner);
    const events = await this.adminNetworkEvents(owner);
    let raw: unknown;
    try { raw = JSON.parse((await this.command(['policy', 'ls', name, '--type', 'network', '--wide', '--json'])).toString('utf8')); }
    catch { return { rules: [] as Array<{ effect: 'allow' | 'deny'; destination: string; cliRuleId: string }>, observed: false, note: 'Network policy could not be read.', ...events }; }
    // Only consume fully identified scoped network rules. Unknown JSON is reported as unobserved.
    const candidates = Array.isArray(raw) ? raw : z.object({ rules: z.array(z.unknown()) }).passthrough().safeParse(raw).success
      ? (raw as { rules: unknown[] }).rules : null;
    if (!candidates) return { rules: [] as Array<{ effect: 'allow' | 'deny'; destination: string; cliRuleId: string }>, observed: false, note: 'The CLI policy response schema is not recognized.', ...events };
    const rules: Array<{ effect: 'allow' | 'deny'; destination: string; cliRuleId: string }> = [];
    for (const item of candidates) {
      const row = z.object({ id: z.string().uuid(), decision: z.enum(['allow', 'deny']).optional(), effect: z.enum(['allow', 'deny']).optional(), resource: z.string().optional(), destination: z.string().optional(), type: z.string().optional() }).passthrough().safeParse(item);
      if (!row.success || row.data.type !== 'network') return { rules: [], observed: false, note: 'The CLI policy response schema is not recognized.', ...events };
      const destination = NetworkDestination.safeParse(row.data.destination ?? row.data.resource);
      const effect = row.data.effect ?? row.data.decision;
      if (!destination.success || !effect) return { rules: [], observed: false, note: 'The CLI policy response schema is not recognized.', ...events };
      rules.push({ effect, destination: destination.data, cliRuleId: row.data.id });
    }
    return { rules, observed: true, note: 'Rules are scoped to this managed runtime.', ...events };
  }

  async adminNetworkRead(owner: string) { return this.adminNetworkRules(owner); }

  async adminNetworkAdd(owner: string, effect: 'allow' | 'deny', destination: string): Promise<{ cliRuleId: string }> {
    this.requireAdmin();
    const normalized = await this.assertKnown(owner);
    const target = NetworkDestination.parse(destination);
    const before = await this.adminNetworkRules(normalized);
    if (!before.observed) throw unavailable();
    const name = this.name(normalized);
    await this.command(['policy', effect, 'network', '--sandbox', name, '--protocol', 'tcp', target]);
    const after = await this.adminNetworkRules(normalized);
    if (!after.observed) throw unavailable();
    const added = after.rules.filter(rule => rule.effect === effect && rule.destination === target && !before.rules.some(old => old.cliRuleId === rule.cliRuleId));
    if (added.length !== 1) throw unavailable();
    return { cliRuleId: added[0].cliRuleId };
  }

  async adminNetworkRemove(owner: string, effect: 'allow' | 'deny', destination: string, cliRuleId: string): Promise<void> {
    this.requireAdmin();
    const normalized = await this.assertKnown(owner);
    const target = NetworkDestination.parse(destination);
    const id = z.string().uuid().parse(cliRuleId);
    const before = await this.adminNetworkRules(normalized);
    if (!before.observed || !before.rules.some(rule => rule.cliRuleId === id && rule.effect === effect && rule.destination === target)) throw unavailable();
    await this.command(['policy', 'rm', 'network', '--sandbox', this.name(normalized), '--id', id, '--force']);
    const after = await this.adminNetworkRules(normalized);
    if (!after.observed || after.rules.some(rule => rule.cliRuleId === id)) throw unavailable();
  }

  async adminNetworkCheck(owner: string, destination: string): Promise<{ decision: 'allowed' | 'denied' | 'unknown'; detail: string }> {
    this.requireAdmin();
    const normalized = await this.assertKnown(owner);
    const target = NetworkDestination.parse(destination);
    try {
      const raw = JSON.parse((await this.command(['policy', 'check', 'network', '--sandbox', this.name(normalized), '--json', target])).toString('utf8')) as unknown;
      const parsed = z.object({ allowed: z.boolean() }).passthrough().safeParse(raw);
      if (parsed.success) return { decision: parsed.data.allowed ? 'allowed' : 'denied', detail: 'Evaluated by the sandbox policy service.' };
      return { decision: 'unknown', detail: 'The CLI policy response schema is not recognized.' };
    } catch { return { decision: 'unknown', detail: 'The network request could not be checked.' }; }
  }

  async adminDiagnose(): Promise<AdminCheck[]> {
    this.requireAdmin();
    const health = await this.adminHealth();
    let raw: unknown;
    try {
      raw = JSON.parse((await this.command(['diagnose', '--format', 'json'], 60000)).toString('utf8'));
    } catch {
      return [...health.checks, { id: 'sbx-diagnose', label: 'Sandbox diagnostic report', state: 'unknown', detail: 'The diagnostic report could not be read.' }];
    }
    const report = z.object({ checks: z.array(z.unknown()).max(100) }).passthrough().safeParse(raw);
    if (!report.success || report.data.checks.length === 0) {
      return [...health.checks, { id: 'sbx-diagnose', label: 'Sandbox diagnostic report', state: 'unknown', detail: 'The diagnostic report schema is not recognized.' }];
    }
    let failed = 0, passed = 0, unrecognized = 0;
    for (const item of report.data.checks) {
      const check = z.object({ passed: z.boolean().optional(), status: z.string().optional(), state: z.string().optional(), result: z.string().optional() }).passthrough().safeParse(item);
      if (!check.success) { unrecognized++; continue; }
      if (typeof check.data.passed === 'boolean') {
        if (check.data.passed) passed++;
        else failed++;
        continue;
      }
      const status = (check.data.status ?? check.data.state ?? check.data.result ?? '').trim().toLowerCase();
      if (['pass', 'passed', 'ok', 'healthy', 'success'].includes(status)) passed++;
      else if (['fail', 'failed', 'error', 'unhealthy'].includes(status)) failed++;
      else unrecognized++;
    }
    const state: AdminCheck['state'] = failed ? 'failed' : unrecognized || !passed ? 'unknown' : 'passed';
    const detail = state === 'passed' ? `The report contains ${passed} recognized passing checks.`
      : state === 'failed' ? `The report contains ${failed} recognized failing checks.`
        : 'The diagnostic report contains fields or states this adapter does not recognize.';
    return [...health.checks, { id: 'sbx-diagnose', label: 'Sandbox diagnostic report', state, detail }];
  }

  async bridge(owner: string): Promise<ChildProcessWithoutNullStreams> {
    const name = this.name(owner);
    await this.assertAdmitted(owner);
    if (!(await this.inspect(owner))?.State.Running || this.paused.has(name)) throw unavailable();
    const cwd = await this.protectedCwd();
    if (this.paused.has(name)) throw unavailable();
    // Interactive stdin without `-t`: JSON-RPC stays line framed and never enters a pseudo-terminal.
    return spawn(this.config.sbxExecutable, ['exec', '--interactive', name, 'node', '/opt/collective-codex/bridge.mjs'], {
      cwd, env: sbxEnv(this.config.sbxHome), stdio: 'pipe',
    });
  }

  async computerStatus(owner: string): Promise<ComputerStatus> {
    const current = await this.inspect(owner);
    return { available: current !== null, running: !!current?.State.Running, width: 1280, height: 800 };
  }

  async computerFrame(owner: string): Promise<Buffer> {
    const name = this.name(owner);
    await this.assertAdmitted(owner);
    if (!(await this.inspect(owner))?.State.Running) throw unavailable();
    const bytes = await this.command(['exec', '--interactive', name, 'python3', '/opt/collective-computer/control.py', 'screenshot'], 20000);
    if (bytes.length < 4 || bytes.length > 512 * 1024 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9)
      throw unavailable();
    return bytes;
  }

  async computerInput(owner: string, input: ComputerInput): Promise<void> {
    const parsed = ComputerInputSchema.safeParse(input);
    if (!parsed.success) throw unavailable();
    const name = this.name(owner);
    await this.assertAdmitted(owner);
    if (!(await this.inspect(owner))?.State.Running) throw unavailable();
    await this.pipe(['exec', '--interactive', name, 'python3', '/opt/collective-computer/control.py', 'input'], Buffer.from(`${JSON.stringify(parsed.data)}\n`));
  }

  async computerPause(owner: string, paused: boolean): Promise<void> {
    const name = this.name(owner);
    await this.assertKnown(owner);
    if (!paused) await this.assertAdmitted(owner);
    if (!(await this.inspect(owner))?.State.Running) throw unavailable();
    if (paused) this.paused.add(name);
    try {
      await this.command(['exec', name, 'python3', '/opt/collective-computer/control.py', paused ? 'pause' : 'resume']);
      if (!paused) this.paused.delete(name);
    } catch (error) {
      // Keep the local fence closed if pause failed; recovery must explicitly resume it.
      throw error;
    }
  }

  async synchronizeToken(owner: string, accessToken: string, credentialBinding: string): Promise<void> {
    const name = this.name(owner);
    await this.assertAdmitted(owner);
    if (!(await this.siwcVerified(owner))) throw new Error('Personal Codex token sharing is unavailable until this runtime template passes the SIWC sandbox environment and /proc isolation proof.');
    if (accessToken.length < 1 || accessToken.length > 16_384 || !/^[a-f0-9]{64}$/.test(credentialBinding) ||
      tokenFingerprint(accessToken) !== credentialBinding) throw unavailable();
    if (this.paused.has(name) || !(await this.inspect(owner))?.State.Running || this.paused.has(name)) throw unavailable();
    const cwd = await this.protectedCwd();
    if (this.paused.has(name)) throw unavailable();
    const payload = Buffer.from(JSON.stringify({ accessToken, credentialBinding }));
    await this.pipeAt(['exec', '--interactive', name, 'node', '/opt/collective-codex/server.mjs', '--sync-token'], payload, cwd,
      () => { if (this.paused.has(name)) throw unavailable(); });
  }

  async clearToken(owner: string): Promise<void> {
    const name = this.name(owner);
    const current = await this.inspect(owner);
    // Stopped or absent VMs have no live supervisor memory to clear.
    if (!current?.State.Running) return;
    if (this.paused.has(name)) { await this.stop(owner); return; }
    const cwd = await this.protectedCwd();
    if (this.paused.has(name)) { await this.stop(owner); return; }
    await this.pipeAt(['exec', '--interactive', name, 'node', '/opt/collective-codex/server.mjs', '--clear-token'], Buffer.alloc(0), cwd,
      () => { if (this.paused.has(name)) throw unavailable(); });
  }

  async stop(owner: string) {
    const name = this.name(owner);
    await this.assertKnown(owner);
    if (!(await this.inspect(owner))) return;
    await this.command(['stop', '--format', 'json', name]);
    if ((await this.inspect(owner))?.State.Running) throw unavailable();
    this.paused.delete(name);
  }

  async cleanup(owner: string) {
    return this.exclusive(async () => {
      const name = this.name(owner);
      await this.assertKnown(owner);
      if (!(await this.inspect(owner))) return;
      await this.command(['rm', '--force', '--format', 'json', name]);
      if ((await this.rows()).some(row => row.name === name)) throw unavailable();
      const ledger = await this.readLedger();
      delete ledger.bindings[runtimeKey(owner)];
      await this.writeLedger(ledger);
      this.paused.delete(name);
    });
  }

  private async pipe(args: string[], input: Buffer): Promise<Buffer> {
    const cwd = await this.protectedCwd();
    return this.pipeAt(args, input, cwd);
  }

  private pipeAt(args: string[], input: Buffer, cwd: string, beforeSpawn?: () => void): Promise<Buffer> {
    beforeSpawn?.();
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.sbxExecutable, args, { cwd, env: sbxEnv(this.config.sbxHome), stdio: 'pipe' });
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
      const fail = () => { if (settled) return; settled = true; clearTimeout(timeout); reject(unavailable()); };
      child.stdout.on('data', (part: Buffer) => {
        size += part.length;
        if (size > MAX_CAPTURE_BYTES) { child.kill('SIGKILL'); fail(); return; }
        chunks.push(part);
      });
      child.stderr.resume();
      child.on('error', fail);
      child.on('close', code => {
        if (settled) return;
        settled = true; clearTimeout(timeout);
        if (code !== 0) reject(unavailable()); else resolve(Buffer.concat(chunks));
      });
      child.stdin.on('error', fail);
      child.stdin.end(input);
    });
  }
}
