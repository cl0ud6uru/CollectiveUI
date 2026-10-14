import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrokerConfig, PersonalCodexBrokerConfig } from '@/personal-codex/docker';
import { SbxPersonalCodexDriver } from '@/personal-codex/sbx';

const OWNER = 'member-101';
const config = (sbxHome = '/tmp/sbx-fixture-home') => PersonalCodexBrokerConfig.parse({
  backend: 'sbx', socketPath: '/run/personal-codex-test.sock', namespace: 'cui-codex-test', owners: [OWNER],
  template: `collectiveui/personal-codex@sha256:${'a'.repeat(64)}`, sbxHome, memoryMb: 4096, cpus: 2,
});

describe('personal Codex sbx adapter', () => {
  let directory: string | undefined;
  afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; });

  async function fixture(version = 'v0.48.0') {
    directory = await mkdtemp(join(tmpdir(), 'personal-codex-sbx-'));
    const home = join(directory, 'home');
    await mkdir(home, { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
    const statePath = join(directory, 'state.json');
    const argsPath = join(directory, 'args.jsonl');
    await writeFile(statePath, JSON.stringify({ rows: [], received: [] }), { mode: 0o600 });
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
  if (script.endsWith('control.py pause') || script.endsWith('control.py resume')) { process.exit(0); }
  if (script.endsWith('bridge.mjs')) { process.stdin.resume(); return; }
  process.exit(0);
}
process.exit(2);
`;
    const executable = join(directory, 'sbx');
    await writeFile(executable, script, { mode: 0o700 });
    await chmod(executable, 0o700);
    const parsed = config(home);
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
    await driver.computerInput(OWNER, { kind: 'type', text: 'hello' });
    await expect(driver.computerInput(OWNER, { kind: 'click', x: 1280, y: 0 } as never)).rejects.toThrow();
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    expect(state.received).toEqual([{ success: true, data: { kind: 'type', text: 'hello' } }]);
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
