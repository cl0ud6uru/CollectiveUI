import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { PERSONAL_CODEX_WORKSPACE } from './workspace';
import { ownerId, tokenFingerprint } from './contracts';
import { sandboxPolicy } from './sandbox-policy.mjs';
import type { ComputerInput, ComputerStatus, PersonalCodexRuntimeDriver } from './driver';

const absolute = z.string().refine(v => isAbsolute(v) && !/[\x00-\x1f,]/.test(v));
const BrokerBase = z.object({
  socketPath: absolute,
  namespace: z.string().regex(/^cui-codex-[a-z0-9-]{1,20}$/),
  // Operator admission remains supported; self enrollment requires an installed capability and durable consent.
  owners: z.array(ownerId).max(1000),
});
const DockerBrokerConfig = BrokerBase.extend({
  backend: z.literal('docker').optional().default('docker'),
  // Registry manifest references and complete local config IDs are distinct
  // immutable forms. Neither admits a tag, abbreviated ID or automatic pull.
  image: z.string().regex(/^(?:collectiveui\/personal-codex@sha256:|sha256:)[a-f0-9]{64}$/),
  allowSelfEnrollment: z.boolean().default(false),
  sandboxProfile: z.literal('collectiveui-sandbox-v1').optional(),
  // True only after the installed image passes the reviewed SIWC shell/proc isolation proof.
  siwcSandboxVerified: z.boolean().default(false),
  dockerExecutable: z.enum(['/usr/local/bin/docker', '/usr/bin/docker']).default('/usr/local/bin/docker'),
  memoryMb: z.number().int().min(512).max(16384).default(2048),
  cpus: z.number().min(.25).max(8).default(2),
}).strict();
export type DockerBrokerConfig = z.infer<typeof DockerBrokerConfig>;
export const SbxBrokerConfigSchema = BrokerBase.extend({
  backend: z.literal('sbx'),
  // A digest-pinned trusted desktop image; sbx must never resolve a mutable tag.
  template: z.string().regex(/^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/),
  sbxExecutable: z.enum(['/usr/local/bin/sbx', '/usr/bin/sbx']).default('/usr/local/bin/sbx'),
  sbxVersion: z.literal('0.48.0').default('0.48.0'),
  sbxHome: absolute,
  memoryMb: z.number().int().min(512).max(65536),
  cpus: z.number().int().min(1).max(64),
  // Enables the separately authenticated owner-scoped admin adapter. Default stays disabled.
  adminEnabled: z.boolean().default(false),
  // Same operator verification gate as the Docker backend. Defaults to disabled.
  siwcSandboxVerified: z.boolean().default(false),
}).strict();
/** Legacy Docker-only schema remains the default public config contract. */
export const BrokerConfig = DockerBrokerConfig;
export type BrokerConfig = z.infer<typeof DockerBrokerConfig>;
/** Strict optional backend union used only by broker startup. */
export const PersonalCodexBrokerConfig = z.union([DockerBrokerConfig, SbxBrokerConfigSchema]);
export type PersonalCodexBrokerConfig = z.infer<typeof PersonalCodexBrokerConfig>;
export type SbxBrokerConfig = z.infer<typeof SbxBrokerConfigSchema>;
const exec = promisify(execFile);
export const dockerEnv = { NODE_ENV: 'production' as const, PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent', LANG: 'C.UTF-8' };
export const runtimeKey = (owner: string) => createHash('sha256').update(ownerId.parse(owner)).digest('hex');
const unavailable = () => new Error('Personal Codex runtime configuration or storage needs operator reconciliation. Data is retained.');

/** Only trusted provisioner code calls Docker. All names/mounts/commands are derived here. */
export class PersonalCodexDriver implements PersonalCodexRuntimeDriver {
  readonly config: DockerBrokerConfig;
  constructor(config: DockerBrokerConfig) { this.config = DockerBrokerConfig.parse(config); }
  private readonly enrolled = new Set<string>();
  admitted(owner: string) { return this.config.owners.includes(ownerId.parse(owner)) || this.enrolled.has(owner); }
  admittedOwners() { return [...new Set([...this.config.owners, ...this.enrolled])]; }
  admit(owner: string) { this.enrolled.add(ownerId.parse(owner)); }
  revokeAdmission(owner: string) { this.enrolled.delete(owner); }
  private resourceName(owner: string) { return `${this.config.namespace}-${runtimeKey(owner)}`; }
  private async policy() {
    try { return await sandboxPolicy(this.config.sandboxProfile); } catch { throw unavailable(); }
  }
  name(owner: string) {
    if (!this.admitted(owner)) throw unavailable();
    return this.resourceName(owner);
  }
  protected async command(args: string[]): Promise<string> {
    try { return (await exec(this.config.dockerExecutable, args, { env: dockerEnv, timeout: 45000, maxBuffer: 2 * 1024 * 1024 })).stdout; }
    catch { throw unavailable(); }
  }
  private labels(owner: string, labels: Record<string, string>) {
    return labels?.['collective.codex.owner'] === runtimeKey(owner) && labels?.['collective.codex.namespace'] === this.config.namespace;
  }
  private async network(owner: string) {
    // Preinstalled isolated egress network/proxy only. This driver cannot expand host network policy.
    const name = `${this.resourceName(owner)}-egress`;
    const [n] = JSON.parse(await this.command(['network', 'inspect', name]));
    if (n.Driver !== 'bridge' || !n.Internal || n.EnableIPv6 || !this.labels(owner, n.Labels) ||
      n.Options?.['com.docker.network.bridge.gateway_mode_ipv4'] !== 'isolated' ||
      n.Options?.['com.docker.network.bridge.enable_icc'] !== 'false' ||
      n.Options?.['com.docker.network.bridge.trusted_host_interfaces']) throw unavailable();
    for (const id of Object.keys(n.Containers ?? {})) {
      const [peer] = JSON.parse(await this.command(['inspect', id]));
      if (peer.Name === `/${this.resourceName(owner)}`) continue;
      if (!this.labels(owner, peer.Config.Labels) || peer.Config.Labels['collective.codex.egress-proxy'] !== 'true' || peer.Mounts?.length)
        throw unavailable();
    }
    return name;
  }
  private async volume(owner: string, suffix: 'home' | 'workspace', create: boolean) {
    const name = `${this.resourceName(owner)}-${suffix}`;
    const exists = (await this.command(['volume', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}'])).trim();
    if (!exists && !create) throw unavailable();
    if (!exists) await this.command(['volume', 'create', '--label', `collective.codex.owner=${runtimeKey(owner)}`,
      '--label', `collective.codex.namespace=${this.config.namespace}`, name]);
    const [v] = JSON.parse(await this.command(['volume', 'inspect', name]));
    if (v.Name !== name || v.Driver !== 'local' || Object.keys(v.Options ?? {}).length || !this.labels(owner, v.Labels)) throw unavailable();
    return name;
  }
  async inspect(owner: string) { this.name(owner); return this.inspectResources(owner); }
  private async inspectResources(owner: string) {
    const name = this.resourceName(owner);
    const policy = await this.policy();
    if (!(await this.command(['container', 'ls', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}'])).trim()) return null;
    const [c] = JSON.parse(await this.command(['inspect', name]));
    const h = c.HostConfig;
    if (!this.labels(owner, c.Config.Labels) || c.Config.Image !== this.config.image || c.Config.User !== '10001:10001' ||
      (this.config.image.startsWith('sha256:') && c.Image !== this.config.image) ||
      c.Config.WorkingDir !== PERSONAL_CODEX_WORKSPACE || JSON.stringify(c.Config.Cmd) !== JSON.stringify(['node', '/opt/collective-codex/server.mjs']) ||
      c.Config.Entrypoint?.length || h.Privileged || !h.ReadonlyRootfs || h.PidMode || h.UTSMode || h.UsernsMode ||
      !['private', ''].includes(h.IpcMode ?? '') || h.Binds?.length || h.Devices?.length || h.DeviceRequests?.length || h.ExtraHosts?.length ||
      JSON.stringify(h.CapDrop) !== JSON.stringify(['ALL']) || h.CapAdd?.length ||
      JSON.stringify(h.SecurityOpt) !== JSON.stringify(policy.inspect) ||
      c.AppArmorProfile !== (policy.appArmorProfile ?? 'docker-default') ||
      h.Memory !== this.config.memoryMb * 1024 * 1024 || h.MemorySwap !== h.Memory || h.NanoCpus !== this.config.cpus * 1e9 || h.PidsLimit !== 256 ||
      h.RestartPolicy?.Name !== 'no' || h.LogConfig?.Type !== 'none' || Object.keys(h.PortBindings ?? {}).length ||
      h.NetworkMode !== `${name}-egress` || JSON.stringify(Object.keys(c.NetworkSettings.Networks)) !== JSON.stringify([`${name}-egress`]) ||
      JSON.stringify(h.Tmpfs) !== JSON.stringify({ '/tmp': 'rw,nosuid,nodev,size=256m,mode=1777' }) ||
      c.Mounts.length !== 2 || !['home', 'workspace'].every(suffix => c.Mounts.some((m: { Type: string; Name: string; Destination: string; RW: boolean }) =>
        m.Type === 'volume' && m.Name === `${name}-${suffix}` && m.Destination === (suffix === 'home' ? '/codex-home' : PERSONAL_CODEX_WORKSPACE) && m.RW))) throw unavailable();
    // Exact environment: never inherit server API credentials or Docker configuration.
    const expected = ['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/codex-home', 'CODEX_HOME=/codex-home',
      'HTTP_PROXY=http://codex-egress:3128', 'HTTPS_PROXY=http://codex-egress:3128', 'NO_PROXY=127.0.0.1,localhost'];
    if (JSON.stringify([...c.Config.Env].sort()) !== JSON.stringify(expected.sort())) throw unavailable();
    await this.network(owner);
    await this.volume(owner, 'home', false); await this.volume(owner, 'workspace', false);
    return c;
  }
  async preflight(owner: string) {
    ownerId.parse(owner);
    await this.policy();
    if (!this.config.siwcSandboxVerified) throw unavailable();
    const images = JSON.parse(await this.command(['image', 'inspect', this.config.image]));
    if (!Array.isArray(images) || images.length !== 1 || (this.config.image.startsWith('sha256:') ? images[0]?.Id !== this.config.image : !images[0]?.RepoDigests?.includes(this.config.image))) throw unavailable();
    await this.network(owner);
    for (const suffix of ['home', 'workspace'] as const) {
      const name = `${this.resourceName(owner)}-${suffix}`;
      if ((await this.command(['volume', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}'])).trim()) await this.volume(owner, suffix, false);
    }
    const c = await this.inspectResources(owner);
    return !c ? 'not_started' as const : c.State.Running ? 'running' as const : 'stopped' as const;
  }
  async ensure(owner: string) {
    this.name(owner);
    const name = this.resourceName(owner);
    const policy = await this.policy();
    const network = await this.network(owner);
    // No auto-pull/build. Operator must review/install this exact image before enrollment.
    const inspectedImage = await this.command(['image', 'inspect', this.config.image]);
    if (this.config.image.startsWith('sha256:')) {
      const images = JSON.parse(inspectedImage);
      if (!Array.isArray(images) || images.length !== 1 || images[0]?.Id !== this.config.image) throw unavailable();
    }
    let c = await this.inspect(owner);
    if (!c) {
      const home = await this.volume(owner, 'home', true), workspace = await this.volume(owner, 'workspace', true);
      await this.command(['create', '--name', name, '--label', `collective.codex.owner=${runtimeKey(owner)}`,
        '--label', `collective.codex.namespace=${this.config.namespace}`, '--user', '10001:10001', '--workdir', PERSONAL_CODEX_WORKSPACE,
        '--read-only', '--cap-drop', 'ALL', ...policy.create.flatMap(opt => ['--security-opt', opt]), '--pids-limit', '256',
        '--memory', `${this.config.memoryMb}m`, '--memory-swap', `${this.config.memoryMb}m`, '--cpus', String(this.config.cpus),
        '--network', network, '--restart', 'no', '--log-driver', 'none', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
        '--mount', `type=volume,src=${home},dst=/codex-home`, '--mount', `type=volume,src=${workspace},dst=/home/agent/workspace`,
        '--env', 'NODE_VERSION', '--env', 'YARN_VERSION', '--env', 'HOME=/codex-home', '--env', 'CODEX_HOME=/codex-home', '--env', 'HTTP_PROXY=http://codex-egress:3128',
        '--env', 'HTTPS_PROXY=http://codex-egress:3128', '--env', 'NO_PROXY=127.0.0.1,localhost', this.config.image,
        'node', '/opt/collective-codex/server.mjs']);
      c = await this.inspect(owner);
    }
    if (!c?.State.Running) await this.command(['start', name]);
    if (!(await this.inspect(owner))?.State.Running) throw unavailable();
  }
  /** Recovery/revocation may start only the existing validated container; never recreate storage. */
  async startRetained(owner: string) {
    const c = await this.inspect(owner);
    if (!c) throw unavailable();
    if (!c.State.Running) await this.command(['start', this.resourceName(owner)]);
    if (!(await this.inspect(owner))?.State.Running) throw unavailable();
  }
  async bridge(owner: string): Promise<ChildProcessWithoutNullStreams> {
    if (!(await this.inspect(owner))?.State.Running) throw unavailable();
    return spawn(this.config.dockerExecutable, ['exec', '-i', this.resourceName(owner), 'node', '/opt/collective-codex/bridge.mjs'],
      { env: dockerEnv, stdio: 'pipe' });
  }
  async computerStatus(owner: string): Promise<ComputerStatus> {
    this.name(owner);
    return { available: false, running: false, width: 1280, height: 800 };
  }
  async computerFrame(owner: string): Promise<Buffer> {
    this.name(owner);
    throw unavailable();
  }
  async computerInput(owner: string, _input: ComputerInput): Promise<void> {
    void _input;
    this.name(owner);
    throw unavailable();
  }
  async computerPause(owner: string, _paused: boolean): Promise<void> {
    void _paused;
    this.name(owner);
    throw unavailable();
  }
  /** Token is sent only on docker exec stdin to the container's private, memory-only supervisor socket. */
  async synchronizeToken(owner: string, accessToken: string, credentialBinding: string): Promise<void> {
    this.name(owner);
    if (!this.config.siwcSandboxVerified) throw new Error('Personal Codex token sharing is unavailable until the SIWC sandbox environment and /proc isolation proof is approved by an operator.');
    if (accessToken.length < 1 || accessToken.length > 16_384 || !/^[a-f0-9]{64}$/.test(credentialBinding) ||
      tokenFingerprint(accessToken) !== credentialBinding) throw unavailable();
    if (!(await this.inspect(owner))?.State.Running) throw unavailable();
    const child = spawn(this.config.dockerExecutable, ['exec', '-i', this.resourceName(owner), 'node', '/opt/collective-codex/server.mjs', '--sync-token'],
      { env: dockerEnv, stdio: ['pipe', 'ignore', 'ignore'] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(unavailable()); }, 10_000);
      child.once('error', () => { clearTimeout(timer); reject(unavailable()); });
      child.once('exit', code => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(unavailable());
      });
      child.stdin.end(JSON.stringify({ accessToken, credentialBinding }));
    });
  }
  async clearToken(owner: string): Promise<void> {
    this.name(owner);
    if (!(await this.inspect(owner))?.State.Running) throw unavailable();
    const child = spawn(this.config.dockerExecutable, ['exec', '-i', this.resourceName(owner), 'node', '/opt/collective-codex/server.mjs', '--clear-token'],
      { env: dockerEnv, stdio: ['ignore', 'ignore', 'ignore'] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(unavailable()); }, 10_000);
      child.once('error', () => { clearTimeout(timer); reject(unavailable()); });
      child.once('exit', code => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(unavailable());
      });
    });
  }
}
