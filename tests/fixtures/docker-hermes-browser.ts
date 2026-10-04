/** Disposable browser harness: synthetic Python RPC and resources; never invokes Docker or paid providers. */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { NativeResources } from '../../src/docker-hermes/types';
import type { ProfileSettings, ProfileUpdate } from '../../src/docker-hermes/settings';
import { createHash } from 'node:crypto';
import { DockerBroker } from '../../src/docker-hermes/broker';
import { BrokerConfig, type RuntimeDriver, type Profile } from '../../src/docker-hermes/docker';
import { stopOwnedGroup } from '../../src/local-hermes/process-group';
import { listenBroker } from '../../src/docker-hermes/main';
import { createLocalUser } from '../../src/lib/auth/local';
import { pool } from '../../src/db';
class FixtureDriver implements RuntimeDriver {
  saved = new Map<string, ProfileSettings>();
  active = new Set<string>(); profilesByOwner = new Map<string, Profile[]>(); children = new Map<string, Set<ChildProcessWithoutNullStreams>>();
  ensureCount = 0; createCount = 0; stopFailure = false; gate?: Promise<void>;
  constructor(readonly root: string) {}
  async ensure(owner: string, stage: Parameters<RuntimeDriver['ensure']>[1]) {
    this.ensureCount++; stage('checking_image'); await this.gate; stage('creating_storage');
    this.profilesByOwner.set(owner, this.profilesByOwner.get(owner) ?? [{ name: 'default', identity: `native-${owner}` }]);
    stage('starting_container'); this.active.add(owner); stage('checking_native');
  }
  async running(owner: string) { return this.active.has(owner); }
  async stop(owner: string) {
    if (this.stopFailure) throw new Error('Unconfirmed cleanup');
    this.active.delete(owner);
    const children = this.children.get(owner); this.children.delete(owner);
    if (children) await Promise.all([...children].map(async child => { if (child.pid) await stopOwnedGroup(child.pid); }));
  }
  async profiles(owner: string) { return this.profilesByOwner.get(owner) ?? []; }
  async create(owner: string, name: string) {
    this.createCount++;
    const rows = this.profilesByOwner.get(owner)!;
    let p = rows.find(p => p.name === name);
    if (!p) { p = { name, identity: `native-${name}` }; rows.push(p); }
    return p;
  }
  async resources(owner: string, name: string, identity: string): Promise<NativeResources> {
    if (!(await this.profiles(owner)).some(p => p.name === name && p.identity === identity)) throw new Error('Changed identity');
    return { skills: [{ id: 'test', name: owner, content: name }], memories: [] };
  }
  async reopen(owner: string) { this.active.add(owner); }
  async settings(owner: string, name: string, identity: string, update?: ProfileUpdate) {
    if (!(await this.profiles(owner)).some(p => p.name === name && p.identity === identity)) throw new Error('Changed identity');
    const key = `${owner}:${name}`;
    const saved = this.saved.get(key) ?? { revision: 'a'.repeat(64), provider: null, model: '', reasoningEffort: '', maxTurns: null, advancedSupported: true, editableProviders: { 'openai-api': true, anthropic: true, openrouter: true }, credentials: { 'openai-api': false, anthropic: false, openrouter: false } };
    if (!update) return saved;
    if (update.revision !== saved.revision) throw new Error('Stale fixture update');
    const next: ProfileSettings = { ...saved, provider: update.provider, model: update.model, reasoningEffort: update.reasoningEffort, maxTurns: update.maxTurns,
      revision: createHash('sha256').update(saved.revision + JSON.stringify({ provider: update.provider, model: update.model, action: update.credential.action })).digest('hex'),
      credentials: { ...saved.credentials, [update.provider]: update.credential.action === 'keep' ? saved.credentials[update.provider] : update.credential.action === 'replace' } };
    this.saved.set(key, next); return next;
  }
  async testSettings(owner: string, name: string, identity: string) {
    const s = await this.settings(owner, name, identity);
    return { code: !s.provider || !s.credentials[s.provider] ? 'not_configured' as const : s.model === 'denied-model' ? 'authentication_failed' as const : 'verified' as const };
  }
  transport(owner: string, profile: string) {
    return { spawn: () => {
      const child = spawn('/usr/bin/python3', ['-u', '-m', 'tui_gateway.entry'], { cwd: path.resolve('tests/fixtures/hermes-native'), detached: true,
        env: { NODE_ENV: 'test', PATH: '/usr/bin:/bin', HERMES_HOME: path.join(this.root, owner, profile) }, stdio: ['pipe', 'pipe', 'pipe'] });
      const children = this.children.get(owner) ?? new Set(); children.add(child); this.children.set(owner, children); return child;
    }, stop: () => this.stop(owner) };
  }
}

