import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { BrokerConfig, DockerDriver, runtimeKey } from '@/docker-hermes/docker';
import { HERMES_COMMIT } from '@/local-hermes/config';
import { createTeamResourceSnapshot, resourceSha256, type TeamResource, type TeamResourceSnapshot } from '@/lib/hermes-team/resources';
import { planTeamResourceUpdate, type TeamResourceUpdatePlan } from '@/lib/hermes-team/updates';

const PIN = 'nousresearch/hermes-agent@sha256:2fd023efbb8d3d2b0ce1a73d028b07370cff34f567cfe0e999553e8c327ea283';
const enabled = process.env.DOCKER_HERMES_TEAM_IMAGE_TEST === '1';
const suite = enabled ? describe : describe.skip;
const exec = promisify(execFile);
// Match the production driver: no inherited Docker remote context or host credentials.
const DOCKER_ENV = { NODE_ENV: 'production' as const, PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent', LANG: 'C.UTF-8' };
const docker = async (args: string[], timeout = 45000) => (await exec('/usr/local/bin/docker', args, { env: DOCKER_ENV, timeout, maxBuffer: 4 * 1024 * 1024 })).stdout;
const profiles = [`cui-team-${'a'.repeat(32)}`, `cui-team-${'b'.repeat(32)}`];
const owners = ['alice', 'bob'];
const retainedHelpers = new Map<string, string>();

/** Observe real commands and delay one real create acknowledgement. No daemon
 * response, image resolution, inspection or production helper code is substituted. */
class ObservedDriver extends DockerDriver {
  operations: string[] = []; executed = 0;
  delay?: { entered: () => void; gate: Promise<void> };
  protected async command(args: string[], timeout?: number) {
    const output = await super.command(args, timeout);
    if (args[0] === 'create' && args.includes('collective.purpose=team-resource-helper')) {
      retainedHelpers.set(output.trim(), args[args.indexOf('--name') + 1]);
      const [info] = JSON.parse(await docker(['inspect', output.trim()]));
      this.operations.push(info.Config.Labels['collective.helper-operation']);
      expect(info.Config.Image).toBe(PIN); expect(info.HostConfig.NetworkMode).toBe('none');
      expect(info.HostConfig.ReadonlyRootfs).toBe(true); expect(info.HostConfig.LogConfig.Type).toBe('none');
      const initialize = info.Config.Labels['collective.helper-operation'] === 'initialize-journals';
      expect(info.Config.User).toBe(initialize ? '0:0' : '10000:10000');
      if (['initialize-journals', 'fence'].includes(info.Config.Labels['collective.helper-operation'])) {
        expect(info.Mounts.find((mount: { Destination: string }) => mount.Destination === '/opt/data')).toMatchObject({ Type: 'tmpfs', RW: false });
      }
      if (this.delay) { const delayed = this.delay; this.delay = undefined; delayed.entered(); await delayed.gate; }
    }
    if (args[0] === 'container' && args[1] === 'rm') retainedHelpers.delete(args[2]);
    return output;
  }
  protected async resourceCommand(args: string[], input: unknown) { this.executed++; return super.resourceCommand(args, input); }
}
type PrivateState = { uid: number; node: string; identity: string; privateHashes: string[]; skillExecuted: boolean; journalMounted: boolean; quarantine: { config: string; env: string; auth: string } };

suite('OFFLINE official pinned image: production Team resource helper and real Docker volumes', () => {
  let root: string, config: BrokerConfig, driver: ObservedDriver, checkpoint: string;
  const identity = new Map<string, string>(), privateState = new Map<string, PrivateState>();
  const fixtureNames = new Set<string>();
  const key = (owner: string, profile: string) => owner + ':' + profile;
  const labels = (owner: string, purpose = 'team-image-fixture') => ['--label', `collective.namespace=${config.namespace}`, '--label', `collective.owner=${runtimeKey(owner)}`, '--label', `collective.purpose=${purpose}`];
  async function fixture<T>(owner: string, input: object, options: { initialize?: boolean; journal?: boolean; checkpoint?: boolean } = {}): Promise<T> {
    const name = `${config.namespace}-fixture-${randomUUID().replaceAll('-', '')}`; fixtureNames.add(name);
    const args = ['create', '--pull', 'never', '--interactive', '--name', name, ...labels(owner), '--network', 'none', '--read-only',
      '--user', options.initialize ? '0:0' : '10000:10000', '--cap-drop', 'ALL', ...(options.initialize ? ['--cap-add', 'CHOWN'] : []),
      '--security-opt', 'no-new-privileges:true', '--pids-limit', '32', '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--restart', 'no', '--log-driver', 'none',
      '--mount', `type=volume,src=${driver.name(owner)}-data,dst=/opt/data,volume-nocopy`,
      '--mount', `type=bind,src=${path.resolve('tests/fixtures/hermes-team-image.mjs')},dst=/opt/collective-fixture.mjs,readonly`,
      '--mount', `type=bind,src=${config.bridgePath},dst=/opt/collective-bridge.py,readonly`,
      ...(options.journal ? ['--mount', `type=volume,src=${driver.name(owner)}-team-updates,dst=/run/collective-team-updates${options.checkpoint ? '' : ',readonly'}`] : []),
      ...(options.checkpoint ? ['--mount', `type=bind,src=${checkpoint},dst=/opt/collective-checkpoint.mjs,readonly`] : []),
      '--env', 'HOME=/nonexistent', '--env', 'HERMES_DISABLE_LAZY_INSTALLS=1', '--env', 'PYTHONDONTWRITEBYTECODE=1',
      '--entrypoint', '/usr/local/bin/node', PIN, '/opt/collective-fixture.mjs'];
    const id = (await docker(args)).trim();
    try {
      return await new Promise<T>((resolve, reject) => {
        const child = spawn('/usr/local/bin/docker', ['start', '--attach', '--interactive', id], { env: DOCKER_ENV, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = ''; const timeout = setTimeout(() => { child.kill(); reject(new Error('Fixed image fixture timed out.')); }, 30000);
        child.stdout.on('data', part => { stdout += String(part); if (stdout.length > 2 * 1024 * 1024) child.kill(); });
        child.stderr.on('data', part => { stderr += String(part).slice(0, 8192 - stderr.length); });
        child.on('error', error => { clearTimeout(timeout); reject(error); });
        child.stdin.on('error', () => {});
        child.on('close', code => { clearTimeout(timeout); if (code !== 0) reject(new Error(`Fixed image fixture refused operation: ${stderr}`)); else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } } });
        child.stdin.end(JSON.stringify(input));
      });
    } finally { await docker(['container', 'rm', '--force', id]); fixtureNames.delete(name); }
  }
  const inspectPrivate = (owner: string, profile: string) => fixture<PrivateState>(owner, { operation: 'inspect', profile });
  const snapshot = (owner = 'alice', profile = profiles[0]) => driver.capturePublishableResources(owner, profile, identity.get(key(owner, profile))!, { skillPackages: ['support'], includeRole: true, documents: ['guide.md'] });
  const inventory = () => driver.inventoryMemberResources('alice', profiles[0], identity.get(key('alice', profiles[0]))!, ['skills/support', 'SOUL.md', 'documents/guide.md']);
  const document = (name: string, content: string): TeamResource => ({ path: `documents/${name}`, packageId: `documents/${name}`, kind: 'document', encoding: 'utf8', content, size: Buffer.byteLength(content), sha256: resourceSha256(content) });
  const text = (resource: TeamResource, content: string): TeamResource => ({ ...resource, content, encoding: 'utf8', size: Buffer.byteLength(content), sha256: resourceSha256(content) });
  let initial: TeamResourceSnapshot, release: TeamResourceSnapshot, installedPlan: TeamResourceUpdatePlan;

  beforeAll(async () => {
    if (process.platform !== 'linux' || process.arch !== 'x64' || process.env.DOCKER_HERMES_TEST_ROOTFS) throw new Error('Requires Linux amd64 and the original official image; rootfs substitution is prohibited.');
    const info = JSON.parse(await docker(['info', '--format', '{{json .}}']));
    if (!['overlay2', 'overlayfs'].includes(info.Driver)) throw new Error('Use supported efficient Docker storage; do not pull this image on VFS.');
    const [image] = JSON.parse(await docker(['image', 'inspect', PIN]));
    expect(image.RepoDigests).toContain(PIN); expect(image.Os).toBe('linux'); expect(image.Architecture).toBe('amd64');
    expect(image.Config.Volumes).toHaveProperty('/opt/data');
    root = await mkdtemp(path.join(tmpdir(), 'team-image-smoke-')); await mkdir(path.join(root, 'state'), { mode: 0o700 });
    config = BrokerConfig.parse({ stateDir: path.join(root, 'state'), socketPath: path.join(root, 'broker.sock'), bridgePath: path.resolve('src/docker-hermes/bridge.py'),
      image: PIN, namespace: `cui-team-smoke-${randomUUID().slice(0, 8)}`, network: 'none', teamBotsEnabled: true });
    driver = new ObservedDriver(config);
    const bundled = await build({ stdin: { contents: `import {applyTeamResourcePlan} from './src/lib/hermes-team/native-resources';
      export async function checkpointApply(home,profile,operationId,plan){let parked=false;try{await applyTeamResourcePlan(home,operationId,plan,{journalRoot:'/run/collective-team-updates/'+profile,checkpoint:async phase=>{if(phase==='parked'){parked=true;throw Error('fixed checkpoint');}}});}catch(error){if(!parked)throw error;}if(!parked)throw Error('checkpoint not reached');return{parked:true};}`,
      resolveDir: process.cwd(), sourcefile: 'fixed-image-checkpoint.ts' }, bundle: true, write: false, platform: 'node', target: 'node26', format: 'esm', logLevel: 'silent' });
    checkpoint = path.join(root, 'checkpoint.mjs'); await writeFile(checkpoint, bundled.outputFiles[0].contents); await chmod(checkpoint, 0o444);
    for (const owner of owners) {
      const volume = driver.name(owner) + '-data';
      await docker(['volume', 'create', ...labels(owner), volume]);
      await fixture(owner, { operation: 'initialize' }, { initialize: true });
      for (const profile of profiles) {
        const created = await fixture<{ name: string; identity: string }>(owner, { operation: 'seed', profile, owner });
        expect(created.name).toBe(profile); identity.set(key(owner, profile), created.identity);
        privateState.set(key(owner, profile), await inspectPrivate(owner, profile));
      }
      // Test-only Node sleep replaces native startup, preserving exact normal ownership,
      // volume and runtime isolation flags. No s6, gateway, chat or inference is started.
      await docker(['create', '--pull', 'never', '--name', driver.name(owner), ...labels(owner), '--network', 'none', '--cap-drop', 'ALL',
        '--cap-add', 'CHOWN', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'DAC_OVERRIDE', '--security-opt', 'no-new-privileges:true',
        '--pids-limit', '256', '--memory', `${config.memoryMb}m`, '--memory-swap', `${config.memoryMb}m`, '--cpus', String(config.cpus), '--restart', 'no', '--log-driver', 'none',
        '--mount', `type=volume,src=${volume},dst=/opt/data`, '--mount', `type=bind,src=${config.bridgePath},dst=/opt/collective-bridge.py,readonly`,
        '--entrypoint', '/usr/local/bin/node', PIN, '-e', 'setInterval(()=>{},1000)']);
    }
    initial = await snapshot();
  }, 180000);

  afterAll(async () => {
    if (!config) { if (root) await rm(root, { recursive: true, force: true }); return; }
    const errors: unknown[] = [];
    // Exact unique namespace + owner + image + known name, never broad Docker pruning.
    const targets = new Set([...owners.map(owner => driver.name(owner)), ...fixtureNames, ...retainedHelpers.values()]);
    try {
      for (const name of (await docker(['container', 'ls', '-a', '--filter', `label=collective.namespace=${config.namespace}`, '--format', '{{.Names}}'], 10000)).trim().split(/\s+/).filter(Boolean)) targets.add(name);
    } catch (error) { errors.push(error); }
    for (const target of targets) try {
      const found = (await docker(['container', 'ls', '-a', '--filter', `name=^/${target}$`, '--format', '{{.ID}}'], 10000)).trim();
      if (!found) continue;
      const [entry] = JSON.parse(await docker(['inspect', found], 10000)); const name = entry.Name.slice(1);
      const owned = owners.some(owner => entry.Config.Labels['collective.owner'] === runtimeKey(owner) && (name === driver.name(owner) || name.startsWith(driver.name(owner) + '-resources-') || fixtureNames.has(name)));
      if (!owned || entry.Config.Image !== PIN || entry.Config.Labels['collective.namespace'] !== config.namespace) throw new Error('Refuse cleanup of altered fixture ownership.');
      await docker(['container', 'rm', '--force', entry.Id], 10000);
    } catch (error) { errors.push(error); }
    for (const owner of owners) for (const suffix of ['-data', '-team-updates']) try {
      const name = driver.name(owner) + suffix;
      const found = (await docker(['volume', 'ls', '--filter', `name=^${name}$`, '--format', '{{.Name}}'], 10000)).trim(); if (!found) continue;
      const [volume] = JSON.parse(await docker(['volume', 'inspect', name], 10000));
      if (volume.Labels['collective.namespace'] !== config.namespace || volume.Labels['collective.owner'] !== runtimeKey(owner)) throw new Error('Refuse cleanup of altered fixture volume.');
      await docker(['volume', 'rm', name], 10000);
    } catch (error) { errors.push(error); }
    await rm(root, { recursive: true, force: true }); if (errors.length) throw new AggregateError(errors, 'Exact disposable image smoke cleanup failed.');
  }, 180000);

  it('uses image Node26/UID10000, exact native blank profile quarantine and complete safe packages', async () => {
    expect(HERMES_COMMIT).toBe('f97608f178d1ffeca59860195ab7da295f7c8e5f');
    const state = privateState.get(key('alice', profiles[0]))!;
    expect(state.uid).toBe(10000); expect(state.node).toMatch(/^26\./); expect(state.quarantine).toEqual({ config: '{}\n', env: '', auth: '{}\n' });
    expect(state.journalMounted).toBe(false); expect(state.skillExecuted).toBe(false);
    const available = await driver.inventoryPublishableResources('alice', profiles[0], state.identity);
    expect(available).toEqual({ skillPackages: ['learned', 'support'], includeRole: true, documents: ['guide.md'] });
    expect(initial.resources.map(resource => resource.path)).toContain('skills/support/scripts/procedure.sh');
    expect(initial.resources.find(resource => resource.path === 'skills/support/assets/example.bin')).toMatchObject({ encoding: 'base64', content: 'AP8DBQ==' });
    expect(JSON.stringify(initial)).not.toMatch(/PRIVATE_FIXTURE_SENTINEL|private Team memory|Never publish conversations/);
    await expect(driver.capturePublishableResources('bob', profiles[0], state.identity, {})).rejects.toThrow();
    await expect(driver.capturePublishableResources('alice', profiles[0], state.identity, { documents: ['../.env'] })).rejects.toThrow();
    await fixture('alice', { operation: 'unsafe-symlink', profile: profiles[0] });
    await expect(driver.capturePublishableResources('alice', profiles[0], state.identity, { skillPackages: ['escape'] })).rejects.toThrow();
    await fixture('alice', { operation: 'remove-unsafe', profile: profiles[0] });
  });

  it('refuses resource admission while the owner container runs and stops only that owner', async () => {
    for (const owner of owners) await docker(['start', driver.name(owner)]);
    await expect(snapshot()).rejects.toThrow('entire native runtime');
    await driver.stop('alice'); expect(await driver.running('alice')).toBe(false); expect(await driver.running('bob')).toBe(true);
    await driver.stop('bob'); expect((await snapshot()).manifestHash).toBe(initial.manifestHash);
    for (const owner of owners) for (const profile of profiles) expect(await inspectPrivate(owner, profile)).toEqual(privateState.get(key(owner, profile)));
  });

  it('applies skill packages, binary assets, role/docs and removals using protected UID-owned journals', async () => {
    release = createTeamResourceSnapshot([...initial.resources.filter(resource => resource.kind !== 'document').map(resource =>
      resource.path.endsWith('SKILL.md') || resource.kind === 'role' ? text(resource, resource.content + 'Published version two.\n') : resource), document('new-guide.md', 'New selected document.\n')]);
    installedPlan = planTeamResourceUpdate({ installed: initial, release, current: await inventory() });
    const result = await driver.applyTeamResourceUpdate('alice', profiles[0], identity.get(key('alice', profiles[0]))!, 'release-two', installedPlan);
    expect(result.status).toBe('complete'); expect(result.completedGroups).toContain('skills/support'); expect(result.completedGroups).toContain('documents/guide.md');
    expect(await fixture('alice', { operation: 'journal-inspect' }, { journal: true })).toEqual({ uid: 10000, gid: 10000, mode: 0o700 });
    const updated = await inventory(); expect(updated.resources.find(resource => resource.path === 'documents/guide.md')).toBeUndefined();
    expect(updated.resources.find(resource => resource.path === 'documents/new-guide.md')).toEqual(document('new-guide.md', 'New selected document.\n'));
    expect(updated.resources.filter(resource => resource.packageId === 'skills/support')).toEqual(release.resources.filter(resource => resource.packageId === 'skills/support'));
    expect(updated.resources.some(resource => resource.packageId === 'skills/learned')).toBe(true);
    await fixture('alice', { operation: 'member-edit', profile: profiles[0] }); const learned = await inventory();
    expect(await driver.applyTeamResourceUpdate('alice', profiles[0], identity.get(key('alice', profiles[0]))!, 'release-two', installedPlan)).toEqual(result);
    expect((await inventory()).manifestHash).toBe(learned.manifestHash);
    const rollback = planTeamResourceUpdate({ installed: release, release: initial, current: learned });
    expect(rollback.actions.find(action => action.packageId === 'skills/support')?.action).toBe('conflict');
    expect((await driver.applyTeamResourceUpdate('alice', profiles[0], identity.get(key('alice', profiles[0]))!, 'rollback-one', rollback)).status).toBe('complete');
    const rolledBack = await inventory(); expect(rolledBack.resources.find(resource => resource.path === 'skills/support/member-note.txt')?.content).toBe('Private member addition.\n');
    expect(rolledBack.resources.some(resource => resource.path === 'documents/new-guide.md')).toBe(false);
  });

  it('fences a parked real filesystem update across driver restart, then recovers the original immutable plan', async () => {
    const current = await inventory(), after = createTeamResourceSnapshot([...current.resources.filter(resource => resource.kind !== 'role'), text(current.resources.find(resource => resource.kind === 'role')!, 'Recovered role.\n')]);
    const update = planTeamResourceUpdate({ installed: current, current, release: after });
    expect(await fixture('alice', { operation: 'checkpoint', profile: profiles[0], operationId: 'parked-recovery', plan: update }, { journal: true, checkpoint: true })).toEqual({ parked: true });
    driver = new ObservedDriver(config);
    await expect(driver.reopen('alice')).rejects.toThrow(); expect(await driver.running('alice')).toBe(false);
    await expect(inventory()).rejects.toThrow();
    expect((await driver.applyTeamResourceUpdate('alice', profiles[0], identity.get(key('alice', profiles[0]))!, 'parked-recovery', update)).status).toBe('complete');
    expect((await inventory()).manifestHash).toBe(after.manifestHash); expect(driver.operations).toContain('fence');
  });

  it('keeps abort tombstones and rejects unsafe plans before native writes', async () => {
    const current = await inventory(), after = createTeamResourceSnapshot([...current.resources, document('cancelled.md', 'Must not install.')]);
    const update = planTeamResourceUpdate({ installed: current, current, release: after }), inode = identity.get(key('alice', profiles[0]))!;
    expect(await driver.abortTeamResourceUpdate('alice', profiles[0], inode, 'cancelled-release', update)).toEqual({ aborted: true });
    await expect(driver.applyTeamResourceUpdate('alice', profiles[0], inode, 'cancelled-release', update)).rejects.toThrow();
    const calls = driver.operations.length;
    await expect(driver.applyTeamResourceUpdate('alice', profiles[0], inode, 'unsafe', { ...update, planHash: '0'.repeat(64) })).rejects.toThrow();
    expect(driver.operations).toHaveLength(calls); expect((await inventory()).manifestHash).toBe(current.manifestHash);
  });

  it('cancels a real retained helper create before later start and preserves sibling/private files', async () => {
    let entered!: () => void, releaseGate!: () => void;
    const entry = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { releaseGate = resolve; });
    driver.delay = { entered, gate }; const executed = driver.executed;
    const capture = inventory(), refused = expect(capture).rejects.toThrow('revoked');
    let deadline!: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([entry, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Helper create acknowledgement did not arrive.')), 15000); })]);
      const stopped = driver.stop('alice'); releaseGate(); await stopped; await refused; expect(driver.executed).toBe(executed);
    } finally { clearTimeout(deadline); releaseGate(); await driver.stop('alice'); await capture.catch(() => {}); }
    expect((await docker(['container', 'ls', '-a', '--filter', `label=collective.namespace=${config.namespace}`, '--filter', 'label=collective.purpose=team-resource-helper', '--format', '{{.ID}}'])).trim()).toBe('');
    for (const owner of owners) for (const profile of profiles) {
      const current = await inspectPrivate(owner, profile), prior = privateState.get(key(owner, profile))!;
      expect(current.privateHashes).toEqual(prior.privateHashes); expect(current.identity).toBe(prior.identity); expect(current.skillExecuted).toBe(false); expect(current.journalMounted).toBe(false);
      if (owner === 'bob' || profile === profiles[1]) expect((await snapshot(owner, profile)).manifestHash).toBe(initial.manifestHash);
    }
  });
});
