import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { BrokerConfig, PersonalCodexBrokerConfig } from '@/personal-codex/docker';
import { tokenFingerprint } from '@/personal-codex/contracts';
import { SbxPersonalCodexDriver } from '@/personal-codex/sbx';

const OWNER = 'member-101';
const config = (sbxHome = '/tmp/sbx-fixture-home', siwcSandboxVerified = false) => PersonalCodexBrokerConfig.parse({
  backend: 'sbx', socketPath: '/run/personal-codex-test.sock', namespace: 'cui-codex-test', owners: [OWNER],
  template: `collectiveui/personal-codex@sha256:${'a'.repeat(64)}`, sbxHome, memoryMb: 4096, cpus: 2, siwcSandboxVerified,
});

// These cases launch many fake CLI processes; allow shared CI hosts time to schedule them.
describe('personal Codex sbx adapter', { timeout: 30_000 }, () => {
  let directory: string | undefined;
  const directories: string[] = [];
  afterEach(async () => { await Promise.all(directories.map(path => rm(path, { recursive: true, force: true }))); directories.length = 0; directory = undefined; });

  async function fixture(version = 'v0.48.0', siwcSandboxVerified = false) {
    directory = await mkdtemp(join(tmpdir(), 'personal-codex-sbx-'));
    directories.push(directory);
    const home = join(directory, 'home');
    await mkdir(home, { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
    const statePath = join(directory, 'state.json');
    const argsPath = join(directory, 'args.jsonl');
    await writeFile(statePath, JSON.stringify({ rows: [], received: [], synchronized: [], clears: 0 }), { mode: 0o600 });
    const script = `#!${process.execPath}
const fs = require('node:fs');
const statePath = ${JSON.stringify(statePath)};
const argsPath = ${JSON.stringify(argsPath)};
const args = process.argv.slice(2);
fs.appendFileSync(argsPath, JSON.stringify({args, env:Object.keys(process.env).sort()}) + '\\n');
const read = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const write = state => fs.writeFileSync(statePath, JSON.stringify(state));
if (args[0] === 'version') { process.stdout.write(JSON.stringify({client:{version:${JSON.stringify(version)}},server:{state:'running'}})); process.exit(0); }
if (args[0] === 'settings' && args[1] === 'get') { process.stdout.write(JSON.stringify({value:args[2]==='ssh.agentForwardingEnabled' ? false : ''})); process.exit(0); }
if (args[0] === 'ls') { process.stdout.write(JSON.stringify(read().rows)); process.exit(0); }
if (args[0] === 'create') { const s=read(); const name=args[args.indexOf('--name')+1]; s.rows.push({id:'sandbox-immutable-1',name,status:'running',agent:'shell',detached:true,cpus:2,memory_mib:4096}); write(s); process.exit(0); }
if (args[0] === 'inspect') { const s=read(); const row=s.rows.find(r=>r.name===args.at(-1)); if(!row) process.exit(1); process.stdout.write(JSON.stringify({name:row.name,state:row.status,workspace:'',image_digest:${JSON.stringify('a'.repeat(64))},cpus:row.cpus,memory_mib:row.memory_mib,kits:[],mounts:[],secrets:[],ports:[],sessions:row.sessions??0,mcp_gateway:false})); process.exit(0); }
if (args[0] === 'stop') { const s=read(); const row=s.rows.find(r=>r.name===args.at(-1)); if(row) row.status='stopped'; write(s); process.exit(0); }
if (args[0] === 'rm') { const s=read(); s.rows=s.rows.filter(r=>r.name!==args.at(-1)); write(s); process.exit(0); }
if (args[0] === 'exec') {
  const name=args[args.indexOf('--interactive')===1 ? 2 : 1];
  const script=args.slice(args.indexOf(name)+1).join(' ');
  const s=read(); const row=s.rows.find(r=>r.name===name); if(row) row.status='running'; write(s);
  if (script.endsWith('control.py screenshot')) { process.stdout.write(Buffer.from([0xff,0xd8,0x01,0x02,0xff,0xd9])); process.exit(0); }
  if (script.endsWith('control.py input')) { let data=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',c=>data+=c); process.stdin.on('end',()=>{ const n=read(); n.received.push(JSON.parse(data)); write(n); process.exit(0); }); return; }
  if (script.endsWith('server.mjs --sync-token')) { let data=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',c=>data+=c); process.stdin.on('end',()=>{ const n=read(); n.synchronized.push(JSON.parse(data)); write(n); process.exit(0); }); return; }
  if (script.endsWith('server.mjs --clear-token')) { const n=read(); n.clears++; write(n); process.exit(0); }
  if (script.endsWith('control.py pause') || script.endsWith('control.py resume')) { process.exit(0); }
  if (script.endsWith('bridge.mjs')) { process.stdin.resume(); return; }
  process.exit(0);
}
process.exit(2);
`;
    const executable = join(directory, 'sbx');
    await writeFile(executable, script, { mode: 0o700 });
    await chmod(executable, 0o700);
    const parsed = config(home, siwcSandboxVerified);
    if (parsed.backend !== 'sbx') throw new Error('invalid fixture config');
    const driver = new SbxPersonalCodexDriver(parsed);
    (driver.config as { sbxExecutable: string }).sbxExecutable = executable;
    return { driver, statePath, argsPath, home };
  }

  it('pins and verifies the CLI version, creates only the scoped no-workspace sandbox, and enforces resource limits', async () => {
    const { driver, argsPath } = await fixture();
    await driver.ensure(OWNER);
    const calls = (await readFile(argsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls[0].args).toEqual(['version', '--format', 'json']);
    const create = calls.find((row: { args: string[] }) => row.args[0] === 'create').args as string[];
    expect(create).toContain('shell');
    expect(create).toContain(driver.name(OWNER));
    expect(create).toContain('--cpus'); expect(create).toContain('2');
    expect(create).toContain('--memory'); expect(create).toContain('4096m');
    expect(create).toContain('--pull'); expect(create).toContain('never');
    expect(create).toContain('--skills'); expect(create).toContain('off');
    expect(create).not.toContain('--kit'); expect(create).not.toContain('--env');
    expect(create).not.toContain('/workspace');
    expect((await driver.inspect(OWNER))?.State.Running).toBe(true);
    expect(() => driver.name('unapproved-owner')).toThrow(/unavailable/i);
  });

  it('fails closed on a different sbx CLI version before listing or creating', async () => {
    const { driver, argsPath } = await fixture('v0.47.9');
    await expect(driver.ensure(OWNER)).rejects.toThrow(/unavailable/i);
    const calls = (await readFile(argsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls.map((row: { args: string[] }) => row.args[0])).toEqual(['version']);
  });

  it('keeps SIWC disabled by default and synchronizes a verified token only through stdin', async () => {
    const disabled = await fixture();
    expect(disabled.driver.config.siwcSandboxVerified).toBe(false);
    expect(disabled.driver.config.adminEnabled).toBe(false);
    expect(PersonalCodexBrokerConfig.safeParse({ ...disabled.driver.config, allowSelfEnrollment: true }).success).toBe(false);
    await disabled.driver.ensure(OWNER);
    await expect(disabled.driver.synchronizeToken(OWNER, 'test-access-token', tokenFingerprint('test-access-token')))
      .rejects.toThrow(/unavailable until.*proof/i);
    let calls = (await readFile(disabled.argsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls.some((row: { args: string[] }) => row.args.includes('--sync-token'))).toBe(false);

    const enabled = await fixture('v0.48.0', true);
    await enabled.driver.ensure(OWNER);
    const accessToken = 'test-access-token-value';
    const binding = tokenFingerprint(accessToken);
    await enabled.driver.synchronizeToken(OWNER, accessToken, binding);
    await expect(enabled.driver.synchronizeToken(OWNER, accessToken, '0'.repeat(64))).rejects.toThrow(/unavailable/i);
    const state = JSON.parse(await readFile(enabled.statePath, 'utf8'));
    expect(state.synchronized).toEqual([{ accessToken, credentialBinding: binding }]);
    calls = (await readFile(enabled.argsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const syncCall = calls.find((row: { args: string[] }) => row.args.includes('--sync-token'));
    expect(syncCall.args).toContain('--interactive');
    expect(syncCall.args).not.toContain(accessToken);
    expect(syncCall.env).not.toContain('ACCESS_TOKEN');
    expect(JSON.stringify(syncCall)).not.toContain(accessToken);
  });

  it('refuses token sync if pause begins during async inspect or protected-cwd validation', async () => {
    const afterInspect = await fixture('v0.48.0', true);
    await afterInspect.driver.ensure(OWNER);
    const paused = afterInspect.driver as unknown as { paused: Set<string>; protectedCwd: () => Promise<string> };
    const originalInspect = afterInspect.driver.inspect.bind(afterInspect.driver);
    const originalCwd = paused.protectedCwd.bind(afterInspect.driver);
    let armCwdFence = false;
    afterInspect.driver.inspect = async owner => {
      const result = await originalInspect(owner);
      armCwdFence = true;
      return result;
    };
    paused.protectedCwd = async () => {
      const cwd = await originalCwd();
      if (armCwdFence) paused.paused.add(afterInspect.driver.name(OWNER));
      return cwd;
    };
    await expect(afterInspect.driver.synchronizeToken(OWNER, 'test-access-token', tokenFingerprint('test-access-token')))
      .rejects.toThrow(/unavailable/i);
    const calls = (await readFile(afterInspect.argsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls.some((row: { args: string[] }) => row.args.includes('--sync-token'))).toBe(false);
  });

  it('clears a live token through stdin, but stops a paused VM and does not restart it', async () => {
    const live = await fixture('v0.48.0', true);
    await live.driver.ensure(OWNER);
    await live.driver.clearToken(OWNER);
    let state = JSON.parse(await readFile(live.statePath, 'utf8'));
    expect(state.clears).toBe(1);
    let calls = (await readFile(live.argsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const clearCall = calls.find((row: { args: string[] }) => row.args.includes('--clear-token'));
    expect(clearCall.args).toContain('--interactive');

    const stopped = await fixture('v0.48.0', true);
    await stopped.driver.ensure(OWNER);
    await stopped.driver.stop(OWNER);
    await stopped.driver.clearToken(OWNER);
    const stoppedState = JSON.parse(await readFile(stopped.statePath, 'utf8'));
    expect(stoppedState.rows[0].status).toBe('stopped');
    const stoppedCalls = (await readFile(stopped.argsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(stoppedCalls.some((row: { args: string[] }) => row.args.includes('--clear-token'))).toBe(false);

    const paused = await fixture('v0.48.0', true);
    await paused.driver.ensure(OWNER);
    await paused.driver.computerPause(OWNER, true);
    await paused.driver.clearToken(OWNER);
    state = JSON.parse(await readFile(paused.statePath, 'utf8'));
    expect(state.rows[0].status).toBe('stopped');
    calls = (await readFile(paused.argsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls.some((row: { args: string[] }) => row.args.includes('--clear-token'))).toBe(false);
    expect(calls.some((row: { args: string[] }) => row.args[0] === 'exec' && row.args.at(-1) === '/bin/true')).toBe(false);
  });

  it('refuses to adopt a preexisting sandbox even when its name matches the owner mapping', async () => {
    const { driver, statePath, argsPath } = await fixture();
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    state.rows.push({ id: 'foreign-id', name: driver.name(OWNER), status: 'running', cpus: 2, memory_mib: 4096 });
    await writeFile(statePath, JSON.stringify(state));
    await expect(driver.ensure(OWNER)).rejects.toThrow(/unavailable/i);
    const calls = (await readFile(argsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls.some((row: { args: string[] }) => row.args[0] === 'create')).toBe(false);
  });

  it('rejects a planted sbx project config or symlink in its protected working directory before invoking sbx', async () => {
    const first = await fixture();
    const cwd = join(first.home, 'collectiveui-empty-cwd');
    await mkdir(cwd, { mode: 0o700 });
    await writeFile(join(cwd, 'sbx.yaml'), 'hooks: []\n', { mode: 0o600 });
    await expect(first.driver.ensure(OWNER)).rejects.toThrow(/unavailable/i);
    await expect(readFile(first.argsPath, 'utf8')).rejects.toThrow();

    await rm(directory!, { recursive: true, force: true });
    directory = undefined;
    const second = await fixture();
    const target = join(directory!, 'planted-directory');
    await mkdir(target, { mode: 0o700 });
    await symlink(target, join(second.home, 'collectiveui-empty-cwd'));
    await expect(second.driver.ensure(OWNER)).rejects.toThrow(/unavailable/i);
    await expect(readFile(second.argsPath, 'utf8')).rejects.toThrow();
  });

  it('allows routine runtime inspection while the owned app-server exec session is active', async () => {
    const { driver, statePath } = await fixture();
    await driver.ensure(OWNER);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    state.rows[0].sessions = 1;
    await writeFile(statePath, JSON.stringify(state));
    expect((await driver.inspect(OWNER))?.State.Running).toBe(true);
    expect(await driver.computerStatus(OWNER)).toEqual({ available: true, running: true, width: 1280, height: 800 });
  });

  it('uses non-TTY interactive exec for app-server and sends bounded computer input through stdin', async () => {
    const { driver, argsPath, statePath } = await fixture();
    await driver.ensure(OWNER);
    const bridge = await driver.bridge(OWNER);
    expect(bridge.stdin.writable).toBe(true);
    bridge.stdin.end();
    await new Promise<void>(resolve => bridge.once('close', () => resolve()));
    expect(await driver.computerFrame(OWNER)).toEqual(Buffer.from([0xff,0xd8,0x01,0x02,0xff,0xd9]));
    const inputs = [
      { kind: 'type' as const, text: 'hello' },
      { kind: 'click' as const, x: 12, y: 31, button: 'left' as const },
      { kind: 'key' as const, key: 'Enter' as const },
      { kind: 'scroll' as const, direction: 'down' as const, amount: 2 },
    ];
    for (const input of inputs) await driver.computerInput(OWNER, input);
    await expect(driver.computerInput(OWNER, { kind: 'click', x: 1280, y: 0 } as never)).rejects.toThrow();
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    expect(state.received).toEqual(inputs);
    // Consume the exact bytes sent through the fake CLI with the production Python
    // parser and command validator. Validate commands without invoking the desktop.
    for (const input of state.received) {
      const output = execFileSync('python3', ['-c', [
        'import importlib.util, json, sys',
        'spec = importlib.util.spec_from_file_location("computer_control", sys.argv[1])',
        'control = importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(control)',
        'command, data = control.command_for(control.read_action())',
        'print(json.dumps({"command": command, "text": data.decode("utf-8") if data is not None else None}))',
      ].join('\n'), join(process.cwd(), 'docker/computer/control.py')], {
        input: JSON.stringify(input), encoding: 'utf8', timeout: 5000,
        env: { PATH: process.env.PATH, LANG: 'C.UTF-8', NODE_ENV: 'test', PYTHONDONTWRITEBYTECODE: '1' },
      });
      const result = JSON.parse(output);
      expect(result.command[0]).toBe('/usr/bin/xdotool');
      expect(result.text).toBe(input.kind === 'type' ? input.text : null);
    }
    const calls = (await readFile(argsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const bridgeCall = calls.find((row: { args: string[] }) => row.args.includes('/opt/collective-codex/bridge.mjs')).args as string[];
    expect(bridgeCall).toContain('--interactive');
    expect(bridgeCall).not.toContain('--tty'); expect(bridgeCall).not.toContain('-t');
    const inputCall = calls.find((row: { args: string[] }) => row.args.some(arg => arg.endsWith('control.py')) && row.args.at(-1) === 'input');
    expect(inputCall.args).not.toContain('hello');
    expect(inputCall.env).not.toContain('OPENAI_API_KEY');
  });

  it('stops retained state and explicitly removes only the mapped sandbox', async () => {
    const { driver } = await fixture();
    await driver.ensure(OWNER);
    await driver.stop(OWNER);
    expect((await driver.inspect(OWNER))?.State.Running).toBe(false);
    await driver.startRetained(OWNER);
    expect((await driver.inspect(OWNER))?.State.Running).toBe(true);
    await driver.cleanup(OWNER);
    expect(await driver.inspect(OWNER)).toBeNull();
  });
});

describe('sbx broker configuration', () => {
  it('keeps Docker as the legacy default and requires digest, bounded resources and exact CLI version for sbx', () => {
    const docker = BrokerConfig.parse({ socketPath: '/run/personal.sock', image: `collectiveui/personal-codex@sha256:${'a'.repeat(64)}`, namespace: 'cui-codex-test', owners: [OWNER] });
    expect(docker.backend).toBe('docker');
    const sbx = config();
    expect(sbx.backend).toBe('sbx');
    for (const invalid of [
      { ...sbx, template: 'collectiveui/personal-codex:latest' },
      { ...sbx, cpus: 0 },
      { ...sbx, memoryMb: 256 },
      { ...sbx, sbxVersion: '0.49.0' },
      { ...sbx, automaticHooks: true },
    ]) expect(() => BrokerConfig.parse(invalid)).toThrow();
  });
});
