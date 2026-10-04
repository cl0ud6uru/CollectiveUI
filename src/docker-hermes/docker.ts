import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { RpcTransport } from '../local-hermes/rpc';
import { HERMES_COMMIT } from '../local-hermes/config';
import { LocalError } from '../local-hermes/controller';
import { ownerId, type NativeResources } from './types';
import type { ProfileSettings, ProfileUpdate, ProfileTestResult } from './settings';

const absolute = z.string().refine(v => path.isAbsolute(v) && !/[\x00-\x1f,]/.test(v));
export const BrokerConfig = z.object({
  socketPath: absolute, stateDir: absolute, bridgePath: absolute,
  // Exact official image pin only. Tags/latest, registries and arbitrary images aren't accepted.
  image: z.string().regex(/^nousresearch\/hermes-agent@sha256:[a-f0-9]{64}$/),
  namespace: z.string().regex(/^cui-[a-z0-9-]{1,24}$/),
  memoryMb: z.number().int().min(512).max(16384).default(2048),
  cpus: z.number().min(0.25).max(8).default(2),
  maxUsers: z.number().int().min(1).max(1000).default(25),
  network: z.enum(['none', 'proxy']).default('none'),
  maxProfiles: z.number().int().min(1).max(64).default(16),
}).strict();
export type BrokerConfig = z.infer<typeof BrokerConfig>;
const exec = promisify(execFile);
const ENV = { NODE_ENV: 'production' as const, PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent', LANG: 'C.UTF-8' };
export const runtimeKey = (owner: string) => createHash('sha256').update(ownerId.parse(owner)).digest('hex');
export type Profile = { name: string; identity: string };
export interface RuntimeDriver {
  ensure(owner: string, stage: (phase: 'checking_image' | 'creating_storage' | 'starting_container' | 'checking_native') => void): Promise<void>;
  running(owner: string): Promise<boolean>;
  stop(owner: string): Promise<void>;
  profiles(owner: string): Promise<Profile[]>;
  create(owner: string, name: string): Promise<Profile>;
  resources(owner: string, name: string, identity: string): Promise<NativeResources>;
  settings?(owner: string, name: string, identity: string, update?: ProfileUpdate): Promise<ProfileSettings>;
  testSettings?(owner: string, name: string, identity: string, revision: string): Promise<Pick<ProfileTestResult, 'code'>>;
  reopen?(owner: string): Promise<void>;
  transport(owner: string, profile: string, identity: string): RpcTransport;
}

/** The only module that can call Docker. No browser-supplied argv, env, mounts or image names. */
export class DockerDriver implements RuntimeDriver {
  private stopping = new Map<string, Promise<void>>();
  constructor(readonly config: BrokerConfig) {}
  name(owner: string) { return `${this.config.namespace}-${runtimeKey(owner)}`; }
  protected async command(args: string[], timeout = 45000) {
    try { return (await exec('/usr/local/bin/docker', args, { env: ENV, timeout, maxBuffer: 8 * 1024 * 1024 })).stdout; }
    catch { throw new LocalError(503, 'Docker operation failed. Check broker diagnostics and storage; native data is retained.'); }
  }
  private networkName(owner: string) { return this.config.network === 'proxy' ? `${this.name(owner)}-egress` : 'none'; }
  private async checkNetwork(owner: string) {
    if (this.config.network === 'none') return;
    const [network] = JSON.parse(await this.command(['network', 'inspect', this.networkName(owner)]));
    if (network.Driver !== 'bridge' || !network.Internal ||
        network.Options?.['com.docker.network.bridge.gateway_mode_ipv4'] !== 'isolated' ||
        (network.EnableIPv6 && network.Options?.['com.docker.network.bridge.gateway_mode_ipv6'] !== 'isolated') ||
        network.Options?.['com.docker.network.bridge.trusted_host_interfaces'] || network.Labels?.['collective.owner'] !== runtimeKey(owner) ||
        network.Labels?.['collective.namespace'] !== this.config.namespace || network.Labels?.['collective.egress-policy'] !== 'deny-private-allowlist')
      throw new LocalError(409, 'An internal, isolated-gateway per-user network with a reviewed allowlist proxy is required. The broker does not alter host network policy.');
    for (const id of Object.keys(network.Containers ?? {})) {
      const [peer] = JSON.parse(await this.command(['inspect', id]));
      if (peer.Name === `/${this.name(owner)}`) continue;
      if (peer.Config.Labels?.['collective.egress-proxy'] !== 'true' || peer.Mounts?.some((m: {Destination: string}) => m.Destination === '/opt/data'))
        throw new LocalError(409, 'The private runtime network contains an unapproved peer.');
    }
  }
  private async inspect(owner: string) {
    const name = this.name(owner);
    const raw = await this.command(['container', 'ls', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}']);
    if (!raw.trim()) return null;
    const [info] = JSON.parse(await this.command(['inspect', name]));
    if (info.Config.Labels?.['collective.owner'] !== runtimeKey(owner) || info.Config.Labels?.['collective.namespace'] !== this.config.namespace ||
        info.Config.Image !== this.config.image || info.HostConfig.Privileged || info.HostConfig.NetworkMode !== this.networkName(owner) ||
        JSON.stringify(Object.keys(info.NetworkSettings?.Networks ?? {}).sort()) !== JSON.stringify([this.networkName(owner)]) ||
        info.HostConfig.PidMode || !['private', ''].includes(info.HostConfig.IpcMode ?? '') || info.HostConfig.UTSMode || info.HostConfig.UsernsMode ||
        info.HostConfig.Devices?.length || info.HostConfig.DeviceRequests?.length || info.HostConfig.ExtraHosts?.length ||
        JSON.stringify([...(info.HostConfig.CapDrop ?? [])].sort()) !== JSON.stringify(['ALL']) ||
        JSON.stringify([...(info.HostConfig.CapAdd ?? [])].sort()) !== JSON.stringify(['CAP_CHOWN', 'CAP_DAC_OVERRIDE', 'CAP_SETGID', 'CAP_SETUID']) ||
        !info.HostConfig.SecurityOpt?.includes('no-new-privileges:true') || info.HostConfig.SecurityOpt.some((v: string) => v !== 'no-new-privileges:true') ||
        info.HostConfig.Memory !== this.config.memoryMb * 1024 * 1024 || info.HostConfig.MemorySwap !== this.config.memoryMb * 1024 * 1024 ||
        info.HostConfig.NanoCpus !== this.config.cpus * 1e9 || info.HostConfig.PidsLimit !== 256 ||
        info.HostConfig.RestartPolicy?.Name !== 'no' || info.HostConfig.Binds?.length || Object.keys(info.HostConfig.PortBindings ?? {}).length ||
        info.Mounts.length !== 2 || !info.Mounts.some((m: { Type: string; Name: string; Destination: string }) => m.Type === 'volume' && m.Name === `${name}-data` && m.Destination === '/opt/data') ||
        !info.Mounts.some((m: { Type: string; Source: string; Destination: string; RW: boolean }) => m.Type === 'bind' && m.Source === this.config.bridgePath && m.Destination === '/opt/collective-bridge.py' && !m.RW))
      throw new LocalError(409, 'Runtime ownership or configuration changed. Operator reconciliation required.');
    return info;
  }
  async ensure(owner: string, stage: Parameters<RuntimeDriver['ensure']>[1], retained = false) {
    stage('checking_image');
    await this.checkNetwork(owner);
    // Pulling never builds from remote code or changes a moving tag.
    if (!retained) await this.command(['pull', this.config.image], 600000);
    let info = await this.inspect(owner);
    if (retained && !info) throw new LocalError(409, 'Retained runtime is missing. No replacement was created.');
    if (!info) {
      stage('creating_storage');
      const name = this.name(owner), volume = `${name}-data`;
      const known = (await this.command(['volume', 'ls', '--filter', `name=^${volume}$`, '--format', '{{.Name}}'])).trim();
      if (known) {
        const [v] = JSON.parse(await this.command(['volume', 'inspect', volume]));
        if (v.Driver !== 'local' || Object.keys(v.Options ?? {}).length || v.Labels?.['collective.owner'] !== runtimeKey(owner) || v.Labels?.['collective.namespace'] !== this.config.namespace)
          throw new LocalError(409, 'Unowned storage collision. No volume was adopted.');
      } else await this.command(['volume', 'create', '--label', `collective.owner=${runtimeKey(owner)}`, '--label', `collective.namespace=${this.config.namespace}`, volume]);
      stage('starting_container');
      await this.command(['create', '--name', name, '--label', `collective.owner=${runtimeKey(owner)}`, '--label', `collective.namespace=${this.config.namespace}`,
        '--network', this.networkName(owner), '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'DAC_OVERRIDE',
        '--security-opt', 'no-new-privileges:true', '--pids-limit', '256', '--memory', `${this.config.memoryMb}m`, '--memory-swap', `${this.config.memoryMb}m`, '--cpus', String(this.config.cpus),
        '--restart', 'no', '--log-driver', 'local', '--log-opt', 'max-size=5m', '--log-opt', 'max-file=2',
        '--mount', `type=volume,src=${volume},dst=/opt/data`, '--mount', `type=bind,src=${this.config.bridgePath},dst=/opt/collective-bridge.py,readonly`,
        '--env', 'HERMES_HOME=/opt/data', '--env', 'HERMES_DISABLE_LAZY_INSTALLS=1', '--env', 'HERMES_LAZY_INSTALL_TARGET=',
        ...(this.config.network === 'proxy' ? ['--env', 'HTTP_PROXY=http://hermes-egress:3128', '--env', 'HTTPS_PROXY=http://hermes-egress:3128', '--env', 'http_proxy=http://hermes-egress:3128', '--env', 'https_proxy=http://hermes-egress:3128', '--env', 'NO_PROXY=localhost,127.0.0.1', '--env', 'no_proxy=localhost,127.0.0.1'] : []),
        this.config.image, 'sleep', 'infinity'], 180000);
      info = await this.inspect(owner);
    }
    stage('starting_container');
    if (!info?.State.Running) await this.command(['start', this.name(owner)]);
    stage('checking_native');
    const deadline = Date.now() + 30000;
    while (true) {
      if (!await this.running(owner)) throw new LocalError(503, 'Native supervision exited during setup.');
      try {
        // s6 cont-init includes native profile reconciliation; don't race that writer.
        const supervised = await this.command(['exec', this.name(owner), '/command/s6-svstat', '-u', '/run/service/main-hermes']);
        if (supervised.trim() !== 'true') throw new Error('Native supervision is still initializing');
        const check = await this.native<{ revision: string; uid: number }>(owner, ['check']);
        if (check.revision !== HERMES_COMMIT || check.uid !== 10000) throw new LocalError(409, 'Unsupported native image revision or runtime identity.');
        if ((await this.profiles(owner)).some(p => p.name === 'default')) break;
      } catch (e) { if (e instanceof LocalError && e.status === 409) throw e; }
      if (Date.now() >= deadline) throw new LocalError(503, 'Native storage initialization did not become ready. Data is retained.');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  async running(owner: string) { await this.checkNetwork(owner); return !!(await this.inspect(owner))?.State.Running; }
  async stop(owner: string) {
    const pending = this.stopping.get(owner); if (pending) return pending;
    const task = (async () => {
      const info = await this.inspect(owner);
      if (info?.State.Running) await this.command(['stop', '--time', '10', this.name(owner)]);
      if ((await this.inspect(owner))?.State.Running) throw new LocalError(503, 'Native runtime stop is unconfirmed.');
    })();
    this.stopping.set(owner, task);
    try { await task; } finally { this.stopping.delete(owner); }
  }
  private argv(owner: string, args: string[]) {
    return ['exec', '-i', '--user', '10000:10000', '--workdir', '/opt/hermes', this.name(owner), '/opt/hermes/.venv/bin/python', '-B', '/opt/collective-bridge.py', ...args];
  }
  private async native<T>(owner: string, args: string[]): Promise<T> {
    if (!await this.running(owner)) throw new LocalError(409, 'Your Hermes runtime is stopped. Enable it in Settings.');
    try { return JSON.parse(await this.command(this.argv(owner, args))) as T; }
    catch { throw new LocalError(503, 'Native profile operation failed. Inspect that profile in its own runtime.'); }
  }
  profiles(owner: string) { return this.native<Profile[]>(owner, ['profiles']); }
  create(owner: string, name: string) { return this.native<Profile>(owner, ['create', name]); }
  resources(owner: string, name: string, identity: string) { return this.native<NativeResources>(owner, ['resources', name, identity]); }
  reopen(owner: string) { return this.ensure(owner, () => {}, true); }
  /** Secrets travel over stdin only, never argv, Docker environment, logs or broker journals. */
  private async settingsCommand<T>(owner: string, args: string[], data?: unknown): Promise<T> {
    if (!await this.running(owner)) throw new LocalError(409, 'Your Hermes runtime is stopped.');
    return new Promise((resolve, reject) => {
      const child = spawn('/usr/local/bin/docker', this.argv(owner, args), { env: ENV, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      let output = '', settled = false;
      const fail = () => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); reject(new LocalError(503, 'Native settings operation could not be confirmed. Reload the profile before retrying.')); };
      const timer = setTimeout(fail, 25000);
      child.stderr.resume(); child.stdin.on('error', () => {}); child.on('error', fail);
      child.stdout.setEncoding('utf8'); child.stdout.on('data', (s: string) => { output += s; if (Buffer.byteLength(output) > 32768) fail(); });
      child.on('close', code => {
        if (settled) return;
        if (code !== 0) { fail(); return; }
        clearTimeout(timer); settled = true;
        try {
          const value = JSON.parse(output);
          if (value.error) return reject(new LocalError(409, value.error === 'conflict' ? 'Profile settings changed. Reload before saving or testing.' : 'Native routing or credentials need maintenance outside this API-key editor. No settings were changed.'));
          resolve(value as T);
        } catch { reject(new LocalError(503, 'Native settings returned an invalid response.')); }
      });
      child.stdin.end(data === undefined ? '' : JSON.stringify(data));
    });
  }
  settings(owner: string, name: string, identity: string, update?: ProfileUpdate) {
    return this.settingsCommand<ProfileSettings>(owner, [update ? 'settings-save' : 'settings-read', name, identity], update);
  }
  testSettings(owner: string, name: string, identity: string, revision: string) {
    return this.settingsCommand<Pick<ProfileTestResult, 'code'>>(owner, ['settings-test', name, identity], { revision });
  }
  transport(owner: string, profile: string, identity: string): RpcTransport {
    return { spawn: () => spawn('/usr/local/bin/docker', this.argv(owner, ['gateway', profile, identity]), { env: ENV, stdio: ['pipe', 'pipe', 'pipe'], shell: false }),
      // Killing docker exec alone doesn't stop descendants. Stop the user's entire owned container;
      // sibling profiles get interrupted receipts, retain native sessions and restart explicitly.
      stop: () => this.stop(owner) };
  }
}
