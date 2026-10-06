import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { isValidElement } from 'react';
import ts from 'typescript';
import { DockerBroker } from '@/docker-hermes/broker';
import { BrokerConfig, DockerDriver, runtimeKey, type RuntimeDriver } from '@/docker-hermes/docker';
import { cleanupRetainedBroker, listenBroker } from '@/docker-hermes/main';

const pageFixture = vi.hoisted(() => ({ rows: [] as unknown[][], requireAdmin: vi.fn() }));
vi.mock('@/db', () => ({ db: { select: () => ({ from: () => {
  const rows = pageFixture.rows.shift() ?? [];
  return Object.assign(Promise.resolve(rows), { orderBy: () => Promise.resolve(rows) });
} }) } }));
vi.mock('@/lib/session', () => ({ requireAdminPage: pageFixture.requireAdmin }));
vi.mock('@/lib/settings', () => ({ getSetting: async () => ({ enabled: false }) }));
vi.mock('@/components/admin/apps-admin', () => ({ AppsAdmin: () => null }));
vi.mock('@/components/admin/ui', () => ({ AdminHeader: () => null }));

let root: string;
let config: BrokerConfig;
const listeners: Awaited<ReturnType<typeof listenBroker>>[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'dh-review-'));
  await mkdir(path.join(root, 'state'), { mode: 0o700 });
  await mkdir(path.join(root, 'ipc'), { mode: 0o700 });
  config = BrokerConfig.parse({ stateDir: path.join(root, 'state'), socketPath: path.join(root, 'ipc/b.sock'),
    bridgePath: path.resolve('src/docker-hermes/bridge.py'), namespace: 'cui-review',
    image: `nousresearch/hermes-agent@sha256:${'a'.repeat(64)}`, network: 'none' });
});
afterEach(async () => {
  for (const listener of listeners.splice(0)) await listener.close();
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** No Docker invocation: only the durable journal and broker lifecycle are real. */
function retainedDriver(owners: string[]) {
  const active = new Set(owners);
  const driver: RuntimeDriver = {
    running: vi.fn(async owner => active.has(owner)),
    stop: vi.fn(async owner => { active.delete(owner); }),
    ensure: vi.fn(async () => { throw new Error('Recovery must not start a runtime'); }),
    profiles: vi.fn(async () => []),
    create: vi.fn(async () => { throw new Error('Recovery must not create a profile'); }),
    resources: vi.fn(async () => ({ skills: [], memories: [] })),
    transport: vi.fn(() => { throw new Error('Recovery must not replay native work'); }),
  };
  return { driver, active };
}

async function journal(owner: string) {
  const dir = path.join(config.stateDir, runtimeKey(owner));
  await mkdir(dir, { mode: 0o700 });
  const binding = { ownerId: owner, bindingId: 'b'.repeat(32), botId: 'c'.repeat(32), appId: 'd'.repeat(32),
    runtimeId: runtimeKey(owner), name: 'Hermes', profile: 'default', identity: '1:101' };
  const pending = { '11111111-1111-4111-8111-111111111111': { profile: `cui-${'e'.repeat(32)}`, name: 'Pending bot' } };
  await writeFile(path.join(dir, 'runtime.json'), JSON.stringify({ owner, generation: 3, phase: 'ready', error: null,
    bindings: [binding], pending }), { mode: 0o600 });
  return { dir, binding, pending };
}

/** A real process death leaves the Unix socket behind, unlike server.close(). */
async function crashSocketOwner() {
  const child = spawn(process.execPath, ['-e',
    "require('node:net').createServer().listen(process.argv[1], () => process.stdout.write('ready'));",
    config.socketPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    await Promise.race([once(child.stdout, 'data'), exited.then(() => { throw new Error('Socket owner exited before listening'); })]);
    await writeFile(path.join(config.stateDir, 'broker.lock'), JSON.stringify({ pid: child.pid }), { mode: 0o600 });
    expect(child.kill('SIGKILL')).toBe(true);
    const [code, signal] = await exited;
    expect(code).toBeNull();
    expect(signal).toBe('SIGKILL');
    expect((await stat(config.socketPath)).isSocket()).toBe(true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
}

describe('Docker Hermes security review regressions', () => {
  it('cleans up after an actual SIGKILL and permits a new listener on the retained socket path', async () => {
    const saved = await journal('alice');
    const { driver, active } = retainedDriver(['alice']);
    await crashSocketOwner();
    await cleanupRetainedBroker(config, driver);
    expect(active.size).toBe(0);
    await expect(stat(config.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(config.stateDir, 'broker.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    const persisted = JSON.parse(await readFile(path.join(saved.dir, 'runtime.json'), 'utf8'));
    expect(persisted.bindings).toEqual([saved.binding]);
    expect(persisted.pending).toEqual(saved.pending);
    listeners.push(await listenBroker(new DockerBroker(config, driver)));
    expect((await stat(config.socketPath)).isSocket()).toBe(true);
    expect(driver.ensure).not.toHaveBeenCalled();
    expect(driver.transport).not.toHaveBeenCalled();
  });

  it('refuses to unlink an ordinary file at the stale socket path and retains the crash lock', async () => {
    const { driver } = retainedDriver([]);
    await crashSocketOwner();
    await unlink(config.socketPath);
    await writeFile(config.socketPath, 'unrelated file', { mode: 0o600 });
    await expect(cleanupRetainedBroker(config, driver)).rejects.toThrow('unsafe stale IPC endpoint');
    expect(await readFile(config.socketPath, 'utf8')).toBe('unrelated file');
    expect((await stat(path.join(config.stateDir, 'broker.lock'))).isFile()).toBe(true);
  });

  it('refuses retained cleanup while the recorded broker PID is alive', async () => {
    await journal('alice');
    const { driver, active } = retainedDriver(['alice']);
    await writeFile(path.join(config.stateDir, 'broker.lock'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    await expect(cleanupRetainedBroker(config, driver)).rejects.toThrow('Broker is still alive');
    expect(driver.stop).not.toHaveBeenCalled();
    expect(active).toEqual(new Set(['alice']));
    expect((await stat(path.join(config.stateDir, 'broker.lock'))).isFile()).toBe(true);
  });

  it('stops an interrupted retained runtime without a lease and preserves its identities and pending receipts', async () => {
    const saved = await journal('alice');
    const { driver, active } = retainedDriver(['alice']);
    const broker = new DockerBroker(config, driver);
    expect((await broker.status('alice')).phase).toBe('interrupted');
    await broker.expireLeases();
    expect(active.has('alice')).toBe(false);
    expect((await broker.status('alice')).phase).toBe('stopped');
    const persisted = JSON.parse(await readFile(path.join(saved.dir, 'runtime.json'), 'utf8'));
    expect(persisted.bindings).toEqual([saved.binding]);
    expect(persisted.pending).toEqual(saved.pending);
    expect(driver.ensure).not.toHaveBeenCalled();
    expect(driver.transport).not.toHaveBeenCalled();
  });

  it('keeps failed cleanup honest, stops other owners, and retries the unconfirmed owner on the next sweep', async () => {
    await journal('alice'); await journal('bob');
    const { driver, active } = retainedDriver(['alice', 'bob']);
    let rejectAlice = true;
    driver.stop = vi.fn(async owner => {
      if (owner === 'alice' && rejectAlice) throw new Error('Synthetic Docker failure');
      active.delete(owner);
    });
    const broker = new DockerBroker(config, driver);
    await broker.expireLeases();
    expect(await broker.status('alice')).toMatchObject({ phase: 'error', error: expect.stringContaining('unconfirmed') });
    expect(active).toEqual(new Set(['alice']));
    expect((await broker.status('bob')).phase).toBe('stopped');
    rejectAlice = false;
    broker.authorize('alice', true); // Renewal cannot suppress an unconfirmed cleanup retry.
    await broker.expireLeases();
    expect(active.size).toBe(0);
    expect((await broker.status('alice')).phase).toBe('stopped');
  });

  it('does not open IPC until retained-runtime startup cleanup has settled', async () => {
    await journal('alice');
    const { driver, active } = retainedDriver(['alice']);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const stopping = new Promise<void>(resolve => { entered = resolve; });
    driver.stop = vi.fn(async owner => { entered(); await gate; active.delete(owner); });
    const broker = new DockerBroker(config, driver);
    const startup = listenBroker(broker);
    try {
      await stopping;
      await expect(stat(config.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      release(); listeners.push(await startup);
    }
    expect(active.size).toBe(0);
    expect((await stat(config.socketPath)).isSocket()).toBe(true);
  });

  it.each(['none', 'proxy'] as const)('rejects additional network attachments even when the primary %s network is unchanged', async network => {
    const selected = BrokerConfig.parse({ ...config, network });
    const name = `${selected.namespace}-${runtimeKey('alice')}`;
    const networkName = network === 'none' ? 'none' : `${name}-egress`;
    const info = {
      Config: { Image: selected.image, Labels: { 'collective.owner': runtimeKey('alice'), 'collective.namespace': selected.namespace } },
      State: { Running: true },
      NetworkSettings: { Networks: { [networkName]: {} } as Record<string, object> },
      HostConfig: { Privileged: false, NetworkMode: networkName, IpcMode: 'private', CapDrop: ['ALL'],
        CapAdd: ['CAP_CHOWN', 'CAP_DAC_OVERRIDE', 'CAP_SETGID', 'CAP_SETUID'], SecurityOpt: ['no-new-privileges:true'],
        Memory: selected.memoryMb * 1024 * 1024, MemorySwap: selected.memoryMb * 1024 * 1024,
        NanoCpus: selected.cpus * 1e9, PidsLimit: 256, RestartPolicy: { Name: 'no' } },
      Mounts: [{ Type: 'volume', Name: `${name}-data`, Destination: '/opt/data', RW: true },
        { Type: 'bind', Source: selected.bridgePath, Destination: '/opt/collective-bridge.py', RW: false }],
    };
    const calls: string[][] = [];
    class InspectedDriver extends DockerDriver {
      protected async command(args: string[]) {
        calls.push(args);
        if (args[0] === 'container' && args[1] === 'ls') return 'owned-container-id\n';
        if (args[0] === 'inspect') return JSON.stringify([info]);
        if (args[0] === 'network' && args[1] === 'inspect') return JSON.stringify([{ Driver: 'bridge', Internal: true,
          Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' },
          Labels: { 'collective.owner': runtimeKey('alice'), 'collective.namespace': selected.namespace,
            'collective.egress-policy': 'deny-private-allowlist' }, Containers: {} }]);
        throw new Error(`Unexpected Docker mutation: ${args[0]}`);
      }
    }
    const driver = new InspectedDriver(selected);
    await expect(driver.running('alice')).resolves.toBe(true);
    info.NetworkSettings.Networks.bridge = {};
    await expect(driver.running('alice')).rejects.toThrow('configuration changed');
    expect(info.HostConfig.NetworkMode).toBe(networkName);
    expect(calls.every(args => args[0] === 'inspect' || (args[0] === 'container' && args[1] === 'ls') ||
      (args[0] === 'network' && args[1] === 'inspect'))).toBe(true);
  });

  it.each([
    { name: 'ordinary internal IPv4', ipv6: false, options: {} },
    { name: 'NAT IPv4 gateway', ipv6: false, options: { gateway_mode_ipv4: 'nat' } },
    { name: 'ordinary internal IPv6', ipv6: true, options: { gateway_mode_ipv4: 'isolated' } },
    { name: 'routed IPv6 gateway', ipv6: true, options: { gateway_mode_ipv4: 'isolated', gateway_mode_ipv6: 'routed' } },
    { name: 'trusted host interface', ipv6: true, options: { gateway_mode_ipv4: 'isolated', gateway_mode_ipv6: 'isolated', trusted_host_interfaces: 'eth0' } },
  ])('rejects $name in a proxy network even when ownership and Internal remain valid', async ({ ipv6, options }) => {
    const selected = BrokerConfig.parse({ ...config, network: 'proxy' });
    const network = { Driver: 'bridge', Internal: true, EnableIPv6: true,
      Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated',
        'com.docker.network.bridge.gateway_mode_ipv6': 'isolated' } as Record<string, string>,
      Labels: { 'collective.owner': runtimeKey('alice'), 'collective.namespace': selected.namespace,
        'collective.egress-policy': 'deny-private-allowlist' }, Containers: {} };
    class NetworkDriver extends DockerDriver {
      protected async command(args: string[]) {
        if (args[0] === 'network' && args[1] === 'inspect') return JSON.stringify([network]);
        if (args[0] === 'container' && args[1] === 'ls') return '';
        throw new Error(`Unexpected Docker mutation: ${args[0]}`);
      }
    }
    const driver = new NetworkDriver(selected);
    await expect(driver.running('alice')).resolves.toBe(false);
    network.EnableIPv6 = ipv6;
    network.Options = Object.fromEntries(Object.entries(options).map(([key, value]) => [`com.docker.network.bridge.${key}`, value]));
    await expect(driver.running('alice')).rejects.toThrow('isolated-gateway per-user network');
  });

  it('omits personal runtime names and bindings from company connection component props', async () => {
    const company = { id: 'company-app', name: 'Company model', provider: 'openai', providerConfig: {} };
    const personal = { id: 'personal-app', name: 'Private owner project name', provider: 'hermes',
      providerConfig: { docker: { ownerId: 'another-admin', bindingId: 'private-binding' } } };
    pageFixture.rows = [[company, personal], [], []];
    pageFixture.requireAdmin.mockResolvedValue({ user: { id: 'review-admin' }, isAdmin: true });
    const { default: AdminAppsPage } = await import('@/app/admin/apps/page');
    const page = await AdminAppsPage();
    const panel = page.props.children.find((child: unknown) => isValidElement<{ apps?: unknown }>(child) && Array.isArray(child.props.apps));
    expect(isValidElement<{ apps: { id: string }[] }>(panel)).toBe(true);
    if (!isValidElement<{ apps: { id: string }[] }>(panel)) throw new Error('Missing company connection component');
    expect(panel.props.apps.map(app => app.id)).toEqual(['company-app']);
    expect(JSON.stringify(page)).not.toContain(personal.name);
    expect(JSON.stringify(page)).not.toContain('private-binding');
    expect(pageFixture.requireAdmin).toHaveBeenCalled();
  });

  it.each(['src/app/(chat)/actions.ts', 'src/app/(chat)/bots/actions.ts'])('keeps %s declared as a server action module', async file => {
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const first = source.statements[0];
    expect(ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === 'use server').toBe(true);
  });
});
