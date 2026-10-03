import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DockerBroker } from '@/docker-hermes/broker';
import { DockerDriver, BrokerConfig } from '@/docker-hermes/docker';
const exec = promisify(execFile);
const PIN = 'nousresearch/hermes-agent@sha256:2fd023efbb8d3d2b0ce1a73d028b07370cff34f567cfe0e999553e8c327ea283';
const image = process.env.DOCKER_HERMES_TEST_ROOTFS;
const suite = process.env.DOCKER_HERMES_NATIVE_TEST === '1' ? describe : describe.skip;
/** Storage-constrained executors can test hash-verified official rootfs with a single imported layer.
 * Only image resolution is substituted. Creation flags, Docker execution, native protocol and data are real.
 * This is NOT evidence that the original layered-image pull succeeds. */
class RootfsDriver extends DockerDriver {
  protected async command(args: string[], timeout?: number) {
    if (!image) return super.command(args, timeout);
    if (args[0] === 'pull') { await super.command(['image', 'inspect', image]); return ''; }
    const result = await super.command(args.map(v => v === PIN ? image : v), timeout);
    if (args[0] === 'inspect') {
      const entries = JSON.parse(result);
      for (const e of entries) if (e.Config?.Image === image) e.Config.Image = PIN;
      return JSON.stringify(entries);
    }
    return result;
  }
}
const until = async (fn: () => Promise<boolean>, ms = 60000) => { const end = Date.now() + ms; while (!await fn()) { if (Date.now() > end) throw new Error('Native lifecycle timed out'); await new Promise(r => setTimeout(r, 150)); } };
suite('REAL Docker + official pinned native Hermes (local mock provider, no live credentials)', () => {
  let root: string, broker: DockerBroker, driver: RootfsDriver, lease: NodeJS.Timeout;
  const owners = ['native-alice', 'native-bob'];
  beforeAll(async () => {
    if (image) {
      const [info] = JSON.parse((await exec('docker', ['image', 'inspect', image])).stdout);
      if (info.Config.Labels?.['collective.test.source'] !== PIN.split('@')[1]) throw new Error('Only verified official rootfs test images are allowed');
    }
    root = await mkdtemp(path.join(tmpdir(), 'dh-real-'));
    await mkdir(path.join(root, 'state'), { mode: 0o700 }); await mkdir(path.join(root, 'ipc'), { mode: 0o700 });
    const config = BrokerConfig.parse({ stateDir: path.join(root, 'state'), socketPath: path.join(root, 'ipc/b.sock'), bridgePath: path.resolve('src/docker-hermes/bridge.py'),
      namespace: `cui-smoke-${Date.now()}`, image: PIN, network: 'none' });
    driver = new RootfsDriver(config); broker = new DockerBroker(config, driver);
    lease = setInterval(() => owners.forEach(owner => broker.authorize(owner, true)), 15000);
  });
  afterAll(async () => {
    clearInterval(lease); await broker?.close();
    // Cleanup only exact disposable objects created by this test; production stop never purges volumes.
    if (driver) for (const owner of owners) {
      await exec('docker', ['rm', driver.name(owner)]).catch(() => {});
      await exec('docker', ['volume', 'rm', `${driver.name(owner)}-data`]).catch(() => {});
    }
    if (root) await rm(root, { recursive: true, force: true });
  });
  const ready = async (owner: string) => {
    broker.authorize(owner, true); broker.enable(owner);
    await until(async () => { const s = await broker.status(owner); if (s.phase === 'error') throw new Error(s.error ?? 'Setup failed'); return s.phase === 'ready'; }, 240000);
  };
  async function native(owner: string, code: string) {
    return exec('docker', ['exec', '--user', '10000:10000', driver.name(owner), '/opt/hermes/.venv/bin/python', '-c', code], { maxBuffer: 1024 * 1024 });
  }
  async function mockProvider(owner: string, profile = 'default') {
    const name = driver.name(owner);
    await exec('docker', ['cp', 'dev/mock-llm', `${name}:/tmp/collective-mock`]);
    await exec('docker', ['exec', name, 'chown', '-R', '10000:10000', '/tmp/collective-mock']);
    await exec('docker', ['exec', '-d', '--user', '10000:10000', '--env', 'PORT=4010', name, 'node', '/tmp/collective-mock/server.mjs']);
    await until(async () => { try { await native(owner, "import urllib.request; urllib.request.urlopen('http://127.0.0.1:4010/v1/models', timeout=1).read()"); return true; } catch { return false; } }, 10000);
    await native(owner, `from pathlib import Path\nimport yaml\nh=Path('/opt/data${profile === 'default' ? '' : `/profiles/${profile}`}')\nc=yaml.safe_load((h/'config.yaml').read_text()) or {}\nc['model']={'default':'mock-gpt','provider':'custom','base_url':'http://127.0.0.1:4010/v1'}\nc['security']={'allow_lazy_installs':False,'tirith_enabled':False}\nc['toolsets']=['terminal']\n(h/'config.yaml').write_text(yaml.safe_dump(c))\n(h/'.env').write_text('OPENAI_API_KEY=synthetic-mock-only\\nOPENAI_BASE_URL=http://127.0.0.1:4010/v1\\n')`);
  }
  it('provisions two actual isolated runtimes and one native starter per owner without duplicate enable', async () => {
    await ready(owners[0]); await ready(owners[1]);
    broker.enable(owners[0]);
    for (const owner of owners) {
      expect((await broker.status(owner)).bindings).toHaveLength(1);
      const [info] = JSON.parse((await exec('docker', ['inspect', driver.name(owner)])).stdout);
      expect(info.HostConfig.NetworkMode).toBe('none'); expect(info.HostConfig.Privileged).toBe(false);
      expect(info.Mounts.some((m: {Destination: string}) => m.Destination.includes('docker.sock'))).toBe(false);
      expect((await native(owner, "import os; print(os.getuid()); print('DATABASE_URL' in os.environ)")).stdout).toBe('10000\nFalse\n');
    }
    const a = (await broker.status(owners[0])).bindings[0];
    await expect(broker.resources(owners[1], a.bindingId)).rejects.toThrow('belong');
  }, 360000); // Two cold VFS image copies can exceed the normal sandbox-test timeout.
  it('creates/replays a native profile, discovers real CLI-created profiles, and rejects symlinks/backups', async () => {
    const request = { name: 'Coder', requestId: randomUUID() };
    const [a, b] = await Promise.all([broker.create(owners[0], request), broker.create(owners[0], request)]); expect(a).toEqual(b);
    await native(owners[0], "from hermes_cli.profiles import create_profile\nfrom pathlib import Path\ncreate_profile('external',no_alias=True)\np=Path('/opt/data/profiles')\n(p/'arbitrary').mkdir()\n(p/'linked').symlink_to('/opt/data')\n(p/'backup').mkdir()\n(p/'backup'/'config.yaml').write_text('{}')\n(p/'backup'/'SOUL.md').write_text('backup')");
    const found = (await broker.status(owners[0])).unlinked;
    expect(found.map(p => p.name)).toEqual(['external']);
    const external = await broker.link(owners[0], { profile: found[0].name, identity: found[0].identity, name: 'External' });
    expect((await broker.status(owners[0])).unlinked).toEqual([]);
    await native(owners[0], "from pathlib import Path\np=Path('/opt/data/profiles/external')\n(p/'memories'/'MEMORY.md').write_text('Remember this fact\\nAPI_KEY=synthetic-secret')\n(p/'memories'/'USER.md').symlink_to(p/'.env')\ns=p/'skills'/'safe';s.mkdir();(s/'SKILL.md').write_text('---\\nname: Safe skill\\n---\\nDo a safe thing')\n(p/'skills'/'escape').symlink_to('/opt/data')");
    const resources = await broker.resources(owners[0], external.bindingId);
    expect(resources.memories[0].content).toContain('Remember this fact');
    expect(JSON.stringify(resources)).not.toContain('synthetic-secret');
    expect(resources.skills.some(s => s.id.includes('escape'))).toBe(false);
  });
  it('runs actual native text, approval/cancel and cold native-session resume through the retained protocol', async () => {
    const owner = owners[1]; await broker.stop(owner);
    await exec('docker', ['start', driver.name(owner)]); await mockProvider(owner);
    // enable deliberately stops old writers; the mock is restarted after native setup and before inference.
    await ready(owner); await mockProvider(owner);
    const binding = (await broker.status(owner)).bindings[0];
    let pair = await broker.forRequest(owner, binding.bindingId);
    const run = pair.controller.begin(pair.nativeBindingId, { input: 'Native Docker hello', session_id: 'test-conversation' }, 'native-first');
    await until(async () => ['completed','failed','interrupted'].includes(pair.controller.getRun(run).status));
    expect(pair.controller.getRun(run)).toMatchObject({ status: 'completed' });
    expect(JSON.stringify(pair.controller.events(run, 0))).toContain('Native Docker hello');
    await broker.stop(owner); await ready(owner); await mockProvider(owner); pair = await broker.forRequest(owner, binding.bindingId);
    const second = pair.controller.begin(pair.nativeBindingId, { input: 'Native resumed hello', session_id: 'test-conversation' }, 'native-second');
    await until(async () => ['completed','failed','interrupted'].includes(pair.controller.getRun(second).status));
    expect(pair.controller.getRun(second).status).toBe('completed');
    const allowed = pair.controller.begin(pair.nativeBindingId, { input: '[tool:terminal {"command":"rm -rf /tmp/synthetic-once-target"}]', session_id: 'test-allow-once' }, 'native-allow-once');
    await until(async () => pair.controller.getRun(allowed).status === 'waiting_for_approval');
    const request = pair.controller.events(allowed, 0).events.find(e => e.event === 'approval.request')!;
    pair.controller.approve(allowed, { request_id: request.request_id, choice: 'once' });
    await until(async () => ['completed','failed','interrupted'].includes(pair.controller.getRun(allowed).status));
    expect(pair.controller.getRun(allowed).status).toBe('completed');
    expect(() => pair.controller.approve(allowed, { request_id: request.request_id, choice: 'once' })).toThrow('expired');
    const approval = pair.controller.begin(pair.nativeBindingId, { input: '[tool:terminal {"command":"rm -rf /tmp/synthetic-approved-target"}]', session_id: 'test-approval' }, 'native-approval');
    await until(async () => pair.controller.getRun(approval).status === 'waiting_for_approval');
    await pair.controller.cancel(approval);
    await until(async () => !['running','waiting_for_approval'].includes(pair.controller.getRun(approval).status));
    expect(['cancelled','interrupted']).toContain(pair.controller.getRun(approval).status);
  });
  it('retains actual volume/profile identities and mappings after broker restart', async () => {
    const state = await broker.status(owners[0]); await broker.close(); broker = new DockerBroker(driver.config, driver);
    await ready(owners[0]); expect((await broker.status(owners[0])).bindings).toEqual(state.bindings);
  });
  it('refuses an already-running ordinary native Hermes CLI on the selected profile', async () => {
    const owner = owners[0]; await broker.stop(owner); await driver.ensure(owner, () => {});
    const profile = (await driver.profiles(owner)).find(p => p.name === 'default')!;
    const cli = spawn('docker', ['exec', '-i', '--user', '10000:10000', driver.name(owner), '/opt/hermes/.venv/bin/hermes', '--profile', 'default', 'chat'], { stdio: ['pipe', 'pipe', 'pipe'] });
    cli.stdout.resume(); cli.stderr.resume();
    try {
      await until(async () => {
        const result = await native(owner, "from pathlib import Path\nprint(any(b'/opt/hermes/.venv/bin/hermes' in p.read_bytes().split(b'\\0') for p in Path('/proc').glob('[0-9]*/cmdline')))" );
        return result.stdout.trim() === 'True';
      }, 10000);
      await expect(exec('docker', ['exec', '-i', '--user', '10000:10000', driver.name(owner), '/opt/hermes/.venv/bin/python', '-B', '/opt/collective-bridge.py', 'gateway', 'default', profile.identity])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('operation refused') });
    } finally { cli.stdin.end(); await driver.stop(owner); }
  });

});
