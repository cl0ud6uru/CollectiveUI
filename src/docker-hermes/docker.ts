import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { CodexStatus } from './oauth';
import type { RpcTransport } from '../local-hermes/rpc';
import { HERMES_COMMIT } from '../local-hermes/config';
import { LocalError } from '../local-hermes/controller';
import { runtimeOwnerId, teamResourceSelection, type NativeResources, type TeamResourceSelection, type TeamPublishableSnapshot } from './types';
import type { ProfileSettings, ProfileUpdate, ProfileTestResult } from './settings';
import { networkMode, connectivityCode, type NetworkMode, type Connectivity, type NetworkMigration } from './network';
import { buildResourceHelper } from './resource-bundle';
import type { ResourceHelperRequest } from './resource-helper';
import { candidateBootstrap } from './candidate-bundle';
import type { TeamCandidateConfig } from './types';
import { beginResourceUpdate, type TeamResourceUpdatePlan, type ResourceUpdateReceipt } from '../lib/hermes-team/updates';
import { validateTeamResourceSnapshot } from '../lib/hermes-team/resources';
export const RESOURCE_PROTOCOL_BYTES = 160 * 1024 * 1024;
const RESOURCE_OUTPUT_BYTES = 64 * 1024 * 1024;

const absolute = z.string().refine(v => path.isAbsolute(v) && !/[\x00-\x1f,]/.test(v));
export const BrokerConfig = z.object({
  socketPath: absolute, stateDir: absolute, bridgePath: absolute,
  // Exact official image pin only. Tags/latest, registries and arbitrary images aren't accepted.
  image: z.string().regex(/^nousresearch\/hermes-agent@sha256:[a-f0-9]{64}$/),
  namespace: z.string().regex(/^cui-[a-z0-9-]{1,24}$/),
  memoryMb: z.number().int().min(512).max(16384).default(2048),
  cpus: z.number().min(0.25).max(8).default(2),
  maxUsers: z.number().int().min(1).max(1000).default(25),
  network: networkMode.default('internet'),
  maxProfiles: z.number().int().min(1).max(64).default(16),
  teamBotsEnabled: z.boolean().default(false),
  /** Active native candidates require a separate operator flag and server-verified admission. */
  teamCandidateRuntimeEnabled: z.boolean().default(false),
}).strict();
export type BrokerConfig = z.infer<typeof BrokerConfig>;
const exec = promisify(execFile);
const ENV = { NODE_ENV: 'production' as const, PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent', LANG: 'C.UTF-8' };
export const runtimeKey = (owner: string) => createHash('sha256').update(runtimeOwnerId.parse(owner)).digest('hex');
export type Profile = { name: string; identity: string };
export interface RuntimeDriver {
  ensure(owner: string, stage: (phase: 'checking_image' | 'creating_storage' | 'starting_container' | 'checking_native') => void): Promise<void>;
  running(owner: string): Promise<boolean>;
  stop(owner: string): Promise<void>;
  profiles(owner: string): Promise<Profile[]>;
  create(owner: string, name: string): Promise<Profile>;
  /** Blank Team profiles never clone the default profile's settings, credentials or learning. */
  createTeam?(owner: string, name: string): Promise<Profile>;
  /** A bounded network-none helper reads the exact retained volume while this runtime is stopped.
   * It derives profile root from name/identity and uses the publication engine, never arbitrary paths.
   * The helper never imports or runs native skills. */
  capturePublishableResources?(owner: string, name: string, identity: string, selection: TeamResourceSelection): Promise<TeamPublishableSnapshot>;
  inventoryPublishableResources?(owner: string, name: string, identity: string): Promise<TeamResourceSelection>;
  inventoryMemberResources?(owner: string, name: string, identity: string, trackedPackageIds: readonly string[]): Promise<TeamPublishableSnapshot>;
  applyTeamResourceUpdate?(owner: string, name: string, identity: string, operationId: string, plan: TeamResourceUpdatePlan, receipt?: ResourceUpdateReceipt): Promise<ResourceUpdateReceipt>;
  abortTeamResourceUpdate?(owner: string, name: string, identity: string, operationId: string, plan: TeamResourceUpdatePlan): Promise<{ aborted: true }>;
  resources(owner: string, name: string, identity: string): Promise<NativeResources>;
  settings?(owner: string, name: string, identity: string, update?: ProfileUpdate): Promise<ProfileSettings>;
  testSettings?(owner: string, name: string, identity: string, revision: string): Promise<Pick<ProfileTestResult, 'code'>>;
  codex?(owner: string, name: string, identity: string, data: unknown): Promise<CodexStatus>;
  reopen?(owner: string): Promise<void>;
  setNetwork?(owner: string, mode: NetworkMode): void;
  networkStatus?(owner: string): Promise<{ actual: NetworkMode | 'absent' | 'unknown'; running: boolean | null }>;
  snapshotNetwork?(owner: string, requestId: string): Promise<{ originalId: string | null; profiles: Profile[] }>;
  changeNetwork?(owner: string, migration: NetworkMigration, current: () => void): Promise<string>;
  finishNetwork?(owner: string, migration: NetworkMigration): Promise<void>;
  stopNetwork?(owner: string, migration: NetworkMigration): Promise<void>;
  rollbackNetwork?(owner: string, migration: NetworkMigration): Promise<void>;
  connectivity?(owner: string, provider: Connectivity['provider']): Promise<Connectivity['code']>;
  transport(owner: string, profile: string, identity: string): RpcTransport;
  /** Dormant candidate transport. Preparing this never starts a gateway or admits model work. */
  candidateTransport?(owner: string, profile: string, identity: string, config: TeamCandidateConfig): RpcTransport;
}

/** The only module that can call Docker. No browser-supplied argv, env, mounts or image names. */
export class DockerDriver implements RuntimeDriver {
  private stopping = new Map<string, Promise<void>>();
  private modes = new Map<string, NetworkMode>();
  private helperBundle?: Promise<string>;
  private helperGeneration = new Map<string, number>();
  private helperCleanups = new Map<string, Promise<void>>();
  private helpers = new Map<string, Set<{ name: string; created: Promise<string> }>>();
  constructor(readonly config: BrokerConfig) {}
  name(owner: string) { return `${this.config.namespace}-${runtimeKey(owner)}`; }
  protected async command(args: string[], timeout = 45000) {
    try { return (await exec('/usr/local/bin/docker', args, { env: ENV, timeout, maxBuffer: 8 * 1024 * 1024 })).stdout; }
    catch { throw new LocalError(503, 'Docker operation failed. Check broker diagnostics and storage; native data is retained.'); }
  }
  setNetwork(owner: string, mode: NetworkMode) { this.modes.set(runtimeOwnerId.parse(owner), networkMode.parse(mode)); }
  private mode(owner: string) { return this.modes.get(owner) ?? this.config.network; }
  private networkName(owner: string, mode = this.mode(owner)) { return mode === 'none' ? 'none' : `${this.name(owner)}-${mode === 'proxy' ? 'egress' : 'internet'}`; }
  private async checkNetwork(owner: string, mode = this.mode(owner), create = false) {
    if (mode === 'none') return;
    const name = this.networkName(owner, mode);
    if (mode === 'internet' && create) {
      const found = (await this.command(['network', 'ls', '--filter', `name=^${name}$`, '--format', '{{.ID}}'])).trim();
      if (!found) await this.command(['network', 'create', '--driver', 'bridge', '--label', `collective.owner=${runtimeKey(owner)}`,
        '--label', `collective.namespace=${this.config.namespace}`, '--label', 'collective.egress-policy=standard',
        '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=nat', '--opt', 'com.docker.network.bridge.enable_icc=false', name]);
    }
    const [network] = JSON.parse(await this.command(['network', 'inspect', name]));
    if (mode === 'internet') {
      if (network.Driver !== 'bridge' || network.Internal || network.EnableIPv6 ||
          (network.Options?.['com.docker.network.bridge.gateway_mode_ipv4'] ?? 'nat') !== 'nat' ||
          network.Options?.['com.docker.network.bridge.enable_icc'] !== 'false' ||
          network.Options?.['com.docker.network.bridge.trusted_host_interfaces'] ||
          network.Options?.['com.docker.network.bridge.enable_ip_masquerade'] === 'false' ||
          network.Labels?.['collective.owner'] !== runtimeKey(owner) || network.Labels?.['collective.namespace'] !== this.config.namespace ||
          network.Labels?.['collective.egress-policy'] !== 'standard')
        throw new LocalError(409, 'The dedicated Standard Internet network changed. Ask the operator to reconcile it.');
      if (Object.values(network.Containers ?? {}).some((peer: unknown) => (peer as { Name?: string }).Name !== this.name(owner)))
        throw new LocalError(409, 'The dedicated Standard Internet network contains another container.');
      return;
    }
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
  private async inspect(owner: string, name = this.name(owner), mode = this.mode(owner)) {
    const raw = await this.command(['container', 'ls', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}']);
    if (!raw.trim()) return null;
    const [info] = JSON.parse(await this.command(['inspect', name]));
    if (info.Config.Labels?.['collective.owner'] !== runtimeKey(owner) || info.Config.Labels?.['collective.namespace'] !== this.config.namespace ||
        info.Config.Image !== this.config.image || info.HostConfig.Privileged || info.HostConfig.NetworkMode !== this.networkName(owner, mode) ||
        JSON.stringify(Object.keys(info.NetworkSettings?.Networks ?? {}).sort()) !== JSON.stringify([this.networkName(owner, mode)]) ||
        info.HostConfig.PidMode || !['private', ''].includes(info.HostConfig.IpcMode ?? '') || info.HostConfig.UTSMode || info.HostConfig.UsernsMode ||
        info.HostConfig.Devices?.length || info.HostConfig.DeviceRequests?.length || info.HostConfig.ExtraHosts?.length ||
        JSON.stringify([...(info.HostConfig.CapDrop ?? [])].sort()) !== JSON.stringify(['ALL']) ||
        JSON.stringify([...(info.HostConfig.CapAdd ?? [])].sort()) !== JSON.stringify(['CAP_CHOWN', 'CAP_DAC_OVERRIDE', 'CAP_SETGID', 'CAP_SETUID']) ||
        !info.HostConfig.SecurityOpt?.includes('no-new-privileges:true') || info.HostConfig.SecurityOpt.some((v: string) => v !== 'no-new-privileges:true') ||
        info.HostConfig.Memory !== this.config.memoryMb * 1024 * 1024 || info.HostConfig.MemorySwap !== this.config.memoryMb * 1024 * 1024 ||
        info.HostConfig.NanoCpus !== this.config.cpus * 1e9 || info.HostConfig.PidsLimit !== 256 ||
        info.HostConfig.RestartPolicy?.Name !== 'no' || info.HostConfig.Binds?.length || Object.keys(info.HostConfig.PortBindings ?? {}).length ||
        info.Mounts.length !== 2 || !info.Mounts.some((m: { Type: string; Name: string; Destination: string; RW: boolean }) => m.Type === 'volume' && m.Name === `${this.name(owner)}-data` && m.Destination === '/opt/data' && m.RW) ||
        !info.Mounts.some((m: { Type: string; Source: string; Destination: string; RW: boolean }) => m.Type === 'bind' && m.Source === this.config.bridgePath && m.Destination === '/opt/collective-bridge.py' && !m.RW))
      throw new LocalError(409, 'Runtime ownership or configuration changed. Operator reconciliation required.');
    return info;
  }
  private async volume(owner: string, required = false) {
    const volume = `${this.name(owner)}-data`;
    const known = (await this.command(['volume', 'ls', '--filter', `name=^${volume}$`, '--format', '{{.Name}}'])).trim();
    if (!known && required) throw new LocalError(409, 'Retained native storage is missing. No replacement storage was created.');
    if (known) {
      const [v] = JSON.parse(await this.command(['volume', 'inspect', volume]));
      if (v.Name !== volume || v.Driver !== 'local' || Object.keys(v.Options ?? {}).length || v.Labels?.['collective.owner'] !== runtimeKey(owner) || v.Labels?.['collective.namespace'] !== this.config.namespace)
        throw new LocalError(409, 'Unowned storage collision. No volume was adopted.');
    } else await this.command(['volume', 'create', '--label', `collective.owner=${runtimeKey(owner)}`, '--label', `collective.namespace=${this.config.namespace}`, volume]);
    return volume;
  }
  async ensure(owner: string, stage: Parameters<RuntimeDriver['ensure']>[1], retained = false, migration?: { requestId: string; current: () => void }) {
    stage('checking_image');
    await this.assertTeamResourceUpdatesSettled(owner);
    await this.checkNetwork(owner, this.mode(owner), !retained);
    // Pulling never builds from remote code or changes a moving tag.
    if (!retained && !migration) await this.command(['pull', this.config.image], 600000);
    migration?.current();
    let info = await this.inspect(owner);
    if (retained && !info) throw new LocalError(409, 'Retained runtime is missing. No replacement was created.');
    if (!info) {
      stage('creating_storage');
      const name = this.name(owner), volume = await this.volume(owner, !!migration);
      migration?.current();
      stage('starting_container');
      await this.command(['create', '--name', name, '--label', `collective.owner=${runtimeKey(owner)}`, '--label', `collective.namespace=${this.config.namespace}`,
        ...(migration ? ['--label', `collective.network-request=${migration.requestId}`] : []),
        '--network', this.networkName(owner), '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'DAC_OVERRIDE',
        '--security-opt', 'no-new-privileges:true', '--pids-limit', '256', '--memory', `${this.config.memoryMb}m`, '--memory-swap', `${this.config.memoryMb}m`, '--cpus', String(this.config.cpus),
        '--restart', 'no', '--log-driver', 'local', '--log-opt', 'max-size=5m', '--log-opt', 'max-file=2',
        '--mount', `type=volume,src=${volume},dst=/opt/data`, '--mount', `type=bind,src=${this.config.bridgePath},dst=/opt/collective-bridge.py,readonly`,
        '--env', 'HERMES_HOME=/opt/data', '--env', 'HERMES_DISABLE_LAZY_INSTALLS=1', '--env', 'HERMES_LAZY_INSTALL_TARGET=',
        ...(this.mode(owner) === 'proxy' ? ['--env', 'HTTP_PROXY=http://hermes-egress:3128', '--env', 'HTTPS_PROXY=http://hermes-egress:3128', '--env', 'http_proxy=http://hermes-egress:3128', '--env', 'https_proxy=http://hermes-egress:3128', '--env', 'NO_PROXY=localhost,127.0.0.1', '--env', 'no_proxy=localhost,127.0.0.1'] : []),
        this.config.image, 'sleep', 'infinity'], 180000);
      info = await this.inspect(owner);
    }
    stage('starting_container');
    migration?.current();
    if (!info?.State.Running) await this.command(['start', this.name(owner)]);
    migration?.current();
    stage('checking_native');
    const deadline = Date.now() + 30000;
    while (true) {
      migration?.current();
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
    // Invalidate helper admission before waiting on either native or helper Docker calls.
    this.helperGeneration.set(owner, (this.helperGeneration.get(owner) ?? 0) + 1);
    const pending = this.stopping.get(owner); if (pending) return pending;
    const task = (async () => {
      let helperFailed = false;
      try { await this.stopResourceHelpers(owner); } catch { helperFailed = true; }
      const info = await this.inspect(owner);
      if (info?.State.Running) await this.command(['stop', '--time', '10', this.name(owner)]);
      if ((await this.inspect(owner))?.State.Running) throw new LocalError(503, 'Native runtime stop is unconfirmed.');
      if (helperFailed) throw new LocalError(503, 'Owned resource helper cleanup is unconfirmed. Native data is retained.');
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
  createTeam(owner: string, name: string) { return this.native<Profile>(owner, ['create-team', name]); }
  private async updatesVolume(owner: string, create = false) {
    const name = `${this.name(owner)}-team-updates`;
    const known = (await this.command(['volume', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}'])).trim();
    if (!known) {
      if (!create) return null;
      await this.command(['volume', 'create', '--label', `collective.owner=${runtimeKey(owner)}`, '--label', `collective.namespace=${this.config.namespace}`,
        '--label', 'collective.purpose=team-resource-journals', name]);
    }
    const [volume] = JSON.parse(await this.command(['volume', 'inspect', name]));
    if (volume.Name !== name || volume.Driver !== 'local' || Object.keys(volume.Options ?? {}).length
      || volume.Labels?.['collective.owner'] !== runtimeKey(owner) || volume.Labels?.['collective.namespace'] !== this.config.namespace
      || volume.Labels?.['collective.purpose'] !== 'team-resource-journals') throw new LocalError(409, 'Resource journal storage ownership changed.');
    return name;
  }
  private async inspectResourceHelper(owner: string, id: string) {
    const [info] = JSON.parse(await this.command(['inspect', id]));
    const prefix = `${this.name(owner)}-resources-`, name = String(info.Name ?? '').replace(/^\//, '');
    const source = info.Mounts?.find((mount: { Destination: string }) => mount.Destination === '/opt/collective-resource-helper.mjs');
    const operation = info.Config.Labels?.['collective.helper-operation'];
    const initialize = operation === 'initialize-journals', native = !['fence', 'initialize-journals'].includes(operation);
    const journal = info.Mounts?.find((mount: { Destination: string }) => mount.Destination === '/run/collective-team-updates');
    const data = info.Mounts?.find((mount: { Destination: string }) => mount.Destination === '/opt/data');
    const mask = info.HostConfig.Mounts?.filter((mount: { Type: string }) => mount.Type === 'tmpfs') ?? [];
    if (!['fence', 'initialize-journals', 'capture', 'discover', 'inventory', 'apply', 'abort'].includes(operation)
      || !name.startsWith(prefix) || !/^[a-f0-9]{32}$/.test(name.slice(prefix.length)) || info.Config.Labels?.['collective.owner'] !== runtimeKey(owner)
      || info.Config.Labels?.['collective.namespace'] !== this.config.namespace || info.Config.Labels?.['collective.purpose'] !== 'team-resource-helper'
      || info.Config.Image !== this.config.image || JSON.stringify(info.Config.Entrypoint) !== JSON.stringify(['/usr/local/bin/node'])
      || JSON.stringify(info.Config.Cmd) !== JSON.stringify(['/opt/collective-resource-helper.mjs', '--run']) || info.HostConfig.Privileged
      || info.HostConfig.NetworkMode !== 'none' || !info.HostConfig.ReadonlyRootfs || info.Config.User !== (initialize ? '0:0' : '10000:10000')
      || info.HostConfig.PidMode || !['private', ''].includes(info.HostConfig.IpcMode ?? '') || info.HostConfig.UTSMode || info.HostConfig.UsernsMode || info.HostConfig.ExtraHosts?.length
      || JSON.stringify(Object.keys(info.NetworkSettings?.Networks ?? {}).sort()) !== JSON.stringify(['none']) || info.HostConfig.Devices?.length || info.HostConfig.DeviceRequests?.length
      || info.HostConfig.Binds?.length || Object.keys(info.HostConfig.PortBindings ?? {}).length
      || (initialize ? JSON.stringify(info.HostConfig.CapAdd) !== JSON.stringify(['CAP_CHOWN']) : info.HostConfig.CapAdd?.length)
      || JSON.stringify(info.HostConfig.CapDrop) !== JSON.stringify(['ALL']) || JSON.stringify(info.HostConfig.SecurityOpt) !== JSON.stringify(['no-new-privileges:true'])
      || info.HostConfig.PidsLimit !== 32 || info.HostConfig.Memory !== 512 * 1024 * 1024 || info.HostConfig.MemorySwap !== 512 * 1024 * 1024
      || info.HostConfig.NanoCpus !== 1e9 || info.HostConfig.RestartPolicy?.Name !== 'no' || info.HostConfig.LogConfig?.Type !== 'none'
      || !source || source.Type !== 'bind' || source.RW || path.dirname(source.Source) !== path.join(this.config.stateDir, 'resource-helpers')
      || !/^[a-f0-9]{64}\.mjs$/.test(path.basename(source.Source))
      || info.Mounts.length !== 2 + (journal ? 1 : 0) || Object.keys(info.HostConfig.Tmpfs ?? {}).length
      || (native ? !data || data.RW !== ['apply', 'abort'].includes(operation) || mask.length
        : !data || data.Type !== 'tmpfs' || data.Source || data.RW || mask.length !== 1 || mask[0].Target !== '/opt/data' || mask[0].ReadOnly !== true || mask[0].TmpfsOptions?.SizeBytes !== 4096 || mask[0].TmpfsOptions?.Mode !== 0o700)
      || (journal && journal.RW !== (['apply', 'abort'].includes(operation) || initialize)) || (['apply', 'abort', 'initialize-journals', 'fence'].includes(operation) && !journal)
      || info.Mounts.some((mount: { Type: string; Name: string; Destination: string; RW: boolean }) => mount.Destination !== '/opt/collective-resource-helper.mjs'
        && !(!native && mount.Type === 'tmpfs' && mount.Destination === '/opt/data' && !mount.RW)
        && !(mount.Type === 'volume' && ((!initialize && mount.Name === `${this.name(owner)}-data` && mount.Destination === '/opt/data')
          || (mount.Name === `${this.name(owner)}-team-updates` && mount.Destination === '/run/collective-team-updates')))))
      throw new LocalError(409, 'Resource helper ownership or isolation changed.');
    return info;
  }
  private async stopResourceHelpers(owner: string) {
    // A create admitted before cancellation may still be reaching the daemon. Await that
    // bounded create before scanning; its generation check prevents a later start.
    await Promise.all([...this.helpers.get(owner) ?? []].map(helper => helper.created.catch(() => '')));
    const ids = (await this.command(['container', 'ls', '-a', '--filter', `label=collective.owner=${runtimeKey(owner)}`,
      '--filter', `label=collective.namespace=${this.config.namespace}`, '--filter', 'label=collective.purpose=team-resource-helper', '--format', '{{.ID}}'])).trim().split(/\s+/).filter(Boolean);
    const results = await Promise.allSettled(ids.map(async id => {
      const info = await this.inspectResourceHelper(owner, id);
      await this.cleanupResourceHelper(owner, String(info.Name).replace(/^\//, ''));
    }));
    if (results.some(result => result.status === 'rejected')) throw new LocalError(503, 'Resource helper cleanup could not be confirmed.');
  }
  private async cleanupResourceHelper(owner: string, name: string) {
    const pending = this.helperCleanups.get(name); if (pending) return pending;
    const task = (async () => {
      const ids = (await this.command(['container', 'ls', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'])).trim().split(/\s+/).filter(Boolean);
      if (!ids.length) return;
      if (ids.length !== 1) throw new LocalError(409, 'Resource helper identity is ambiguous.');
      const info = await this.inspectResourceHelper(owner, ids[0]);
      if (info.State.Running) await this.command(['stop', '--time', '0', info.Id]);
      if ((await this.inspectResourceHelper(owner, info.Id)).State.Running) throw new LocalError(503, 'Resource helper stop is unconfirmed.');
      await this.command(['container', 'rm', info.Id]);
    })();
    this.helperCleanups.set(name, task);
    try { await task; } finally { this.helperCleanups.delete(name); }
  }
  /** JSON travels only on stdin/stdout. Helper output is never written to Docker logs. */
  protected resourceCommand(args: string[], input: unknown): Promise<unknown> {
    const payload = JSON.stringify(input);
    if (Buffer.byteLength(payload) > RESOURCE_PROTOCOL_BYTES) throw new LocalError(413, 'The resource update exceeds the bounded helper protocol.');
    return new Promise((resolve, reject) => {
      const child = spawn('/usr/local/bin/docker', args, { env: ENV, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      let output = '', bytes = 0, settled = false;
      const fail = () => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); reject(new LocalError(503, 'Resource helper completion is unconfirmed. Retained data needs reconciliation.')); };
      const timer = setTimeout(fail, 30000);
      child.stderr.resume(); child.stdin.on('error', () => {}); child.on('error', fail);
      child.stdout.setEncoding('utf8'); child.stdout.on('data', (part: string) => { bytes += Buffer.byteLength(part); if (bytes > RESOURCE_OUTPUT_BYTES) return fail(); output += part; });
      child.on('close', code => {
        if (settled) return;
        if (code !== 0) return fail();
        clearTimeout(timer); settled = true;
        try {
          const result = JSON.parse(output);
          if (!result || result.ok !== true || !('value' in result)) throw new Error('Invalid helper result');
          resolve(result.value);
        } catch { reject(new LocalError(503, 'The resource helper refused an unsafe or changed resource.')); }
      });
      child.stdin.end(payload);
    });
  }
  private async resourceHelper(owner: string, input: ResourceHelperRequest): Promise<unknown> {
    runtimeOwnerId.parse(owner);
    if (Buffer.byteLength(JSON.stringify(input)) > RESOURCE_PROTOCOL_BYTES) throw new LocalError(413, 'The resource update exceeds the bounded helper protocol.');
    if (input.operation === 'apply' || input.operation === 'abort') beginResourceUpdate(input.operationId, input.plan, input.operation === 'apply' ? input.receipt : undefined);
    if (input.operation === 'capture') teamResourceSelection.parse(input.selection);
    const generation = this.helperGeneration.get(owner) ?? 0;
    const current = () => { if ((this.helperGeneration.get(owner) ?? 0) !== generation) throw new LocalError(409, 'Resource helper admission was revoked.'); };
    if ((await this.inspect(owner))?.State.Running) throw new LocalError(409, 'Stop the entire native runtime before accessing retained Team resources.');
    const journal = await this.updatesVolume(owner, ['apply', 'abort', 'initialize-journals'].includes(input.operation)); current();
    if (input.operation === 'fence' && !journal) return { settled: true };
    if (['apply', 'abort'].includes(input.operation)) { await this.resourceHelper(owner, { operation: 'initialize-journals' }); current(); }
    const native = input.operation === 'fence' || input.operation === 'initialize-journals' ? null : await this.volume(owner, true); current();
    this.helperBundle ??= buildResourceHelper(this.config.stateDir).catch(error => { this.helperBundle = undefined; throw error; });
    const source = await this.helperBundle; current();
    const name = `${this.name(owner)}-resources-${randomUUID().replaceAll('-', '')}`;
    const created = this.command(['create', '--pull', 'never', '--name', name, '--interactive',
      '--label', `collective.owner=${runtimeKey(owner)}`, '--label', `collective.namespace=${this.config.namespace}`, '--label', 'collective.purpose=team-resource-helper',
      '--label', `collective.helper-operation=${input.operation}`,
      '--network', 'none', '--read-only', '--user', input.operation === 'initialize-journals' ? '0:0' : '10000:10000', '--cap-drop', 'ALL',
      ...(input.operation === 'initialize-journals' ? ['--cap-add', 'CHOWN'] : []), '--security-opt', 'no-new-privileges:true', '--pids-limit', '32',
      '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--restart', 'no', '--log-driver', 'none',
      ...(native ? ['--mount', `type=volume,src=${native},dst=/opt/data${['apply', 'abort'].includes(input.operation) ? '' : ',readonly'}`]
        // The pinned image declares VOLUME /opt/data. Mask it explicitly so metadata-only
        // helpers cannot acquire an anonymous native volume or run image initialization.
        : ['--mount', 'type=tmpfs,dst=/opt/data,readonly,tmpfs-size=4096,tmpfs-mode=0700']),
      ...(journal ? ['--mount', `type=volume,src=${journal},dst=/run/collective-team-updates${['apply', 'abort', 'initialize-journals'].includes(input.operation) ? '' : ',readonly'}`] : []),
      '--mount', `type=bind,src=${source},dst=/opt/collective-resource-helper.mjs,readonly`, '--env', 'NODE_ENV=production', '--env', 'HOME=/nonexistent',
      '--entrypoint', '/usr/local/bin/node', this.config.image, '/opt/collective-resource-helper.mjs', '--run']);
    const helper = { name, created }, active = this.helpers.get(owner) ?? new Set<typeof helper>(); active.add(helper); this.helpers.set(owner, active);
    try {
      const id = (await created).trim(); current();
      const info = await this.inspectResourceHelper(owner, id); current();
      if ((await this.inspect(owner))?.State.Running) throw new LocalError(409, 'The native runtime reopened during resource maintenance.');
      current(); const result = await this.resourceCommand(['start', '--attach', '--interactive', info.Id], input); current(); return result;
    } finally {
      // Cancellation and normal completion share one cleanup to avoid racing removals.
      try { await created.catch(() => ''); await this.cleanupResourceHelper(owner, name); }
      finally { active.delete(helper); if (!active.size) this.helpers.delete(owner); }
    }
  }
  private async assertTeamResourceUpdatesSettled(owner: string) {
    if (!await this.updatesVolume(owner)) return;
    await this.resourceHelper(owner, { operation: 'fence' });
  }
  async capturePublishableResources(owner: string, name: string, identity: string, selection: TeamResourceSelection) {
    return validateTeamResourceSnapshot(await this.resourceHelper(owner, { operation: 'capture', profile: name, identity, selection }) as TeamPublishableSnapshot);
  }
  async inventoryPublishableResources(owner: string, name: string, identity: string) {
    return teamResourceSelection.parse(await this.resourceHelper(owner, { operation: 'discover', profile: name, identity }));
  }
  async inventoryMemberResources(owner: string, name: string, identity: string, trackedPackageIds: readonly string[]) {
    return validateTeamResourceSnapshot(await this.resourceHelper(owner, { operation: 'inventory', profile: name, identity, trackedPackageIds }) as TeamPublishableSnapshot, { requireCompleteSkills: false });
  }
  async applyTeamResourceUpdate(owner: string, name: string, identity: string, operationId: string, plan: TeamResourceUpdatePlan, receipt?: ResourceUpdateReceipt) {
    const result = await this.resourceHelper(owner, { operation: 'apply', profile: name, identity, operationId, plan, ...(receipt ? { receipt } : {}) }) as ResourceUpdateReceipt;
    return beginResourceUpdate(operationId, plan, result);
  }
  async abortTeamResourceUpdate(owner: string, name: string, identity: string, operationId: string, plan: TeamResourceUpdatePlan): Promise<{ aborted: true }> {
    const result = await this.resourceHelper(owner, { operation: 'abort', profile: name, identity, operationId, plan });
    if (!result || (result as { aborted?: unknown }).aborted !== true) throw new LocalError(503, 'Resource update abort was not confirmed.');
    return { aborted: true };
  }
  resources(owner: string, name: string, identity: string) { return this.native<NativeResources>(owner, ['resources', name, identity]); }
  reopen(owner: string) { return this.ensure(owner, () => {}, true); }
  private backupName(owner: string, requestId: string) { return `${this.name(owner)}-network-${z.string().uuid().parse(requestId).replaceAll('-', '')}`; }
  async networkStatus(owner: string) {
    const found = (await this.command(['container', 'ls', '-a', '--filter', `name=^/${this.name(owner)}$`, '--format', '{{.ID}}'])).trim();
    if (!found) return { actual: 'absent' as const, running: false };
    // A failed inspection must never be projected as the requested policy taking effect.
    const info = await this.inspect(owner);
    return { actual: this.mode(owner), running: !!info?.State.Running };
  }
  private identity(info: { Id: string; Config: { Labels?: Record<string, string> } } | null, expected: string | null, requestId?: string) {
    if (info && (expected ? info.Id !== expected : !requestId || info.Config.Labels?.['collective.network-request'] !== requestId))
      throw new LocalError(409, 'Network migration container identity changed. Operator reconciliation is required.');
  }
  async snapshotNetwork(owner: string, requestId: string) {
    const info = await this.inspect(owner);
    if (!info) return { originalId: null, profiles: [] };
    await this.volume(owner, true);
    if (info.State.Running) return { originalId: info.Id as string, profiles: await this.profiles(owner) };
    // A stopped runtime stays stopped. A bounded read-only helper reads the SAME retained volume.
    const helper = `${this.backupName(owner, requestId)}-inspect`;
    let profiles: Profile[];
    try {
      const result = await this.command(['run', '--rm', '--name', helper, '--network', 'none', '--read-only', '--user', '10000:10000',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '32', '--memory', '512m', '--cpus', '1',
        '--label', `collective.owner=${runtimeKey(owner)}`, '--label', `collective.namespace=${this.config.namespace}`,
        '--mount', `type=volume,src=${this.name(owner)}-data,dst=/opt/data,readonly`,
        '--mount', `type=bind,src=${this.config.bridgePath},dst=/opt/collective-bridge.py,readonly`,
        '--env', 'HERMES_HOME=/opt/data', '--env', 'PYTHONDONTWRITEBYTECODE=1', '--workdir', '/opt/hermes',
        '--entrypoint', '/opt/hermes/.venv/bin/python', this.config.image, '-B', '/opt/collective-bridge.py', 'profiles'], 20000);
      profiles = z.array(z.object({ name: z.string(), identity: z.string() }).strict()).parse(JSON.parse(result));
    } finally {
      // The helper has no native writers or network access; --rm normally already removed it.
      const ids = (await this.command(['container', 'ls', '-a', '--filter', `name=^/${helper}$`, '--filter', `label=collective.owner=${runtimeKey(owner)}`, '--format', '{{.ID}}'])).trim();
      if (ids) await this.command(['container', 'rm', '-f', helper]);
    }
    return { originalId: info.Id as string, profiles };
  }
  async changeNetwork(owner: string, m: NetworkMigration, current: () => void) {
    const old = await this.inspect(owner, this.name(owner), m.previous);
    this.identity(old, m.originalId);
    if (!old || old.State.Running) throw new LocalError(409, 'Stop the retained runtime before changing its network.');
    await this.volume(owner, true); current();
    const backup = this.backupName(owner, m.requestId);
    if (await this.inspect(owner, backup, m.previous)) throw new LocalError(409, 'A retained network migration already exists.');
    await this.checkNetwork(owner, m.requested, true); current();
    await this.command(['container', 'rename', this.name(owner), backup]); current();
    this.setNetwork(owner, m.requested);
    await this.ensure(owner, () => current(), false, { requestId: m.requestId, current }); current();
    const replacement = await this.inspect(owner);
    this.identity(replacement, null, m.requestId);
    const roster = (v: Profile[]) => JSON.stringify([...v].sort((a, b) => a.name.localeCompare(b.name)));
    if (roster(await this.profiles(owner)) !== roster(m.profiles)) throw new LocalError(409, 'Retained native profile identities changed during restart.');
    return replacement.Id as string;
  }
  async finishNetwork(owner: string, m: NetworkMigration) {
    this.setNetwork(owner, m.requested);
    const replacement = await this.inspect(owner);
    this.identity(replacement, m.replacementId, m.requestId);
    if (m.originalId && !replacement) throw new LocalError(409, 'Committed network replacement is missing.');
    const backup = this.backupName(owner, m.requestId), old = await this.inspect(owner, backup, m.previous);
    this.identity(old, m.originalId);
    if (old?.State.Running) await this.command(['stop', '--time', '10', old.Id]);
    if (old) await this.command(['container', 'rm', old.Id]); // Never remove the named volume.
  }
  /** Crash cleanup stops BOTH exact receipt-owned identities before attempting restoration/deletion. */
  async stopNetwork(owner: string, m: NetworkMigration) {
    let failed = false;
    try {
      const ids = (await this.command(['container', 'ls', '-a', '--filter', `name=^/${this.name(owner)}$`, '--format', '{{.ID}}'])).trim();
      if (ids) {
        const [raw] = JSON.parse(await this.command(['inspect', this.name(owner)]));
        const original = raw.Id === m.originalId;
        const info = await this.inspect(owner, this.name(owner), original ? m.previous : m.requested);
        this.identity(info, original ? m.originalId : m.replacementId, original ? undefined : m.requestId);
        if (info?.State.Running) await this.command(['stop', '--time', '10', info.Id]);
        if ((await this.inspect(owner, this.name(owner), original ? m.previous : m.requested))?.State.Running) throw new Error('Stop unconfirmed');
      }
    } catch { failed = true; }
    try {
      const backup = this.backupName(owner, m.requestId), old = await this.inspect(owner, backup, m.previous);
      this.identity(old, m.originalId);
      if (old?.State.Running) await this.command(['stop', '--time', '10', old.Id]);
      if ((await this.inspect(owner, backup, m.previous))?.State.Running) throw new Error('Stop unconfirmed');
    } catch { failed = true; }
    if (failed) throw new LocalError(503, 'Migration cleanup is unconfirmed. Operator reconciliation is required; native storage is retained.');
  }
  async rollbackNetwork(owner: string, m: NetworkMigration) {
    await this.stopNetwork(owner, m); // Independent of whether the backup still exists.
    const backup = this.backupName(owner, m.requestId), old = await this.inspect(owner, backup, m.previous);
    this.identity(old, m.originalId);
    if (old) {
      if (old.State.Running) await this.command(['stop', '--time', '10', old.Id]);
      const replacement = await this.inspect(owner, this.name(owner), m.requested);
      this.identity(replacement, m.replacementId, m.requestId);
      if (replacement) {
        if (replacement.State.Running) await this.command(['stop', '--time', '10', replacement.Id]);
        await this.command(['container', 'rm', replacement.Id]);
      }
      await this.volume(owner, true);
      await this.command(['container', 'rename', old.Id, this.name(owner)]);
    }
    this.setNetwork(owner, m.previous);
    const original = await this.inspect(owner);
    this.identity(original, m.originalId);
    if (m.originalId && !original) throw new LocalError(409, 'Retained network rollback needs operator reconciliation.');
    if (original?.State.Running) await this.command(['stop', '--time', '10', original.Id]);
    if ((await this.inspect(owner))?.State.Running) throw new LocalError(503, 'Retained runtime stop is unconfirmed.');
  }
  async connectivity(owner: string, provider: Connectivity['provider']) {
    const result = await this.settingsCommand<{ code: Connectivity['code'] }>(owner, ['network-check', provider, this.mode(owner)]);
    return connectivityCode.parse(result.code);
  }
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
          if (value.error) return reject(new LocalError(409, value.error === 'conflict' ? 'Profile settings changed. Reload before retrying.' : 'Native routing or credentials require native maintenance before editing here.'));
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
  codex(owner: string, name: string, identity: string, data: unknown) {
    return this.settingsCommand<CodexStatus>(owner, ['codex', name, identity], data);
  }
  transport(owner: string, profile: string, identity: string): RpcTransport {
    return { spawn: () => spawn('/usr/local/bin/docker', this.argv(owner, ['gateway', profile, identity]), { env: ENV, stdio: ['pipe', 'pipe', 'pipe'], shell: false }),
      // Killing docker exec alone doesn't stop descendants. Stop the user's entire owned container;
      // sibling profiles get interrupted receipts, retain native sessions and restart explicitly.
      stop: () => this.stop(owner) };
  }
  candidateTransport(owner: string, profile: string, identity: string, config: TeamCandidateConfig): RpcTransport {
    const bootstrap = candidateBootstrap(config);
    return { spawn: () => {
      if (config.expiresAt <= Date.now()) throw new LocalError(409, 'The native candidate grant expired.');
      const child = spawn('/usr/local/bin/docker', this.argv(owner, ['gateway-candidate', profile, identity]),
        { env: ENV, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      // Trusted configuration precedes RPC frames. It never appears in argv, env, native files or state journals.
      child.stdin.on('error', () => {});
      child.stdin.write(bootstrap);
      return child;
    }, stop: () => this.stop(owner) };
  }
}
