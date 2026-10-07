import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DockerDriver, BrokerConfig, runtimeKey } from '@/docker-hermes/docker';
import { executeResourceHelper } from '@/docker-hermes/resource-helper';
import { HERMES_COMMIT } from '@/local-hermes/config';
import { createTeamResourceSnapshot, resourceSha256, type TeamResource } from '@/lib/hermes-team/resources';
import { planTeamResourceUpdate } from '@/lib/hermes-team/updates';
type Mount = { Type: string; Name?: string; Source?: string; Destination: string; RW: boolean };
type Inspection = {
  Id: string; Name: string; State: { Running: boolean };
  Config: { Labels: Record<string, string>; Image: string; User: string; Entrypoint: string[]; Cmd: string[] };
  HostConfig: { Mounts?: { Type: string; Target: string; ReadOnly: boolean; TmpfsOptions?: { SizeBytes: number; Mode: number } }[]; NetworkMode: string; ReadonlyRootfs: boolean; Privileged: boolean; CapDrop: string[]; CapAdd: string[]; SecurityOpt: string[]; PidsLimit: number; Memory: number; MemorySwap: number; NanoCpus: number; RestartPolicy: { Name: string }; LogConfig: { Type: string } };
  Mounts: Mount[]; NetworkSettings: { Networks: Record<string, object> };
};
/** Real DockerDriver command generation and real resource functions, synthetic daemon only. */
class DaemonFixture extends DockerDriver {
  calls: string[][] = []; containers = new Map<string, Inspection>(); journals = false; nativePresent = false; nativeRunning = false;
  helperCalls = 0; createBlock?: { entered: () => void; gate: Promise<void> }; block?: { entered: () => void; gate: Promise<void>; cancel: () => void }; mutate?: (info: Inspection) => void;
  constructor(config: BrokerConfig, readonly roots: { volumeRoot: string; sourceRoot: string; journalRoot: string }) { super(config); }
  protected async command(args: string[]): Promise<string> {
    this.calls.push(args);
    const native = this.name('alice'), data = native + '-data', updates = native + '-team-updates';
    if (args[0] === 'volume') {
      if (args[1] === 'ls') return args.join(' ').includes(updates) ? this.journals ? updates : '' : data;
      if (args[1] === 'create') { this.journals = true; return updates; }
      if (args[1] === 'inspect') return JSON.stringify([{ Name: args[2], Driver: 'local', Options: {}, Labels: { 'collective.owner': runtimeKey('alice'), 'collective.namespace': this.config.namespace, ...(args[2] === updates ? { 'collective.purpose': 'team-resource-journals' } : {}) } }]);
    }
    if (args[0] === 'container' && args[1] === 'ls') {
      if (args.includes('label=collective.purpose=team-resource-helper')) return [...this.containers.keys()].join('\n');
      const filter = args.find(arg => arg.startsWith('name='))!; const name = filter.slice('name=^/'.length, -1);
      if (name === native) return this.nativePresent ? native : '';
      return [...this.containers.values()].find(info => info.Name === '/' + name)?.Id ?? '';
    }
    if (args[0] === 'inspect') {
      if (args[1] === native && this.nativePresent) {
        const info: Inspection = { Id: native, Name: '/' + native, State: { Running: this.nativeRunning },
          Config: { Labels: { 'collective.owner': runtimeKey('alice'), 'collective.namespace': this.config.namespace }, Image: this.config.image, User: '', Entrypoint: [], Cmd: [] },
          HostConfig: { NetworkMode: 'none', ReadonlyRootfs: false, Privileged: false, CapDrop: ['ALL'], CapAdd: ['CAP_CHOWN', 'CAP_DAC_OVERRIDE', 'CAP_SETGID', 'CAP_SETUID'], SecurityOpt: ['no-new-privileges:true'], PidsLimit: 256, Memory: this.config.memoryMb * 1024 * 1024, MemorySwap: this.config.memoryMb * 1024 * 1024, NanoCpus: this.config.cpus * 1e9, RestartPolicy: { Name: 'no' }, LogConfig: { Type: 'local' } },
          Mounts: [{ Type: 'volume', Name: data, Destination: '/opt/data', RW: true }, { Type: 'bind', Source: this.config.bridgePath, Destination: '/opt/collective-bridge.py', RW: false }], NetworkSettings: { Networks: { none: {} } } };
        return JSON.stringify([info]);
      }
      const stored = this.containers.get(args[1]);
      if (!stored) throw new Error('Missing synthetic container'); const info = structuredClone(stored); this.mutate?.(info); return JSON.stringify([info]);
    }
    if (args[0] === 'create') {
      const values = (flag: string) => args.flatMap((arg, index) => arg === flag ? [args[index + 1]] : []);
      const name = values('--name')[0], id = `id-${name}`;
      const info: Inspection = { Id: id, Name: '/' + name, State: { Running: false },
        Config: { Labels: Object.fromEntries(values('--label').map(label => { const index = label.indexOf('='); return [label.slice(0, index), label.slice(index + 1)]; })), Image: this.config.image, User: values('--user')[0], Entrypoint: ['/usr/local/bin/node'], Cmd: ['/opt/collective-resource-helper.mjs', '--run'] },
        HostConfig: { NetworkMode: values('--network')[0], ReadonlyRootfs: args.includes('--read-only'), Privileged: false, CapDrop: ['ALL'], CapAdd: values('--cap-add').map(cap => `CAP_${cap}`), SecurityOpt: values('--security-opt'), PidsLimit: Number(values('--pids-limit')[0]), Memory: 512 * 1024 * 1024, MemorySwap: 512 * 1024 * 1024, NanoCpus: 1e9, RestartPolicy: { Name: values('--restart')[0] }, LogConfig: { Type: values('--log-driver')[0] } },
        Mounts: values('--mount').map(value => { const parts = Object.fromEntries(value.split(',').map(piece => { const [key, item] = piece.split('='); return [key, item ?? true]; })); return { Type: String(parts.type), ...(parts.type === 'volume' ? { Name: String(parts.src) } : { Source: parts.type === 'tmpfs' ? '' : String(parts.src) }), Destination: String(parts.dst), RW: !parts.readonly }; }), NetworkSettings: { Networks: { none: {} } } };
      // Pinned Config.Volumes includes /opt/data. An omitted explicit mount gets
      // an anonymous writable volume from Docker, even on a readonly rootfs.
      if (!info.Mounts.some(mount => mount.Destination === '/opt/data')) info.Mounts.push({ Type: 'volume', Name: 'implicit-anonymous-volume', Destination: '/opt/data', RW: true });
      info.HostConfig.Mounts = values('--mount').map(value => { const parts = Object.fromEntries(value.split(',').map(piece => { const [key, item] = piece.split('='); return [key, item ?? true]; })); return { Type: String(parts.type), Target: String(parts.dst), ReadOnly: !!parts.readonly, ...(parts.type === 'tmpfs' ? { TmpfsOptions: { SizeBytes: Number(parts['tmpfs-size']), Mode: parseInt(String(parts['tmpfs-mode']), 8) } } : {}) }; });
      if (this.createBlock) { this.createBlock.entered(); await this.createBlock.gate; }
      this.containers.set(id, info); return id;
    }
    if (args[0] === 'stop') { const info = this.containers.get(args.at(-1)!); if (info) { info.State.Running = false; this.block?.cancel(); } return ''; }
    if (args[0] === 'container' && args[1] === 'rm') { this.containers.delete(args[2]); return ''; }
    throw new Error(`Unexpected synthetic Docker command ${args[0]} ${args[1]}`);
  }
  protected async resourceCommand(args: string[], input: unknown) {
    const info = this.containers.get(args.at(-1)!)!; info.State.Running = true; this.helperCalls++;
    if (this.block) { this.block.entered(); await this.block.gate; }
    const operation = (input as { operation: string }).operation;
    const result = operation === 'initialize-journals' ? { initialized: true } : await executeResourceHelper(input, this.roots);
    info.State.Running = false; return result;
  }
}
let home: string, profileRoot: string, identity: string, driver: DaemonFixture;
const profile = `cui-team-${'a'.repeat(32)}`;
const skill = (content: string): TeamResource => ({ path: 'skills/support/SKILL.md', packageId: 'skills/support', kind: 'skill', encoding: 'utf8', content, size: Buffer.byteLength(content), sha256: resourceSha256(content) });
const plan = () => planTeamResourceUpdate({ installed: createTeamResourceSnapshot([skill('v1')]), current: createTeamResourceSnapshot([skill('v1')]), release: createTeamResourceSnapshot([skill('v2')]) });
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'resource-daemon-')); const roots = { volumeRoot: path.join(home, 'data'), sourceRoot: path.join(home, 'source'), journalRoot: path.join(home, 'journals') };
  profileRoot = path.join(roots.volumeRoot, 'profiles', profile); await mkdir(path.join(profileRoot, 'skills/support'), { recursive: true }); await mkdir(roots.sourceRoot); await mkdir(roots.journalRoot, { mode: 0o700 }); await mkdir(path.join(home, 'state'));
  await writeFile(path.join(roots.sourceRoot, '.hermes_build_sha'), HERMES_COMMIT); await writeFile(path.join(profileRoot, 'skills/support/SKILL.md'), 'v1');
  await writeFile(path.join(profileRoot, '.collectiveui-team-profile.json'), JSON.stringify({ format: 1, inference: 'unverified' })); await writeFile(path.join(profileRoot, 'gateway.parked'), '');
  const metadata = await stat(profileRoot, { bigint: true }); identity = `${metadata.dev}:${metadata.ino}`;
  driver = new DaemonFixture(BrokerConfig.parse({ stateDir: path.join(home, 'state'), socketPath: path.join(home, 'b.sock'), bridgePath: path.resolve('src/docker-hermes/bridge.py'), namespace: 'cui-helper-fixture', image: `nousresearch/hermes-agent@sha256:${'a'.repeat(64)}`, network: 'none', teamBotsEnabled: true }), roots);
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
describe('Docker resource driver isolation', () => {
  it('captures through RO retained data and fixed code, without pull, network, native execution or logs', async () => {
    const capture = await driver.capturePublishableResources('alice', profile, identity, { skillPackages: ['support'] }); expect(capture.resources).toEqual([skill('v1')]);
    const create = driver.calls.find(args => args[0] === 'create')!;
    expect(create).toContain('never'); expect(create).toContain('none'); expect(create).toContain('--read-only'); expect(create).toContain('10000:10000'); expect(create).toContain('--log-driver');
    expect(create).toContain(`type=volume,src=${driver.name('alice')}-data,dst=/opt/data,readonly`);
    expect(driver.calls.some(args => ['pull', 'exec'].includes(args[0]))).toBe(false); expect(driver.containers.size).toBe(0);
  });
  it('initializes protected journal volume separately from native files, applies, and preserves replayed later learning', async () => {
    const update = plan(); const result = await driver.applyTeamResourceUpdate('alice', profile, identity, 'release-1', update); expect(result.status).toBe('complete');
    const creates = driver.calls.filter(args => args[0] === 'create'), init = creates.find(args => args.includes('collective.helper-operation=initialize-journals'))!;
    expect(init.join(' ')).not.toContain(`src=${driver.name('alice')}-data,dst=/opt/data`); expect(init).toContain('type=tmpfs,dst=/opt/data,readonly,tmpfs-size=4096,tmpfs-mode=0700'); expect(init).toContain('0:0'); expect(init).toContain('CHOWN');
    const apply = creates.find(args => args.includes('collective.helper-operation=apply'))!; expect(apply).toContain(`type=volume,src=${driver.name('alice')}-data,dst=/opt/data`); expect(apply).toContain(`type=volume,src=${driver.name('alice')}-team-updates,dst=/run/collective-team-updates`);
    expect(await readFile(path.join(profileRoot, 'skills/support/SKILL.md'), 'utf8')).toBe('v2'); await writeFile(path.join(profileRoot, 'skills/support/SKILL.md'), 'later member learning');
    expect(await driver.applyTeamResourceUpdate('alice', profile, identity, 'release-1', update)).toEqual(result);
    expect(await readFile(path.join(profileRoot, 'skills/support/SKILL.md'), 'utf8')).toBe('later member learning'); expect(driver.containers.size).toBe(0);
  });
  it('persists abort-before-first-apply so a delayed old request cannot write', async () => {
    const update = plan(); expect(await driver.abortTeamResourceUpdate('alice', profile, identity, 'cancelled', update)).toEqual({ aborted: true });
    await expect(driver.applyTeamResourceUpdate('alice', profile, identity, 'cancelled', update)).rejects.toThrow('aborted');
    expect(await readFile(path.join(profileRoot, 'skills/support/SKILL.md'), 'utf8')).toBe('v1');
  });
  it.each(['network', 'rw', 'mount', 'capability', 'owner'])('refuses a helper with altered %s before starting it', async alteration => {
    driver.mutate = info => { if (alteration === 'network') info.HostConfig.NetworkMode = 'bridge'; if (alteration === 'rw') info.Mounts[0].RW = true; if (alteration === 'mount') info.Mounts.push({ Type: 'volume', Name: 'private', Destination: '/private', RW: true }); if (alteration === 'capability') info.HostConfig.CapAdd = ['CAP_SYS_ADMIN']; if (alteration === 'owner') info.Config.Labels['collective.owner'] = 'foreign'; };
    await expect(driver.capturePublishableResources('alice', profile, identity, {})).rejects.toThrow('isolation'); expect(driver.helperCalls).toBe(0);
  });
  it('refuses metadata helper anonymous data volumes caused by the pinned VOLUME default', async () => {
    driver.mutate = info => {
      if (info.Config.Labels['collective.helper-operation'] === 'initialize-journals') {
        info.Mounts = info.Mounts.map(mount => mount.Destination === '/opt/data' ? { Type: 'volume', Name: 'anonymous-native-volume', Destination: '/opt/data', RW: true } : mount);
        info.HostConfig.Mounts = info.HostConfig.Mounts?.filter(mount => mount.Type !== 'tmpfs');
      }
    };
    await expect(driver.applyTeamResourceUpdate('alice', profile, identity, 'volume-default', plan())).rejects.toThrow('isolation');
    expect(driver.helperCalls).toBe(0); expect(await readFile(path.join(profileRoot, 'skills/support/SKILL.md'), 'utf8')).toBe('v1');
  });
  it('cancels an active admitted helper on owner stop, confirms cleanup, and never returns its snapshot', async () => {
    let entered!: () => void, cancel!: () => void; const entry = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>((_, reject) => { cancel = () => reject(new Error('cancelled helper')); });
    driver.block = { entered, gate, cancel }; const capture = driver.capturePublishableResources('alice', profile, identity, {}); const failed = expect(capture).rejects.toThrow(); await entry;
    await driver.stop('alice'); await failed; expect(driver.containers.size).toBe(0); expect(driver.calls.filter(args => args[0] === 'container' && args[1] === 'rm')).toHaveLength(1);
  });
  it('cancels a delayed Docker create before later helper start and cleans its retained daemon identity', async () => {
    let entered!: () => void, release!: () => void; const entry = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    driver.createBlock = { entered, gate };
    const capture = driver.capturePublishableResources('alice', profile, identity, {}); const failed = expect(capture).rejects.toThrow('revoked'); await entry;
    const stopped = driver.stop('alice'); release(); await stopped; await failed;
    expect(driver.helperCalls).toBe(0); expect(driver.containers.size).toBe(0); expect(driver.calls.filter(args => args[0] === 'container' && args[1] === 'rm')).toHaveLength(1);
    expect(await readFile(path.join(profileRoot, 'skills/support/SKILL.md'), 'utf8')).toBe('v1');
  });
  it('refuses retained data while any native sibling can still be running', async () => {
    driver.nativePresent = true; driver.nativeRunning = true;
    await expect(driver.capturePublishableResources('alice', profile, identity, {})).rejects.toThrow('entire native runtime');
    expect(driver.helperCalls).toBe(0); expect(driver.calls.some(args => args[0] === 'create')).toBe(false);
  });
  it('fences native reopen on pending protected journals before start or image pull', async () => {
    const update = plan(); await writeFile(path.join(profileRoot, 'skills/support/SKILL.md'), 'changed member version');
    expect(await driver.applyTeamResourceUpdate('alice', profile, identity, 'stale', update)).toMatchObject({ status: 'needs-attention' });
    driver.calls = [];
    await expect(driver.reopen('alice')).rejects.toThrow('unfinished');
    expect(driver.calls.some(args => ['pull', 'start', 'exec'].includes(args[0]))).toBe(false);
    expect(driver.calls.filter(args => args[0] === 'create').every(args => args.includes('collective.helper-operation=fence'))).toBe(true);
  });
  it('rejects an invalid plan before creating storage or helper containers', async () => {
    await expect(driver.applyTeamResourceUpdate('alice', profile, identity, 'invalid', { ...plan(), planHash: 'b'.repeat(64) })).rejects.toThrow(); expect(driver.calls).toEqual([]); expect(driver.journals).toBe(false);
  });
});
