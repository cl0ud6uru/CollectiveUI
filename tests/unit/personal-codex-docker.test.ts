import { describe, expect, it } from 'vitest';
import { BrokerConfig, PersonalCodexDriver, runtimeKey } from '@/personal-codex/docker';

const OWNER = 'member-101';
const OTHER_OWNER = 'member-202';
const IMAGE = `collectiveui/personal-codex@sha256:${'a'.repeat(64)}`;
const NAMESPACE = 'cui-codex-test';
const labels = (owner = OWNER, namespace = NAMESPACE) => ({
  'collective.codex.owner': runtimeKey(owner),
  'collective.codex.namespace': namespace,
});
const config = (owners = [OWNER]) => BrokerConfig.parse({
  socketPath: '/run/docker.sock', image: IMAGE, namespace: NAMESPACE, owners,
});

function containerFixture(owner = OWNER) {
  const name = `${NAMESPACE}-${runtimeKey(owner)}`;
  return {
    Name: `/${name}`,
    Config: {
      Labels: labels(owner), Image: IMAGE, User: '10001:10001', WorkingDir: '/home/agent/workspace',
      Cmd: ['node', '/opt/collective-codex/server.mjs'], Entrypoint: [],
      Env: [
        'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/codex-home', 'CODEX_HOME=/codex-home',
        'HTTP_PROXY=http://codex-egress:3128', 'HTTPS_PROXY=http://codex-egress:3128',
        'NO_PROXY=127.0.0.1,localhost',
      ],
    },
    HostConfig: {
      Privileged: false, ReadonlyRootfs: true, PidMode: '', UTSMode: '', UsernsMode: '', IpcMode: 'private',
      Binds: [] as string[], Devices: [], DeviceRequests: [], ExtraHosts: [], CapDrop: ['ALL'], CapAdd: [] as string[],
      SecurityOpt: ['no-new-privileges:true'], Memory: 2048 * 1024 * 1024,
      MemorySwap: 2048 * 1024 * 1024, NanoCpus: 2e9, PidsLimit: 256, RestartPolicy: { Name: 'no' },
      LogConfig: { Type: 'none' }, PortBindings: {}, NetworkMode: `${name}-egress`,
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=256m,mode=1777' },
    },
    Mounts: [
      { Type: 'volume', Name: `${name}-home`, Destination: '/codex-home', RW: true },
      { Type: 'volume', Name: `${name}-workspace`, Destination: '/home/agent/workspace', RW: true },
    ],
    NetworkSettings: { Networks: { [`${name}-egress`]: {} } },
    State: { Running: true },
  };
}

function networkFixture(owner = OWNER) {
  return {
    Driver: 'bridge', Internal: true, EnableIPv6: false, Labels: labels(owner),
    Options: {
      'com.docker.network.bridge.gateway_mode_ipv4': 'isolated',
      'com.docker.network.bridge.enable_icc': 'false',
    },
    Containers: {},
  };
}

function volumeFixture(name: string, owner = OWNER) {
  return { Name: name, Driver: 'local', Options: {}, Labels: labels(owner) };
}

/** Replaces only the driver's Docker command boundary; no Docker process is spawned. */
class FakeDockerDriver extends PersonalCodexDriver {
  readonly calls: string[][] = [];
  readonly volumes = new Map<string, ReturnType<typeof volumeFixture>>();
  container: ReturnType<typeof containerFixture> | null = null;
  readonly otherContainers = new Map<string, ReturnType<typeof containerFixture>>();
  networkDoc = networkFixture();
  peer: unknown = null;
  imageExists = true;

  constructor(owners = [OWNER]) { super(config(owners)); }

