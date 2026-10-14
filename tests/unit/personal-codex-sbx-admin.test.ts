import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalCodexBrokerConfig } from '@/personal-codex/docker';
import { tokenFingerprint } from '@/personal-codex/contracts';
import { SbxPersonalCodexDriver } from '@/personal-codex/sbx';

const OWNER = 'member-101';
const OTHER = 'member-202';
const THIRD = 'member-303';
const TEMPLATE_A = `collectiveui/personal-codex@sha256:${'a'.repeat(64)}`;
const TEMPLATE_B = `collectiveui/personal-codex@sha256:${'b'.repeat(64)}`;

// These cases launch many fake CLI processes; allow shared CI hosts time to schedule them.
describe('personal Codex sbx admin adapter', { timeout: 30_000 }, () => {
  const directories: string[] = [];
  afterEach(async () => { await Promise.all(directories.map(path => rm(path, { recursive: true, force: true }))); directories.length = 0; });

  async function fixture(adminEnabled = true, siwcSandboxVerified = false) {
    const directory = await mkdtemp(join(tmpdir(), 'personal-codex-sbx-admin-'));
    directories.push(directory);
    const home = join(directory, 'home');
    await mkdir(home, { mode: 0o700 });
    await chmod(home, 0o700);
    const statePath = join(directory, 'cli-state.json');
    const argsPath = join(directory, 'cli-args.jsonl');
    await writeFile(statePath, JSON.stringify({ sandboxes: [], policies: [], templates: [], calls: [], badLogs: false, badDiagnose: false }), { mode: 0o600 });
    const cli = `#!${process.execPath}
const fs=require('node:fs');
const statePath=${JSON.stringify(statePath)}, argsPath=${JSON.stringify(argsPath)};
const args=process.argv.slice(2), state=()=>JSON.parse(fs.readFileSync(statePath,'utf8'));
const save=s=>fs.writeFileSync(statePath,JSON.stringify(s));
fs.appendFileSync(argsPath,JSON.stringify({args,env:Object.keys(process.env).sort()})+'\\n');
const json=v=>process.stdout.write(JSON.stringify(v));
const digest=ref=>ref.slice(ref.lastIndexOf('@sha256:')+8);
const status=name=>{const s=state().sandboxes.find(x=>x.name===name);return s?.state||null};
if(args[0]==='version'){json({client:{version:'v0.48.0'}});process.exit(0)}
if(args[0]==='settings'&&args[1]==='get'){json({value:args[2]==='ssh.agentForwardingEnabled'?false:''});process.exit(0)}
if(args[0]==='ls'&&args.includes('--format')&&args.includes('json')){json(state().sandboxes.map(s=>({id:s.id,name:s.name,status:s.state})));process.exit(0)}
if(args[0]==='inspect'){const s=state().sandboxes.find(x=>x.name===args.at(-1));if(!s)process.exit(1);json({name:s.name,state:s.state,workspace:'',image_digest:digest(s.template),cpus:s.cpus,memory_mib:s.memoryMb,kits:[],mounts:[],secrets:[],published_ports:[],active_sessions:s.sessions,mcp_gateway:false,shared_skills:'off',auth_mode:'none'});process.exit(0)}
if(args[0]==='create'&&args[1]==='shell'){const s=state(),name=args[args.indexOf('--name')+1],template=args[args.indexOf('--template')+1],cpus=Number(args[args.indexOf('--cpus')+1]),memoryMb=Number(args[args.indexOf('--memory')+1].replace(/m$/,''));if(s.sandboxes.some(x=>x.name===name))process.exit(1);s.sandboxes.push({id:'id-'+name,name,template,cpus,memoryMb,state:'stopped',sessions:0});save(s);process.exit(0)}
if(args[0]==='exec'){const s=state(),name=args[1],sandbox=s.sandboxes.find(x=>x.name===name);if(!sandbox)process.exit(1);sandbox.state='running';save(s);process.exit(0)}
if(args[0]==='stop'){const s=state(),sandbox=s.sandboxes.find(x=>x.name===args.at(-1));if(sandbox)sandbox.state='stopped';save(s);json({ok:true});process.exit(0)}
if(args[0]==='rm'){const s=state();s.sandboxes=s.sandboxes.filter(x=>x.name!==args.at(-1));save(s);json({ok:true});process.exit(0)}
if(args[0]==='template'&&args[1]==='ls'){json(state().templates.map(reference=>({reference})));process.exit(0)}
if(args[0]==='template'&&args[1]==='load'){const s=state();s.templates.push(args[3]);save(s);json({ok:true});process.exit(0)}
if(args[0]==='policy'&&args[1]==='ls'){json({rules:state().policies.filter(p=>p.sandbox===args[2]).map(({id,effect,destination})=>({id,effect,destination,type:'network'}))});process.exit(0)}
if(args[0]==='policy'&&args[1]==='log'){const s=state();json(s.badLogs?{events:[{url:'secret-path'}]}:{events:[{host:'api.example.com:443',allowed:true,timestamp:'2026-10-14T00:00:00.000Z',matching_rule:'sensitive-value',proxy_type:'sensitive-value',request_count:9}]});process.exit(0)}
if(args[0]==='policy'&&(args[1]==='allow'||args[1]==='deny')){const s=state();s.policies.push({id:'123e4567-e89b-42d3-a456-426614174000',effect:args[1],destination:args.at(-1),sandbox:args[args.indexOf('--sandbox')+1]});save(s);process.exit(0)}
if(args[0]==='policy'&&args[1]==='rm'){const s=state();s.policies=s.policies.filter(p=>p.id!==args[args.indexOf('--id')+1]);save(s);process.exit(0)}
if(args[0]==='policy'&&args[1]==='check'){json(args.at(-1)==='unknown.example'?{authorized:true}:{allowed:true});process.exit(0)}
if(args[0]==='daemon'&&args[1]==='status'){json({running:true});process.exit(0)}
if(args[0]==='diagnose'){const s=state();json(s.badDiagnose?{issue:'private host path'}:{checks:[{status:'passed'},{status:'failed'}],host_path:'/private/path',token:'secret-value'});process.exit(0)}
process.exit(2);
`;
    const executable = join(directory, 'sbx');
    await writeFile(executable, cli, { mode: 0o700 });
    await chmod(executable, 0o700);
    const parsed = PersonalCodexBrokerConfig.parse({ backend: 'sbx', socketPath: '/run/test.sock', namespace: 'cui-codex-test',
      owners: [OWNER], template: TEMPLATE_A, sbxHome: home, memoryMb: 4096, cpus: 2, adminEnabled, siwcSandboxVerified });
    if (parsed.backend !== 'sbx') throw new Error('invalid fixture config');
    const driver = new SbxPersonalCodexDriver(parsed);
    (driver.config as { sbxExecutable: string }).sbxExecutable = executable;
    return { driver, statePath, argsPath, home, directory };
  }

  it('keeps admin disabled by default and refuses admin API calls when disabled', async () => {
    const { driver } = await fixture(false);
    expect(driver.config.adminEnabled).toBe(false);
    await expect(driver.adminHealth()).rejects.toThrow(/disabled by the operator/i);
    await expect(driver.adminInventory()).rejects.toThrow(/disabled by the operator/i);
    await expect(driver.adminNetworkRead(OWNER)).rejects.toThrow(/disabled by the operator/i);
  });

  it('persists owner admission and applies changed resources/templates only to new runtimes', async () => {
    const { driver, statePath } = await fixture();
    await expect(driver.ensure(OTHER)).rejects.toThrow(/unavailable/i);
    await driver.ensure(OWNER);
    await driver.adminConfigure({ cpus: 4, memoryMb: 8192, defaultTemplate: TEMPLATE_B,
      knownOwners: [OWNER, OTHER], admittedOwners: [OWNER, OTHER], maxRunning: 2 });
    await driver.ensure(OTHER);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    expect(state.sandboxes.find((row: { name: string }) => row.name === driver.name(OWNER))).toMatchObject({ cpus: 2, memoryMb: 4096, template: TEMPLATE_A });
    expect(state.sandboxes.find((row: { name: string }) => row.name === driver.name(OTHER))).toMatchObject({ cpus: 4, memoryMb: 8192, template: TEMPLATE_B });
    expect(await driver.adminInventory()).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerId: OWNER, state: 'running', cpus: 2, memoryMb: 4096, template: TEMPLATE_A }),
      expect.objectContaining({ ownerId: OTHER, state: 'running', cpus: 4, memoryMb: 8192, template: TEMPLATE_B }),
    ]));
    await driver.adminConfigure({ cpus: 4, memoryMb: 8192, defaultTemplate: TEMPLATE_B,
      knownOwners: [OWNER, OTHER], admittedOwners: [OTHER], maxRunning: 2 });
    await expect(driver.startRetained(OWNER)).rejects.toThrow(/unavailable/i);
    await expect(driver.bridge(OWNER)).rejects.toThrow(/unavailable/i);
    expect(await driver.adminOwnerAccess(OWNER)).toEqual({ known: true, admitted: false });
    expect(await driver.adminOwnerAccess(OTHER)).toEqual({ known: true, admitted: true });
    expect(await driver.adminKnownOwners()).toEqual([OWNER, OTHER]);
    await driver.stop(OWNER); // Revoked owners remain manageable for stopping/deletion.
  });

  it('serializes automatic provisioning and enforces the running-runtime cap', async () => {
    const { driver, statePath } = await fixture();
    await driver.adminConfigure({ cpus: 2, memoryMb: 4096, defaultTemplate: TEMPLATE_A,
      knownOwners: [OWNER, OTHER, THIRD], admittedOwners: [OWNER, OTHER, THIRD], maxRunning: 1 });
    const outcomes = await Promise.allSettled([driver.ensure(OTHER), driver.ensure(THIRD)]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
    const created = JSON.parse(await readFile(statePath, 'utf8')).sandboxes[0];
    expect(JSON.parse(await readFile(statePath, 'utf8')).sandboxes).toHaveLength(1);
    const other = created.name === driver.name(OTHER) ? OTHER : THIRD;
    const notOther = other === OTHER ? THIRD : OTHER;
    await driver.stop(other);
    await driver.ensure(notOther);
    await expect(driver.startRetained(other)).rejects.toThrow(/capacity is full/i);
  });

  it('does not transfer SIWC proof to a new digest, while retaining proof for the original immutable runtime', async () => {
    const { driver, argsPath } = await fixture(true, true);
    await driver.adminConfigure({ cpus: 2, memoryMb: 4096, defaultTemplate: TEMPLATE_A,
      knownOwners: [OWNER, OTHER], admittedOwners: [OWNER, OTHER], maxRunning: 2 });
    await driver.ensure(OWNER);
    expect(await driver.siwcVerified(OWNER)).toBe(true);
    await driver.adminConfigure({ cpus: 2, memoryMb: 4096, defaultTemplate: TEMPLATE_B,
      knownOwners: [OWNER, OTHER], admittedOwners: [OWNER, OTHER], maxRunning: 2 });
    await driver.ensure(OTHER);
    expect(await driver.siwcVerified(OWNER)).toBe(true);
    expect(await driver.siwcVerified(OTHER)).toBe(false);
    const accessToken = 'synthetic-test-token';
    await expect(driver.synchronizeToken(OTHER, accessToken, tokenFingerprint(accessToken))).rejects.toThrow(/this runtime template/i);
    const calls = (await readFile(argsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls.some((call: { args: string[] }) => call.args.includes('--sync-token'))).toBe(false);
  });

  it('supports scoped network rules and removes only the exact app-owned CLI rule id', async () => {
    const { driver, argsPath, statePath } = await fixture();
    await driver.adminConfigure({ cpus: 2, memoryMb: 4096, defaultTemplate: TEMPLATE_A,
      knownOwners: [OWNER], admittedOwners: [OWNER], maxRunning: 1 });
    const added = await driver.adminNetworkAdd(OWNER, 'allow', 'api.example.com:443');
    expect(added.cliRuleId).toBe('123e4567-e89b-42d3-a456-426614174000');
    const network = await driver.adminNetworkRead(OWNER);
    expect(network).toMatchObject({ observed: true, rules: [{ effect: 'allow', destination: 'api.example.com:443' }], eventsObserved: true,
      events: [{ at: '2026-10-14T00:00:00.000Z', destination: 'api.example.com:443', decision: 'allowed' }] });
    expect(JSON.stringify(network)).not.toMatch(/sensitive-value|secret-path/);
    const state = JSON.parse(await readFile(statePath, 'utf8')); state.badLogs = true; await writeFile(statePath, JSON.stringify(state));
    const unrecognized = await driver.adminNetworkRead(OWNER);
    expect(unrecognized).toMatchObject({ eventsObserved: false, events: [] });
    await expect(driver.adminNetworkRemove(OWNER, 'deny', 'api.example.com:443', added.cliRuleId)).rejects.toThrow(/unavailable/i);
    await driver.adminNetworkRemove(OWNER, 'allow', 'api.example.com:443', added.cliRuleId);
    expect(JSON.parse(await readFile(statePath, 'utf8')).policies).toHaveLength(0);
    const calls = (await readFile(argsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(calls.filter((call: { args: string[] }) => call.args[0] === 'policy').every((call: { args: string[] }) =>
      ['ls', 'log'].includes(call.args[1]) ? call.args[2] === driver.name(OWNER)
        : call.args.includes('--sandbox') && call.args.includes(driver.name(OWNER)))).toBe(true);
    await expect(driver.adminNetworkRemove(OWNER, 'allow', 'api.example.com:443', added.cliRuleId)).rejects.toThrow(/unavailable/i);
  });

  it('limits template imports to private inbox files and reports only validated availability', async () => {
    const { driver, home } = await fixture();
    await mkdir(join(home, 'template-imports'), { mode: 0o700 });
    await chmod(join(home, 'template-imports'), 0o700);
    await writeFile(join(home, 'template-imports', 'trusted.tar'), 'archive', { mode: 0o600 });
    await symlink('/etc/passwd', join(home, 'template-imports', 'linked.tar'));
    expect(await driver.adminArchives()).toEqual([{ name: 'trusted.tar', sizeBytes: 7 }]);
    await driver.adminImportTemplate('trusted.tar', TEMPLATE_B);
    expect(await driver.adminTemplates([TEMPLATE_B])).toEqual([{ reference: TEMPLATE_B, available: true }]);
    await expect(driver.adminImportTemplate('linked.tar', TEMPLATE_B)).rejects.toThrow(/unavailable/i);
    await expect(driver.adminImportTemplate('../trusted.tar', TEMPLATE_B)).rejects.toThrow();
  });

  it('returns bounded health/diagnostics and preserves unknown network-check results', async () => {
    const { driver, statePath } = await fixture();
    const health = await driver.adminHealth();
    expect(health.version).toBe('v0.48.0');
    expect(health.checks.find(check => check.id === 'agent-forwarding')?.state).toBe('passed');
    expect(health.checks.find(check => check.id === 'sbx-daemon')?.state).toBe('passed');
    expect(health.checks.some(check => check.id === 'kvm-device')).toBe(true);
    const diagnostic = await driver.adminDiagnose();
    expect(diagnostic.find(check => check.id === 'sbx-diagnose')?.state).toBe('failed');
    expect(JSON.stringify(diagnostic)).not.toMatch(/private\/path|secret-value/);
    const fixtureState = JSON.parse(await readFile(statePath, 'utf8'));
    fixtureState.badDiagnose = true;
    await writeFile(statePath, JSON.stringify(fixtureState));
    expect((await driver.adminDiagnose()).find(check => check.id === 'sbx-diagnose')?.state).toBe('unknown');
    await driver.adminConfigure({ cpus: 2, memoryMb: 4096, defaultTemplate: TEMPLATE_A, knownOwners: [OWNER], admittedOwners: [OWNER], maxRunning: 1 });
    expect(await driver.adminNetworkCheck(OWNER, 'api.example.com')).toEqual({ decision: 'allowed', detail: 'Evaluated by the sandbox policy service.' });
    expect(await driver.adminNetworkCheck(OWNER, 'unknown.example')).toEqual({ decision: 'unknown', detail: 'The CLI policy response schema is not recognized.' });
  });
});
