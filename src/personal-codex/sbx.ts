import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { ComputerInputSchema } from '../lib/computer/contracts';
import { ownerId } from './contracts';
import type { ComputerInput, ComputerStatus, PersonalCodexRuntimeDriver } from './driver';
import { SbxBrokerConfigSchema, runtimeKey, type SbxBrokerConfig } from './docker';

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

/** Docker Sandboxes CLI 0.48.0 adapter. It only addresses names derived from enrolled owner IDs. */
export class SbxPersonalCodexDriver implements PersonalCodexRuntimeDriver {
  readonly config: SbxBrokerConfig;
  private readonly paused = new Set<string>();
  private versionVerified = false;
  private ledgerQueue: Promise<unknown> = Promise.resolve();

  constructor(config: SbxBrokerConfig) {
    try { this.config = SbxBrokerConfigSchema.parse(config); }
    catch { throw unavailable(); }
  }

  name(owner: string) {
    const normalized = ownerId.parse(owner);
    if (!this.config.owners.includes(normalized)) throw unavailable();
    return `${this.config.namespace}-${runtimeKey(normalized)}`;
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

  private async snapshot(name: string) {
    const row = (await this.rows()).find(item => item.name === name);
    if (!row) return null;
    let raw: unknown;
    try { raw = JSON.parse((await this.command(['inspect', '--format', 'json', name])).toString('utf8')); }
    catch { throw unavailable(); }
    const parsed = inspectSchema.safeParse(raw);
    if (!parsed.success || parsed.data.name !== name) throw unavailable();
    return { row, details: parsed.data };
  }

  private validateSnapshot(snapshot: NonNullable<Awaited<ReturnType<SbxPersonalCodexDriver['snapshot']>>>, requireNoSessions = false) {
    const { row, details } = snapshot;
    const state = details.state.toLowerCase().trim();
    if (!['running', 'stopped'].includes(state) || (row.status ?? row.state)?.toLowerCase().trim() !== state) throw unavailable();
    const expectedDigest = this.config.template.slice(this.config.template.lastIndexOf('@sha256:') + 8);
    if (details.image_digest !== expectedDigest || details.workspace.trim() !== '') throw unavailable();
    const raw = details as Record<string, unknown>;
    const cpus = raw.cpus ?? raw.cpu_count ?? row.cpus ?? row.cpu_count;
    const memory = raw.memory_mib ?? raw.memory_mb ?? raw.memoryMiB ?? row.memory_mib ?? row.memory_mb;
    if (cpus !== this.config.cpus || memory !== this.config.memoryMb) throw unavailable();
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
    return { id: row.id, name: row.name, template: this.config.template, cpus: this.config.cpus, memoryMb: this.config.memoryMb };
  }

  async inspect(owner: string) {
    const name = this.name(owner);
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
    const actual = this.validateSnapshot(snapshot);
    if (JSON.stringify(actual) !== JSON.stringify(binding) || snapshot.row.id !== binding.id) throw unavailable();
    const status = snapshot.details.state.toLowerCase().trim();
    return { State: { Running: status === 'running' } };
  }

  async ensure(owner: string) {
    return this.exclusive(() => this.ensureExclusive(owner));
  }

  private async ensureExclusive(owner: string) {
    const name = this.name(owner);
    await this.verifyHostSettings();
    if (!(await this.inspect(owner))) {
      // Empty cwd, no workspace path, no kit/hooks, no env-file, no shared skills or MCP.
      // The digest-pinned template owns the guest entrypoint and includes the stock Codex app-server.
      await this.command(['create', 'shell', '--name', name, '--template', this.config.template,
        '--cpus', String(this.config.cpus), '--memory', `${this.config.memoryMb}m`, '--no-progress',
        '--pull', 'never', '--skills', 'off']);
      const snapshot = await this.snapshot(name);
      if (!snapshot) throw unavailable();
      const binding = this.validateSnapshot(snapshot, true);
      const ledger = await this.readLedger();
      if (ledger.bindings[runtimeKey(owner)]) throw unavailable();
      ledger.bindings[runtimeKey(owner)] = binding;
      await this.writeLedger(ledger);
    }
    await this.startRetained(owner);
  }

  async startRetained(owner: string) {
    const name = this.name(owner);
    const current = await this.inspect(owner);
    if (!current) throw unavailable();
    if (!current.State.Running) {
      // 0.48.0 `sbx exec` starts a stopped local sandbox before executing the command.
      await this.command(['exec', name, '/bin/true']);
    }
    if (!(await this.inspect(owner))?.State.Running) throw unavailable();
  }

  async bridge(owner: string): Promise<ChildProcessWithoutNullStreams> {
    const name = this.name(owner);
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
    if (!(await this.inspect(owner))?.State.Running) throw unavailable();
    await this.pipe(['exec', '--interactive', name, 'python3', '/opt/collective-computer/control.py', 'input'], Buffer.from(`${JSON.stringify(parsed)}\n`));
  }

  async computerPause(owner: string, paused: boolean): Promise<void> {
    const name = this.name(owner);
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

  async stop(owner: string) {
    const name = this.name(owner);
    if (!(await this.inspect(owner))) return;
    await this.command(['stop', '--format', 'json', name]);
    if ((await this.inspect(owner))?.State.Running) throw unavailable();
    this.paused.delete(name);
  }

  async cleanup(owner: string) {
    return this.exclusive(async () => {
      const name = this.name(owner);
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