  protected override async command(args: string[]) {
    this.calls.push([...args]);
    if (args[0] === 'network' && args[1] === 'inspect') {
      const enrolledOwner = this.config.owners.find(owner => `${this.name(owner)}-egress` === args[2]);
      return JSON.stringify([enrolledOwner === OWNER ? this.networkDoc : networkFixture(enrolledOwner)]);
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      if (!this.imageExists) throw new Error('image absent');
      return '[]';
    }
    if (args[0] === 'container' && args[1] === 'ls') {
      const filter = args.find(arg => arg.startsWith('name=^/'));
      const name = filter?.slice('name=^/'.length, -1);
      return (name === this.name(OWNER) ? this.container : this.otherContainers.get(name ?? '')) ? 'container-id\n' : '';
    }
    if (args[0] === 'volume' && args[1] === 'ls') {
      const name = args.find(arg => arg.startsWith('name=^'))?.slice('name=^'.length, -1);
      return name && this.volumes.has(name) ? `${name}\n` : '';
    }
    if (args[0] === 'volume' && args[1] === 'create') {
      const name = args.at(-1)!;
      const ownerLabel = args.find(arg => arg.startsWith('collective.codex.owner='))?.split('=')[1];
      const namespaceLabel = args.find(arg => arg.startsWith('collective.codex.namespace='))?.split('=')[1];
      this.volumes.set(name, { Name: name, Driver: 'local', Options: {}, Labels: {
        'collective.codex.owner': ownerLabel!, 'collective.codex.namespace': namespaceLabel!,
      } });
      return name;
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      const volume = this.volumes.get(args[2]);
      if (!volume) throw new Error('volume absent');
      return JSON.stringify([volume]);
    }
    if (args[0] === 'create') {
      const name = args[args.indexOf('--name') + 1];
      const owner = this.config.owners.find(candidate => this.name(candidate) === name)!;
      if (owner === OWNER) this.container = containerFixture(owner);
      else this.otherContainers.set(name, containerFixture(owner));
      return 'container-id';
    }
    if (args[0] === 'start') {
      if (this.container) this.container.State.Running = true;
      return '';
    }
    if (args[0] === 'inspect') {
      if (this.peer && args[1] === 'peer-id') return JSON.stringify([this.peer]);
      const owner = this.config.owners.find(candidate => this.name(candidate) === args[1]);
      const container = owner === OWNER ? this.container : this.otherContainers.get(args[1]);
      if (!container) throw new Error('container absent');
      return JSON.stringify([container]);
    }
    throw new Error(`Unexpected fake Docker command: ${args.join(' ')}`);
  }

  seedVolumes() {
    const prefix = `${NAMESPACE}-${runtimeKey(OWNER)}`;
    this.volumes.set(`${prefix}-home`, volumeFixture(`${prefix}-home`));
    this.volumes.set(`${prefix}-workspace`, volumeFixture(`${prefix}-workspace`));
  }

  expectNoDestructiveOrExpansiveDockerCalls() {
    expect(this.calls.some(args => args[0] === 'pull' || (args[0] === 'image' && args[1] === 'pull'))).toBe(false);
    expect(this.calls.some(args => args[0] === 'network' && args[1] === 'create')).toBe(false);
    expect(this.calls.some(args => args[0] === 'volume' && args[1] === 'rm')).toBe(false);
    expect(this.calls.some(args => args[0] === 'container' && args[1] === 'rm')).toBe(false);
    expect(this.calls.some(args => args[0] === 'rm')).toBe(false);
  }
}

const unavailable = /configuration or storage needs operator reconciliation/i;