async function main() {
  if (process.env.DOCKER_HERMES_BROWSER !== '1' || new URL(process.env.DATABASE_URL!).pathname !== '/collective_docker_hermes_test') throw new Error('Named disposable browser fixture required');
  const password = 'Synthetic-Docker-Hermes!42';
  let alice = (await pool.query("SELECT id FROM users WHERE upn='local:docker-hermes-alice'")).rows[0];
  if (!alice) { process.env.LOCAL_AUTH_OPERATOR = 'bootstrap'; alice = await createLocalUser({ username:'docker-hermes-alice', name:'Docker Alice', password, isAdmin:true }, 'bootstrap'); }
  let bob = (await pool.query("SELECT id FROM users WHERE upn='local:docker-hermes-bob'")).rows[0];
  if (!bob) bob = await createLocalUser({ username:'docker-hermes-bob', name:'Docker Bob', password, isAdmin:true }, { id:alice.id, sessionVersion:0 });
  let charlie = (await pool.query("SELECT id FROM users WHERE upn='local:docker-hermes-charlie'")).rows[0];
  if (!charlie) charlie = await createLocalUser({ username:'docker-hermes-charlie', name:'Docker Charlie', password, isAdmin:false }, { id:alice.id, sessionVersion:0 });
  await pool.query('UPDATE local_credentials SET must_change_password=false,temporary_expires_at=null WHERE user_id = ANY($1)', [[alice.id,bob.id,charlie.id]]);
  const root = await mkdtemp(path.join(tmpdir(),'dh-browser-'));
  for (const owner of [alice.id,bob.id]) await mkdir(path.join(root,owner,'default'),{ recursive:true,mode:0o700 });
  for (const dir of ['state','ipc']) await mkdir(path.join(root,dir),{mode:0o700});
  const config=BrokerConfig.parse({ stateDir:path.join(root,'state'),socketPath:path.join(root,'ipc/b.sock'),bridgePath:path.resolve('src/docker-hermes/bridge.py'),namespace:'cui-browser',image:`nousresearch/hermes-agent@sha256:${'a'.repeat(64)}`, network: process.env.DOCKER_HERMES_BROWSER_ONLINE === '1' ? 'proxy' : 'none' });
  const driver=new FixtureDriver(root);
  const create=driver.create.bind(driver);driver.create=async(owner,name)=>{await mkdir(path.join(root,owner,name),{recursive:true});return create(owner,name);};
  driver.resources=async()=>({skills:[{id:'native-skill',name:'Native example skill',content:'Safe native skill content'}],memories:[{id:'MEMORY.md',content:'Native remembered fact'}]});
  const broker=new DockerBroker(config,driver);const server=await listenBroker(broker);
  await writeFile('/tmp/docker-hermes-browser.env',`DOCKER_HERMES_SOCKET=${config.socketPath}\n`,{mode:0o600});
  console.log('Disposable browser broker ready');
  const close=()=>void server.close().finally(()=>pool.end()).then(()=>process.exit(0));process.on('SIGTERM',close);process.on('SIGINT',close);
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