describe('personal Codex Docker isolation', () => {
  it('creates a container only with fixed, bounded argv and exact enrolled resources', async () => {
    const driver = new FakeDockerDriver();
    await driver.ensure(OWNER);

    const create = driver.calls.find(args => args[0] === 'create');
    expect(create).toEqual([
      'create', '--name', driver.name(OWNER), '--label', `collective.codex.owner=${runtimeKey(OWNER)}`,
      '--label', `collective.codex.namespace=${NAMESPACE}`, '--user', '10001:10001', '--workdir', '/home/agent/workspace',
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '256',
      '--memory', '2048m', '--memory-swap', '2048m', '--cpus', '2', '--network', `${driver.name(OWNER)}-egress`,
      '--restart', 'no', '--log-driver', 'none', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
      '--mount', `type=volume,src=${driver.name(OWNER)}-home,dst=/codex-home`,
      '--mount', `type=volume,src=${driver.name(OWNER)}-workspace,dst=/home/agent/workspace`,
      '--env', 'NODE_VERSION', '--env', 'YARN_VERSION', '--env', 'HOME=/codex-home', '--env', 'CODEX_HOME=/codex-home',
      '--env', 'HTTP_PROXY=http://codex-egress:3128', '--env', 'HTTPS_PROXY=http://codex-egress:3128',
      '--env', 'NO_PROXY=127.0.0.1,localhost', IMAGE, 'node', '/opt/collective-codex/server.mjs',
    ]);
    expect(driver.calls.filter(args => args[0] === 'volume' && args[1] === 'create')).toHaveLength(2);
    expect(driver.calls.some(args => args[0] === 'image' && args[1] === 'inspect' && args[2] === IMAGE)).toBe(true);
    driver.expectNoDestructiveOrExpansiveDockerCalls();
    expect(driver.volumes.size).toBe(2); // persistent user data remains provisioned
  });

  it('derives distinct container and persistent volume names per enrolled owner', async () => {
    const driver = new FakeDockerDriver([OWNER, OTHER_OWNER]);
    await driver.ensure(OWNER);
    await driver.ensure(OTHER_OWNER);
    expect(driver.name(OWNER)).not.toBe(driver.name(OTHER_OWNER));
    expect([...driver.volumes.keys()]).toContain(`${driver.name(OWNER)}-home`);
    expect([...driver.volumes.keys()]).toContain(`${driver.name(OWNER)}-workspace`);
    expect([...driver.volumes.keys()]).toContain(`${driver.name(OTHER_OWNER)}-home`);
    expect([...driver.volumes.keys()]).toContain(`${driver.name(OTHER_OWNER)}-workspace`);
    driver.expectNoDestructiveOrExpansiveDockerCalls();
  });

  it('denies owners outside the operator enrollment before making Docker calls', async () => {
    const driver = new FakeDockerDriver();
    expect(() => driver.name(OTHER_OWNER)).toThrow(unavailable);
    await expect(driver.ensure(OTHER_OWNER)).rejects.toThrow(unavailable);
    expect(driver.calls).toEqual([]);
  });

  it('rejects foreign labels on the network, container, or retained volumes', async () => {
    const badNetwork = new FakeDockerDriver();
    badNetwork.networkDoc.Labels = labels(OTHER_OWNER);
    await expect(badNetwork.ensure(OWNER)).rejects.toThrow(unavailable);
    expect(badNetwork.calls.some(args => args[0] === 'image')).toBe(false);

    const badContainer = new FakeDockerDriver();
    badContainer.container = containerFixture();
    badContainer.container.Config.Labels = labels(OTHER_OWNER);
    badContainer.seedVolumes();
    await expect(badContainer.inspect(OWNER)).rejects.toThrow(unavailable);

    const badVolume = new FakeDockerDriver();
    badVolume.container = containerFixture();
    badVolume.seedVolumes();
    badVolume.volumes.get(`${badVolume.name(OWNER)}-home`)!.Labels = labels(OTHER_OWNER);
    await expect(badVolume.inspect(OWNER)).rejects.toThrow(unavailable);
    for (const driver of [badNetwork, badContainer, badVolume]) driver.expectNoDestructiveOrExpansiveDockerCalls();
  });

  it.each([
    ['host Docker socket or other bind mount', (c: ReturnType<typeof containerFixture>) => { c.HostConfig.Binds = ['/var/run/docker.sock:/var/run/docker.sock']; }],
    ['extra volume mount', (c: ReturnType<typeof containerFixture>) => { c.Mounts.push({ Type: 'volume', Name: 'foreign', Destination: '/extra', RW: true }); }],
    ['privileged mode', (c: ReturnType<typeof containerFixture>) => { c.HostConfig.Privileged = true; }],
    ['added capabilities', (c: ReturnType<typeof containerFixture>) => { c.HostConfig.CapAdd = ['SYS_ADMIN']; }],
    ['host networking', (c: ReturnType<typeof containerFixture>) => { c.HostConfig.NetworkMode = 'host'; }],
    ['mutable or wrong image', (c: ReturnType<typeof containerFixture>) => { c.Config.Image = 'attacker/image:latest'; }],
    ['server API secret in environment', (c: ReturnType<typeof containerFixture>) => { c.Config.Env.push('OPENAI_API_KEY=sk-test-not-a-real-secret'); }],
    ['unapproved environment variable', (c: ReturnType<typeof containerFixture>) => { c.Config.Env.push('EXTRA=value'); }],
  ])('rejects an existing container with %s', async (_case, mutate) => {
    const driver = new FakeDockerDriver();
    driver.container = containerFixture();
    mutate(driver.container);
    driver.seedVolumes();
    await expect(driver.inspect(OWNER)).rejects.toThrow(unavailable);
    driver.expectNoDestructiveOrExpansiveDockerCalls();
    expect(driver.volumes.size).toBe(2);
  });

  it('rejects unsafe egress networks and unexpected or mounted peers', async () => {
    const wrongProxy = new FakeDockerDriver();
    wrongProxy.networkDoc.Options['com.docker.network.bridge.gateway_mode_ipv4'] = 'nat';
    await expect(wrongProxy.ensure(OWNER)).rejects.toThrow(unavailable);

    const wrongPeer = new FakeDockerDriver();
    wrongPeer.networkDoc.Containers = { 'peer-id': {} };
    wrongPeer.peer = { Name: '/unapproved-proxy', Config: { Labels: labels(OWNER) }, Mounts: [] };
    await expect(wrongPeer.ensure(OWNER)).rejects.toThrow(unavailable);

    const mountedPeer = new FakeDockerDriver();
    mountedPeer.networkDoc.Containers = { 'peer-id': {} };
    mountedPeer.peer = {
      Name: '/unapproved-proxy', Config: { Labels: { ...labels(), 'collective.codex.egress-proxy': 'true' } },
      Mounts: [{ Type: 'bind', Source: '/', Destination: '/host' }],
    };
    await expect(mountedPeer.ensure(OWNER)).rejects.toThrow(unavailable);
    for (const driver of [wrongProxy, wrongPeer, mountedPeer]) driver.expectNoDestructiveOrExpansiveDockerCalls();
  });

  it('retains data and refuses to repair missing volumes once a container exists', async () => {
    const driver = new FakeDockerDriver();
    driver.container = containerFixture();
    driver.volumes.set(`${driver.name(OWNER)}-home`, volumeFixture(`${driver.name(OWNER)}-home`));
    await expect(driver.ensure(OWNER)).rejects.toThrow(unavailable);
    expect(driver.calls.some(args => args[0] === 'volume' && args[1] === 'create')).toBe(false);
    expect(driver.volumes.size).toBe(1);
    driver.expectNoDestructiveOrExpansiveDockerCalls();
  });

  it('refuses to overwrite or adopt a colliding existing volume with foreign metadata', async () => {
    const driver = new FakeDockerDriver();
    const home = `${driver.name(OWNER)}-home`;
    driver.volumes.set(home, volumeFixture(home, OTHER_OWNER));
    await expect(driver.ensure(OWNER)).rejects.toThrow(unavailable);
    expect(driver.calls.some(args => args[0] === 'volume' && args[1] === 'create' && args.at(-1) === home)).toBe(false);
    expect(driver.volumes.get(home)?.Labels).toEqual(labels(OTHER_OWNER)); // retained as found
    driver.expectNoDestructiveOrExpansiveDockerCalls();
  });

  it('starts only an existing, exact retained container and never creates missing storage', async () => {
    const stopped = new FakeDockerDriver();
    stopped.container = containerFixture();
    stopped.container.State.Running = false;
    stopped.seedVolumes();
    await stopped.startRetained(OWNER);
    expect(stopped.calls.some(args => args[0] === 'start' && args[1] === stopped.name(OWNER))).toBe(true);
    expect(stopped.calls.some(args => args[0] === 'create')).toBe(false);
    expect(stopped.calls.some(args => args[0] === 'volume' && args[1] === 'create')).toBe(false);
    expect(stopped.volumes.size).toBe(2);
    stopped.expectNoDestructiveOrExpansiveDockerCalls();

    const absent = new FakeDockerDriver();
    await expect(absent.startRetained(OWNER)).rejects.toThrow(unavailable);
    expect(absent.calls.some(args => args[0] === 'create' || args[0] === 'volume')).toBe(false);
    absent.expectNoDestructiveOrExpansiveDockerCalls();
  });

  it('does not start a container with invalid existing metadata during retained recovery', async () => {
    const driver = new FakeDockerDriver();
    driver.container = containerFixture();
    driver.container.State.Running = false;
    driver.container.HostConfig.Privileged = true;
    driver.seedVolumes();
    await expect(driver.startRetained(OWNER)).rejects.toThrow(unavailable);
    expect(driver.calls.some(args => args[0] === 'start' || args[0] === 'create')).toBe(false);
    expect(driver.volumes.size).toBe(2);
    driver.expectNoDestructiveOrExpansiveDockerCalls();
  });
});

describe('BrokerConfig', () => {
  it('requires operator supplied absolute socket, digest-pinned image, namespace, and enrollment', () => {
    expect(config().image).toBe(IMAGE);
    expect(() => BrokerConfig.parse({ socketPath: 'relative.sock', image: IMAGE, namespace: NAMESPACE, owners: [OWNER] })).toThrow();
    expect(() => BrokerConfig.parse({ socketPath: '/run/docker.sock', image: 'collectiveui/personal-codex:latest', namespace: NAMESPACE, owners: [OWNER] })).toThrow();
    expect(() => BrokerConfig.parse({ socketPath: '/run/docker.sock', image: IMAGE, namespace: '../escape', owners: [OWNER] })).toThrow();
    expect(() => BrokerConfig.parse({ socketPath: '/run/docker.sock', image: IMAGE, namespace: NAMESPACE, owners: [] })).toThrow();
    expect(() => BrokerConfig.parse({ socketPath: '/run/docker.sock', image: IMAGE, namespace: NAMESPACE, owners: [OWNER], extra: true })).toThrow();
  });
});
