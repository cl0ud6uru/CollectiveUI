import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:https';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, chmod } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { Principal } from '@/lib/auth/groups';
const fixture = vi.hoisted(() => ({ enabled: process.env.DOCKER_HERMES_TEAM_ACTIVE_IMAGE_TEST === '1', client: null as PGlite | null, queued: [] as string[] }));
vi.mock('server-only', () => ({}));
// Only the queue transport is synthetic. Durable claims, child assignment and terminal hooks run normally.
vi.mock('@/lib/jobs', () => ({ enqueueRun: async (run: { id: string }) => { fixture.queued.push(run.id); } }));
vi.mock('@/db', async () => {
  const schema = await import('@/db/schema');
  if (!fixture.enabled) return { db: {}, schema };
  const { PGlite } = await import('@electric-sql/pglite'), { drizzle } = await import('drizzle-orm/pglite');
  fixture.client = new PGlite(); return { db: drizzle(fixture.client, { schema }), schema };
});
import { db, schema } from '@/db';
import { loadPrincipal } from '@/lib/auth/groups';
import { configureTeam, reserveTeamProfile } from '@/lib/hermes-team/store';
import { openTeamConversation } from '@/lib/hermes-team/conversations';
import { startTeamCandidateRun, settleTeamCandidateRun, retireStoredTeamCandidateRun } from '@/lib/hermes-team/candidate-startup';
import { nativeLearningHandoffHttp } from '@/lib/hermes-team/candidate-learning';
import { candidateModelHttp, candidateMcpHttp } from '@/lib/hermes-team/candidate-http';
import { candidateWireMetadata } from '@/lib/hermes-team/candidate-wire-metadata';
import { TEAM_MODEL_PURPOSES, VERIFIED_TEAM_MODEL_ROUTES, type VerifiedTeamModelRoute } from '@/lib/hermes-team/model-policy';
import { VERIFIED_TEAM_TOOL_ADAPTERS } from '@/lib/hermes-team/tool-policy';
import { sealAppSecret } from '@/lib/llm/secrets';
import { claimRun } from '@/lib/runs/state';
import { executeTeamLearningSegment } from '@/lib/runs/team-candidate';
import { startRun, runEvents, getRun, stopRun } from '@/lib/llm/providers/hermes/client';
import { BrokerConfig, DockerDriver, runtimeKey } from '@/docker-hermes/docker';
import { DockerBroker } from '@/docker-hermes/broker';
import { listenBroker } from '@/docker-hermes/main';
import type { TeamCandidateConfig } from '@/docker-hermes/types';
import { HERMES_COMMIT } from '@/local-hermes/config';
import nativeContract from '@/local-hermes/team-candidate-contract.json';
import { redactSecrets } from '@/lib/redact';

const PIN = 'nousresearch/hermes-agent@sha256:2fd023efbb8d3d2b0ce1a73d028b07370cff34f567cfe0e999553e8c327ea283';
const exec = promisify(execFile);
const ENV = { NODE_ENV: 'production' as const, PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent', LANG: 'C.UTF-8' };
const docker = async (args: string[], timeout = 45000) => (await exec('/usr/local/bin/docker', args, { env: ENV, timeout, maxBuffer: 4 * 1024 * 1024 })).stdout;
const SKILL = '---\nname: procedure\ndescription: A synthetic useful Team procedure.\n---\n\nValidate the input, record the decision, then report the result.\n';
const LEARNED = SKILL.replace('name: procedure', 'name: learned-procedure');
const IMPROVED = LEARNED.replace('record the decision', 'record the reviewed decision');
const route: VerifiedTeamModelRoute = { id: 'app:provider', adapterId: 'collective-openai-chat-v1', model: 'synthetic-model', billing: 'admin',
  integration: 'admin_inference_gateway', credentialHandling: 'server_gateway', evidence: { id: 'hosted-official-image-fixture-only', hermesRevision: HERMES_COMMIT,
    adapterId: 'collective-openai-chat-v1', model: 'synthetic-model', integration: 'admin_inference_gateway', purposes: TEAM_MODEL_PURPOSES, verifiedAt: 1, expiresAt: 4102444800000 } };

/** Observe issued configuration only. Production Docker commands, framing, bootstrap and native gateway stay unchanged. */
class ObservedDriver extends DockerDriver {
  candidates: TeamCandidateConfig[] = [];
  stderr = ''; nativeErrors: string[] = [];
  safe(text: string) {
    for (const value of ['synthetic-never-live-provider-key', 'synthetic-hosted-image-fixture-only', ...this.candidates.flatMap(candidate =>
      [...Object.values(candidate.modelTokens), candidate.toolToken, ...(candidate.learningToken ? [candidate.learningToken] : [])])])
      text = text.replaceAll(value, '[redacted]');
    // Hex grants and content hashes have the same shape; diagnostics may omit both rather than leak split grant fragments.
    return redactSecrets(text).replace(/\b[a-f0-9]{32,}\b/gi, '[redacted-hex]').slice(-16000);
  }
  override candidateTransport(owner: string, profile: string, identity: string, config: TeamCandidateConfig) {
    this.candidates.push(config); const transport = super.candidateTransport(owner, profile, identity, config);
    return { ...transport, spawn: () => {
      const child = transport.spawn(); let lines = '';
      child.stderr.on('data', part => { this.stderr = this.safe(this.stderr + String(part)); });
      child.stdout.on('data', part => {
        lines = (lines + String(part)).slice(-32000);
        for (;;) {
          const end = lines.indexOf('\n'); if (end < 0) break;
          const line = lines.slice(0, end); lines = lines.slice(end + 1);
          try { const frame = JSON.parse(line); if (frame.error) {
            this.nativeErrors.push(this.safe(JSON.stringify({ code: frame.error.code, message: frame.error.message })).slice(0, 2048));
            if (this.nativeErrors.length > 8) this.nativeErrors.shift();
          } } catch { /* NativeRpc still validates the original frames; this listener observes only bounded errors. */ }
        }
      });
      return child;
    } };
  }
}
function completion(calls: Array<{ name: string; arguments: unknown }> = [], content = 'Learned the useful procedure.') {
  const toolCalls = calls.map((call, index) => ({ index, id: `image-tool-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
  const chunk = (delta: unknown, finish_reason: string | null, usage?: unknown) => ({ id: 'synthetic-image', object: 'chat.completion.chunk', created: 1,
    model: route.model, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) });
  return new Response(`data: ${JSON.stringify(chunk({ role: 'assistant', ...(calls.length ? { tool_calls: toolCalls } : { content }) }, null))}\n\n` +
    `data: ${JSON.stringify(chunk({}, calls.length ? 'tool_calls' : 'stop', { prompt_tokens: 7, completion_tokens: 3 }))}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
}
async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, timeout = 30000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read(); if (done(value)) return value;
    if (Date.now() >= deadline) throw new Error('Bounded synthetic official-image operation timed out.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
/** Writes only the container's certifi bundle, not host trust or native source. Public CA bytes use stdin. */
const TRUST_CA = `import certifi,hashlib,json,pathlib,sys
p=pathlib.Path(certifi.where()).resolve()
if not str(p).startswith('/opt/hermes/.venv/') or p.name!='cacert.pem': raise RuntimeError('Unexpected image TLS trust bundle')
before=p.read_bytes(); ca=sys.stdin.buffer.read(8193)
if len(ca)>8192 or not ca.startswith(b'-----BEGIN CERTIFICATE-----') or b'PRIVATE KEY' in ca: raise RuntimeError('Expected bounded public fixture CA')
p.write_bytes(before+b'\\n'+ca)
print(json.dumps({'before':hashlib.sha256(before).hexdigest(),'after':hashlib.sha256(p.read_bytes()).hexdigest()}))`;
const NUDGE = `import json,pathlib,re,sys
name,identity=sys.argv[1:]
if not re.fullmatch(r'cui-team-[a-f0-9]{32}',name): raise RuntimeError('Invalid derived Team profile')
p=pathlib.Path('/opt/data/profiles')/name; s=p.lstat()
if p.is_symlink() or identity!=str(s.st_dev)+':'+str(s.st_ino): raise RuntimeError('Retained identity changed')
(p/'config.yaml').write_text(json.dumps({'skills':{'creation_nudge_interval':1},'memory':{'nudge_interval':1}}))
print('{}')`;
const TLS_PROBE = `import httpx,json,sys
try:
 with httpx.Client(trust_env=False,follow_redirects=False,timeout=3) as client: response=client.get(sys.argv[1])
 print(json.dumps({'trusted':True,'status':response.status_code}))
except httpx.ConnectError: print(json.dumps({'trusted':False}))`;
/** Passive, bounded source/package/log inventory. No native module, skill or bootstrap is executed. */
const IMAGE_DIAGNOSTICS = `import hashlib,importlib.metadata,json,os,pathlib,re,stat,sys
data=json.loads(sys.stdin.buffer.read(8193)); root=pathlib.Path('/opt/hermes'); home=pathlib.Path('/opt/data/profiles')/data['profile']
if not re.fullmatch(r'cui-team-[a-f0-9]{32}',data['profile']): raise RuntimeError('Invalid fixture profile')
s=home.lstat()
if home.is_symlink() or data['identity']!=str(s.st_dev)+':'+str(s.st_ino): raise RuntimeError('Fixture retained identity changed')
checked=0; changed=[]
for name,expected in data['hashes'].items():
 if not re.fullmatch(r'[A-Za-z0-9_./-]{1,200}',name) or name.startswith('/') or '..' in name.split('/'): raise RuntimeError('Invalid fixed source contract path')
 p=root/name
 try:
  if p.is_symlink() or not p.is_file() or p.stat().st_size>2000000: raise RuntimeError('Source contract file unavailable')
  actual=hashlib.sha256(p.read_bytes()).hexdigest(); checked+=1
  if actual!=expected: changed.append(name)
 except FileNotFoundError: changed.append(name+' (missing)')
packages={}
for name in ('openai','httpx','mcp','pydantic','certifi'):
 try: packages[name]=importlib.metadata.version(name)
 except importlib.metadata.PackageNotFoundError: packages[name]='missing'
logs=[]; folder=home/'logs'
if folder.is_dir() and not folder.is_symlink():
 for p in sorted(folder.iterdir())[:16]:
  if not re.fullmatch(r'[A-Za-z0-9_.-]{1,100}',p.name) or not p.name.endswith(('.log','.jsonl')): continue
  fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
  try:
   st=os.fstat(fd)
   if not stat.S_ISREG(st.st_mode): continue
   os.lseek(fd,max(0,st.st_size-1024),os.SEEK_SET); logs.append({'name':p.name,'size':st.st_size,'tail':os.read(fd,1024).decode('utf-8','replace')})
  finally: os.close(fd)
print(json.dumps({'checked':checked,'changed':changed,'python':sys.version.split()[0],'packages':packages,'logs':logs}))`;

describe('official-image fixture diagnostic safety without Docker', () => {
  it('masks every issued purpose/tool/learning grant, synthetic company credential and bounded stderr', () => {
    const config = BrokerConfig.parse({ stateDir: '/tmp/synthetic-image-diagnostics', socketPath: '/tmp/synthetic-image-diagnostics.sock', bridgePath: '/tmp/synthetic-bridge.py', image: PIN, namespace: 'cui-image-diagnostics' });
    const driver = new ObservedDriver(config);
    const tokens = { reply: 'a'.repeat(64), learning: 'b'.repeat(64), utility: 'c'.repeat(64), subagent: 'd'.repeat(64) };
    driver.candidates.push({ teamBotId: 'image-team', mode: 'admin', bindingId: 'binding', runId: 'run', contextId: 'context', expiresAt: 1,
      model: route.model, adapterId: 'collective-openai-chat-v1', modelBaseUrls: { reply: 'https://test.invalid', learning: 'https://test.invalid', utility: 'https://test.invalid', subagent: 'https://test.invalid' },
      modelTokens: tokens, toolUrl: 'https://test.invalid', toolToken: 'e'.repeat(64), learningToken: 'f'.repeat(64) });
    const secrets = [...Object.values(tokens), 'e'.repeat(64), 'f'.repeat(64), 'synthetic-never-live-provider-key', 'synthetic-hosted-image-fixture-only'];
    const sanitized = driver.safe(secrets.join('\n')); for (const secret of secrets) expect(sanitized).not.toContain(secret);
    expect(driver.safe('x'.repeat(100000))).toHaveLength(16000);
    const partial = driver.safe(tokens.reply.slice(0, 32)); expect(driver.safe(partial + tokens.reply.slice(32))).not.toMatch(/a{32}/);
  });
  it('compiles the fixed passive Python inventory without executing native code or inspecting Docker', async () => {
    await exec('/usr/bin/python3', ['-c', 'import sys; compile(sys.argv[1], "<fixed-passive-image-diagnostics>", "exec")', IMAGE_DIAGNOSTICS],
      { env: ENV, timeout: 10000 });
  });
});

const suite = fixture.enabled ? describe : describe.skip;
suite('HOSTED official pinned image: active Team gateway, native learning and cancellation', () => {
  let root: string, config: BrokerConfig, driver: ObservedDriver, broker: DockerBroker, ipc: Awaited<ReturnType<typeof listenBroker>> | undefined;
  let gateway: Server | undefined, origin: string, owner: string, admin: Principal;
  let binding: Awaited<ReturnType<DockerBroker['ensureTeam']>>;
  const diagnosticNames = new Set<string>();
  const calls: Array<{ contextId: string; purpose: string }> = [], statuses: number[] = [], handoffs: unknown[] = [];
  const counts = new Map<string, number>();
  let scenario: 'teach' | 'cancel' = 'teach', cancelEntered = false, cancelDisconnected = false, rejected = 0;

  function nativeAdmission(contextId: string, conversationId: string, runId: string) {
    const observed = driver.candidates.find(candidate => candidate.contextId === contextId);
    expect(observed).toMatchObject({ contextId, runId, teamBotId: 'image-team', mode: 'admin', bindingId: binding.bindingId });
    // Match the broker's server-derived portal session and run receipt, including the complete bot ID.
    const sessionId = `portal-${conversationId}-${observed!.teamBotId}`, idempotencyKey = `portal-${observed!.runId}`;
    expect(sessionId).toBe(`portal-${conversationId}-image-team`); expect(idempotencyKey).toBe(`portal-${runId}`);
    return { sessionId, idempotencyKey };
  }

  async function ownedRuntime() {
    const [info] = JSON.parse(await docker(['inspect', driver.name(owner)]));
    expect(info.Config.Image).toBe(PIN); expect(info.Config.Labels['collective.namespace']).toBe(config.namespace);
    expect(info.Config.Labels['collective.owner']).toBe(runtimeKey(owner)); expect(info.Name).toBe(`/${driver.name(owner)}`);
    return info;
  }
  async function imageInput(args: string[], input: string): Promise<string> {
    await ownedRuntime();
    return new Promise((resolve, reject) => {
      const child = spawn('/usr/local/bin/docker', args, { env: ENV, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Bounded image fixture input timed out.')); }, 15000);
      child.stdout.on('data', value => { stdout += String(value); if (stdout.length > 64000) child.kill(); });
      child.stderr.on('data', value => { stderr += String(value).slice(0, 8192 - stderr.length); });
      child.stdin.on('error', () => {}); child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(stdout); else reject(new Error(`Fixed image fixture refused setup: ${stderr}`)); });
      child.stdin.end(input);
    });
  }
  async function startupDiagnostics() {
    const name = `${driver.name(owner)}-diagnostic-${randomUUID().replaceAll('-', '')}`; diagnosticNames.add(name);
    const [volume] = JSON.parse(await docker(['volume', 'inspect', `${driver.name(owner)}-data`], 10000));
    expect(volume.Labels['collective.namespace']).toBe(config.namespace); expect(volume.Labels['collective.owner']).toBe(runtimeKey(owner));
    const id = (await docker(['create', '--pull', 'never', '--interactive', '--name', name, '--label', `collective.namespace=${config.namespace}`,
      '--label', `collective.owner=${runtimeKey(owner)}`, '--label', 'collective.purpose=team-image-diagnostics', '--network', 'none', '--read-only',
      '--user', '10000:10000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '32', '--memory', '256m',
      '--memory-swap', '256m', '--cpus', '1', '--restart', 'no', '--log-driver', 'none',
      '--mount', `type=volume,src=${driver.name(owner)}-data,dst=/opt/data,readonly`, '--env', 'HOME=/nonexistent', '--env', 'PYTHONDONTWRITEBYTECODE=1',
      '--entrypoint', '/opt/hermes/.venv/bin/python', PIN, '-B', '-c', IMAGE_DIAGNOSTICS], 10000)).trim();
    try {
      const [entry] = JSON.parse(await docker(['inspect', id], 10000));
      expect(entry.Name).toBe(`/${name}`); expect(entry.Config.Image).toBe(PIN); expect(entry.HostConfig.NetworkMode).toBe('none');
      expect(entry.HostConfig.ReadonlyRootfs).toBe(true); expect(entry.Config.User).toBe('10000:10000'); expect(entry.HostConfig.CapDrop).toEqual(['ALL']);
      expect(entry.Mounts).toHaveLength(1); expect(entry.Mounts[0]).toMatchObject({ Type: 'volume', Name: `${driver.name(owner)}-data`, Destination: '/opt/data', RW: false });
      expect(entry.Config.Labels['collective.namespace']).toBe(config.namespace); expect(entry.Config.Labels['collective.owner']).toBe(runtimeKey(owner));
      expect(entry.Config.Labels['collective.purpose']).toBe('team-image-diagnostics');
      return driver.safe(await imageInput(['start', '--attach', '--interactive', id], JSON.stringify({ profile: binding.profile, identity: binding.identity, hashes: nativeContract.sourceHashes }))).slice(0, 8000);
    } finally { await docker(['container', 'rm', '--force', id], 10000); diagnosticNames.delete(name); }
  }
  async function startCandidate(parent: { id: string; holder: string | null; segment: number }) {
    try { return await startTeamCandidateRun(admin, 'image-team', parent.id, { holder: parent.holder!, segment: parent.segment, routes: [route] }); }
    catch (error) {
      let inventory: string;
      try { inventory = await startupDiagnostics(); } catch (cause) { inventory = driver.safe(`Passive image diagnostics unavailable: ${String(cause)}`); }
      let state: unknown;
      try { const { State } = await ownedRuntime(); state = { status: State.Status, exitCode: State.ExitCode, oomKilled: State.OOMKilled, error: String(State.Error).slice(0, 1024) }; }
      catch { state = 'Owned runtime state unavailable'; }
      throw new Error(driver.safe(`${String(error)}; runtime state=${JSON.stringify(state)}; native stderr=${driver.stderr.slice(-4000)}; native RPC errors=${JSON.stringify(driver.nativeErrors.slice(-4)).slice(0, 3000)}; passive image inventory=${inventory}`));
    }
  }
  async function provider(purpose: string, init?: RequestInit) {
    const body = JSON.parse(String(init?.body)); expect(body.model).toBe(route.model); expect(body.max_tokens).toBe(256);
    const count = counts.get(purpose) ?? 0; counts.set(purpose, count + 1);
    if (purpose === 'utility') return Response.json({ id: 'synthetic-title', object: 'chat.completion', model: route.model,
      choices: [{ index: 0, message: { role: 'assistant', content: '{"title":"Synthetic useful procedure"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3 } });
    if (scenario === 'cancel' && purpose === 'reply') {
      cancelEntered = true;
      return new Promise<Response>((_resolve, reject) => {
        const stopped = () => { cancelDisconnected = true; reject(new Error('Synthetic upstream was cancelled.')); };
        init?.signal?.addEventListener('abort', stopped, { once: true }); if (init?.signal?.aborted) stopped();
      });
    }
    if (purpose === 'reply' && count === 0) return completion([
      { name: 'skill_manage', arguments: { operations: [{ action: 'create', name: 'procedure', content: SKILL }] } },
      { name: 'memory', arguments: { action: 'add', target: 'memory', content: 'Private image fixture working note.' } },
    ]);
    if (purpose === 'learning' && count === 0) return completion([{ name: 'skill_manage', arguments: { operations: [{ action: 'create', name: 'learned-procedure', content: LEARNED }] } }]);
    if (purpose === 'learning' && count === 1) return completion([{ name: 'skill_manage', arguments: { operations: [{ action: 'patch', name: 'learned-procedure', old_string: 'record the decision', new_string: 'record the reviewed decision' }] } }]);
    expect(purpose).not.toBe('subagent');
    if (purpose === 'reply') expect((body.messages as Array<{ role: string }>).some(message => message.role === 'tool')).toBe(true);
    return completion([], purpose === 'learning' ? 'Improved the reusable skill.' : 'Learned the useful procedure.');
  }

  beforeAll(async () => {
    if (process.platform !== 'linux' || process.arch !== 'x64' || process.env.DOCKER_HERMES_TEST_ROOTFS) throw new Error('Hosted Linux amd64 original-image fixture required.');
    const info = JSON.parse(await docker(['info', '--format', '{{json .}}']));
    if (!['overlay2', 'overlayfs'].includes(info.Driver)) throw new Error('VFS is refused. Do not pull the image locally.');
    // CI has already pulled the exact pin. No test-side image or rootfs substitution is accepted.
    const [image] = JSON.parse(await docker(['image', 'inspect', PIN])); expect(image.RepoDigests).toContain(PIN);
    expect(image.Os).toBe('linux'); expect(image.Architecture).toBe('amd64'); expect(VERIFIED_TEAM_MODEL_ROUTES).toHaveLength(0); expect(VERIFIED_TEAM_TOOL_ADAPTERS).toHaveLength(0);
    root = await mkdtemp(path.join(os.tmpdir(), 'hermes-team-active-image-'));
    await mkdir(path.join(root, 'state'), { mode: 0o700 }); await mkdir(path.join(root, 'ipc'), { mode: 0o700 });
    config = BrokerConfig.parse({ stateDir: path.join(root, 'state'), socketPath: path.join(root, 'ipc', 'broker.sock'), bridgePath: path.resolve('src/docker-hermes/bridge.py'),
      image: PIN, namespace: `cui-active-${randomUUID().slice(0, 8)}`, network: 'internet', teamBotsEnabled: true, teamCandidateRuntimeEnabled: true });
    // Assign the fixed synthetic owner before provisioning so partial setup still has exact cleanup targets.
    owner = 'team-admin:image-team';
    driver = new ObservedDriver(config); broker = new DockerBroker(config, driver); ipc = await listenBroker(broker);
    vi.stubEnv('DOCKER_HERMES_SOCKET', config.socketPath); vi.stubEnv('HERMES_TEAM_BOTS_ENABLED', '1'); vi.stubEnv('HERMES_TEAM_CANDIDATE_RUNTIME_ENABLED', '1');
    vi.stubEnv('ENCRYPTION_KEY', 'synthetic-hosted-image-fixture-only'); vi.stubEnv('ENCRYPTION_KEYS', ''); vi.stubEnv('ENCRYPTION_PRIMARY_KID', '');
    await fixture.client!.waitReady;
    for (const file of readdirSync('src/db/migrations').filter(file => file.endsWith('.sql')).sort())
      await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, 'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;', '').replace(/\bvector\b/g, 'real[]'));
    await db.insert(schema.users).values({ id: 'image-admin', upn: 'image-admin@test.invalid', name: 'Synthetic image admin', isAdmin: true, authSource: 'local', identityRealm: 'local' });
    admin = (await loadPrincipal('image-admin'))!;
    await db.insert(schema.aiApps).values({ id: 'provider', name: 'Synthetic provider', provider: 'openai-compatible', baseUrl: 'https://provider.test.invalid/v1', model: route.model,
      credentialMode: 'org', apiKeyEnc: sealAppSecret('provider', 'synthetic-never-live-provider-key'), providerConfig: {} });
    route.transportHash = (await candidateWireMetadata(admin, route)).hash;
    await db.insert(schema.bots).values({ id: 'image-team', ownerId: admin.user.id, appId: 'provider', name: 'Synthetic image Team', visibility: 'private' });
    await configureTeam(admin, 'image-team', { enabled: true, expectedVersion: 0, maintainerIds: [admin.user.id], modelPolicy: { mode: 'admin_provided', adminRouteId: route.id } });
    const grant = broker.authorizeTeam(admin.user.id, { teamBotId: 'image-team', mode: 'admin', modelPolicy: 'admin_provided' });
    binding = await broker.ensureTeam(admin.user.id, { teamBotId: 'image-team', mode: 'admin', name: 'Synthetic image Team' }, grant.grantId); expect(binding.ownerId).toBe(owner);
    const runtime = await ownedRuntime(), networkName = runtime.HostConfig.NetworkMode;
    const [network] = JSON.parse(await docker(['network', 'inspect', networkName]));
    expect(network.Internal).toBe(false); expect(network.Options['com.docker.network.bridge.enable_icc']).toBe('false');
    expect(network.Labels['collective.namespace']).toBe(config.namespace); expect(network.Labels['collective.owner']).toBe(runtimeKey(owner));
    const address = network.IPAM.Config[0]?.Gateway; if (typeof address !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(address)) throw new Error('Expected the disposable owner bridge host gateway.');
    const key = path.join(root, 'fixture.key'), cert = path.join(root, 'fixture.crt');
    await exec('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '1', '-nodes', '-keyout', key, '-out', cert,
      '-subj', '/CN=Collective synthetic hosted image fixture', '-addext', `subjectAltName=IP:${address}`], { env: ENV, timeout: 10000, maxBuffer: 16000 });
    await chmod(key, 0o600);
    gateway = createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => { void (async () => {
      const match = /^\/api\/hermes-team\/native\/([^/]+)\/(?:model\/(reply|learning|utility|subagent)\/chat\/completions|(mcp|learning))$/.exec(req.url ?? '');
      const candidate = match && driver.candidates.find(value => value.contextId === match[1]);
      const expected = candidate && match && (match[2] ? candidate.modelTokens[match[2] as keyof typeof candidate.modelTokens] : match[3] === 'mcp' ? candidate.toolToken : candidate.learningToken);
      if (req.method !== 'POST' || !expected || req.headers.authorization !== `Bearer ${expected}`) { rejected++; res.writeHead(403); res.end(); return; }
      const chunks: Buffer[] = []; let size = 0;
      const bodyTimeout = setTimeout(() => { res.writeHead(408); res.end(); req.destroy(); }, 8000);
      try { for await (const value of req) { size += value.length; if (size > 64000) { res.writeHead(413); res.end(); return; } chunks.push(Buffer.from(value)); } }
      finally { clearTimeout(bodyTimeout); }
      const body = Buffer.concat(chunks), disconnected = new AbortController(); req.once('aborted', () => disconnected.abort());
      res.once('close', () => { if (!res.writableEnded) disconnected.abort(); });
      const incoming = new Request(`${origin}${req.url}`, { method: 'POST', headers: new Headers(req.headers as Record<string, string>), body, signal: disconnected.signal });
      let response: Response;
      if (match![2]) {
        calls.push({ contextId: match![1], purpose: match![2] });
        response = await candidateModelHttp(incoming, { contextId: match![1], purpose: match![2], operation: ['chat', 'completions'] }, { routes: [route], fetch: (url, init) => {
          expect(String(url)).toBe('https://provider.test.invalid/v1/chat/completions'); return provider(match![2], init);
        } });
        statuses.push(response.status);
      } else if (match![3] === 'mcp') response = await candidateMcpHttp(incoming, match![1], { routes: [route], adapters: [] });
      else { handoffs.push(JSON.parse(body.toString())); response = await nativeLearningHandoffHttp(incoming, match![1], { routes: [route] }); }
      if (!res.destroyed) { res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text()); }
    })().catch(() => { if (!res.destroyed) { res.writeHead(500); res.end('Synthetic fixture request failed.'); } }); });
    gateway.requestTimeout = 45000; gateway.headersTimeout = 10000; gateway.maxConnections = 32;
    await new Promise<void>((resolve, reject) => { gateway!.once('error', reject); gateway!.listen(0, address, resolve); });
    origin = `https://${address}:${(gateway.address() as { port: number }).port}`; vi.stubEnv('HERMES_TEAM_GATEWAY_ORIGIN', origin);
    const probe = async () => JSON.parse(await docker(['exec', '--user', '10000:10000', driver.name(owner), '/opt/hermes/.venv/bin/python', '-c', TLS_PROBE, `${origin}/not-a-fixture-path`]));
    expect(await probe()).toEqual({ trusted: false });
    const trusted = JSON.parse(await imageInput(['exec', '--interactive', '--user', '0:0', driver.name(owner), '/opt/hermes/.venv/bin/python', '-c', TRUST_CA], await readFile(cert, 'utf8')));
    expect(trusted.before).not.toBe(trusted.after); expect(await probe()).toEqual({ trusted: true, status: 403 });
    expect(rejected).toBe(1);
    await docker(['exec', '--user', '10000:10000', driver.name(owner), '/opt/hermes/.venv/bin/python', '-c', NUDGE, binding.profile, binding.identity]);
    const profile = await reserveTeamProfile(admin, 'image-team', 'admin');
    await db.update(schema.hermesTeamProfiles).set({ state: 'ready', binding }).where(eq(schema.hermesTeamProfiles.id, profile.id));
  }, 300000);

  beforeEach(async () => {
    const unsettled = await db.select().from(schema.hermesTeamCandidateContexts);
    if (unsettled.some(context => context.retirementState !== 'confirmed')) throw new Error('The previous fixture native writer did not confirm shutdown.');
  });
  afterEach(async () => {
    if (!admin || !binding || !driver) return;
    // Test failure cannot lend a still-running context to the next case. Retire through the production retained cleanup path first.
    const contexts = await db.select().from(schema.hermesTeamCandidateContexts);
    for (const context of contexts) expect(await retireStoredTeamCandidateRun(context.runId)).toEqual({ confirmed: true, runtimeWide: true });
    const unfinished = await db.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.userId, admin.user.id), eq(schema.agentRuns.botId, 'image-team'),
      inArray(schema.agentRuns.status, ['queued', 'running', 'waiting', 'waiting_tasks'])));
    for (const run of unfinished) {
      await db.update(schema.agentRuns).set({ status: 'cancelled', cancelRequestedAt: new Date() }).where(eq(schema.agentRuns.id, run.id));
      await settleTeamCandidateRun(run.id, false, [route]);
    }
    expect(await driver.running(owner)).toBe(false);
  }, 90000);

  afterAll(async () => {
    const errors: unknown[] = [];
    try { await ipc?.close(); } catch (error) { errors.push(error); }
    gateway?.closeAllConnections(); if (gateway) await new Promise<void>(resolve => gateway!.close(() => resolve()));
    if (config && driver && owner) {
      const name = driver.name(owner);
      // Exact namespace + owner + expected name + immutable image. No daemon-wide pruning or unowned cleanup.
      const targets = new Set([name, ...diagnosticNames]);
      try { for (const target of (await docker(['container', 'ls', '-a', '--filter', `label=collective.namespace=${config.namespace}`, '--format', '{{.Names}}'], 10000)).trim().split(/\s+/).filter(Boolean)) targets.add(target); }
      catch (error) { errors.push(error); }
      for (const id of targets) try {
          const found = (await docker(['container', 'ls', '-a', '--filter', `name=^/${id}$`, '--format', '{{.ID}}'], 10000)).trim(); if (!found) continue;
          const [entry] = JSON.parse(await docker(['inspect', found], 10000));
          if (entry.Config.Image !== PIN || entry.Config.Labels['collective.owner'] !== runtimeKey(owner) || entry.Config.Labels['collective.namespace'] !== config.namespace
            || !(entry.Name === `/${name}` || entry.Name.startsWith(`/${name}-resources-`) || (diagnosticNames.has(entry.Name.slice(1)) && entry.Config.Labels['collective.purpose'] === 'team-image-diagnostics')))
            throw new Error('Refuse cleanup of altered fixture container ownership.');
          await docker(['container', 'rm', '--force', entry.Id], 10000);
      } catch (error) { errors.push(error); }
      for (const suffix of ['-data', '-team-updates']) try {
        const volume = `${name}${suffix}`, found = (await docker(['volume', 'ls', '--filter', `name=^${volume}$`, '--format', '{{.Name}}'], 10000)).trim(); if (!found) continue;
        const [entry] = JSON.parse(await docker(['volume', 'inspect', volume], 10000));
        if (entry.Labels['collective.owner'] !== runtimeKey(owner) || entry.Labels['collective.namespace'] !== config.namespace) throw new Error('Refuse cleanup of altered fixture volume ownership.');
        await docker(['volume', 'rm', volume], 10000);
      } catch (error) { errors.push(error); }
      try {
        const network = `${name}-internet`, found = (await docker(['network', 'ls', '--filter', `name=^${network}$`, '--format', '{{.ID}}'], 10000)).trim();
        if (found) {
          const [entry] = JSON.parse(await docker(['network', 'inspect', found], 10000));
          if (entry.Labels['collective.owner'] !== runtimeKey(owner) || entry.Labels['collective.namespace'] !== config.namespace || Object.keys(entry.Containers ?? {}).length) throw new Error('Refuse cleanup of altered fixture network ownership.');
          await docker(['network', 'rm', found], 10000);
        }
      } catch (error) { errors.push(error); }
    }
    await fixture.client?.close(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, 'Owned official-image fixture cleanup failed.');
  }, 180000);

  it('teaches through the real native gateway and runs a fresh durable learning child after confirmed parent Stop', async () => {
    const chat = await openTeamConversation(admin, 'image-team', 'admin');
    await db.insert(schema.messages).values({ id: 'image-user-message', conversationId: chat.conversationId, role: 'user', parts: [{ type: 'text', text: 'Teach a useful procedure.' }] });
    await db.insert(schema.agentRuns).values({ id: 'image-parent', userId: admin.user.id, botId: 'image-team', conversationId: chat.conversationId, messageId: 'image-assistant-message' });
    const parent = (await claimRun('image-parent', 'hosted-image-parent-worker'))!;
    const active = await startCandidate(parent);
    expect(active.target.profile).toBe(binding.bindingId);
    const run = await startRun(active.target, { input: 'Teach a useful procedure: validate input, record the decision, then report the result.', ...nativeAdmission(active.contextId, chat.conversationId, parent.id) });
    const events: string[] = []; for await (const event of runEvents(active.target, run)) events.push(event.event);
    expect(await getRun(active.target, run)).toMatchObject({ status: 'completed', output: 'Learned the useful procedure.' }); expect(events).toContain('tool.completed');
    expect(handoffs).toHaveLength(1); expect(fixture.queued).toHaveLength(0); expect(counts.get('learning') ?? 0).toBe(0);
    await db.insert(schema.messages).values({ id: 'image-assistant-message', conversationId: chat.conversationId, role: 'assistant', parts: [{ type: 'text', text: 'Learned the useful procedure.' }] });
    const visible = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, chat.conversationId));
    await db.update(schema.agentRuns).set({ status: 'succeeded' }).where(eq(schema.agentRuns.id, parent.id));
    expect(await active.retire()).toEqual({ confirmed: true, runtimeWide: true }); expect(await driver.running(owner)).toBe(false);
    await settleTeamCandidateRun(parent.id, true, [route]); expect(fixture.queued).toHaveLength(1);
    const child = (await claimRun(fixture.queued[0], 'hosted-image-learning-worker'))!;
    const learning = await startCandidate(child);
    expect(learning.contextId).not.toBe(active.contextId); expect(driver.candidates).toHaveLength(2);
    expect(driver.candidates[1].runPurpose).toBe('learning'); expect(driver.candidates[1].learningToken).toBeUndefined();
    await executeTeamLearningSegment(child, child.holder!, learning, new AbortController()); await settleTeamCandidateRun(child.id, true, [route]);
    expect((await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, child.id)))[0]).toMatchObject({ status: 'succeeded', background: true });
    expect(await driver.running(owner)).toBe(false); expect(await db.select().from(schema.messages).where(eq(schema.messages.conversationId, chat.conversationId))).toEqual(visible);
    const grant = broker.authorizeTeam(admin.user.id, { teamBotId: 'image-team', mode: 'admin', modelPolicy: 'admin_provided' });
    const capture = await broker.captureTeamResources(admin.user.id, { teamBotId: 'image-team', mode: 'admin', selection: { skillPackages: ['procedure', 'learned-procedure'], includeRole: false, documents: [] } }, grant.grantId);
    expect(capture.resources.find(resource => resource.path === 'skills/procedure/SKILL.md')?.content).toBe(SKILL);
    expect(capture.resources.find(resource => resource.path === 'skills/learned-procedure/SKILL.md')?.content).toBe(IMPROVED);
    expect(JSON.stringify(capture)).not.toMatch(/Private image fixture working note|synthetic-never-live-provider-key/);
    expect(calls.filter(call => call.purpose === 'learning').every(call => call.contextId === learning.contextId)).toBe(true);
    expect(calls.filter(call => call.purpose !== 'utility').map(call => call.purpose)).toEqual(['reply', 'reply', 'learning', 'learning', 'learning']);
    expect(statuses.every(status => status === 200)).toBe(true); expect(handoffs).toHaveLength(1);
    expect((await db.select().from(schema.hermesTeamLearningHandoffs))[0]).toMatchObject({ state: 'complete', childRunId: child.id });
  }, 180000);

  it('cancels an actual active gateway request, shuts down the exact owned container and keeps ambiguous model work fenced', async () => {
    scenario = 'cancel'; counts.clear();
    const chat = await openTeamConversation(admin, 'image-team', 'admin');
    await db.insert(schema.agentRuns).values({ id: 'image-cancel', userId: admin.user.id, botId: 'image-team', conversationId: chat.conversationId, messageId: 'image-cancel-message' });
    const parent = (await claimRun('image-cancel', 'hosted-image-cancel-worker'))!;
    const active = await startCandidate(parent);
    expect(active.target.profile).toBe(binding.bindingId);
    const run = await startRun(active.target, { input: 'Wait for the synthetic cancelled operation.', ...nativeAdmission(active.contextId, chat.conversationId, parent.id) });
    await until(() => cancelEntered, value => value); await stopRun(active.target, run);
    expect(await active.retire()).toEqual({ confirmed: true, runtimeWide: true }); expect(await driver.running(owner)).toBe(false);
    await until(() => cancelDisconnected, value => value);
    const rows = await until(() => db.select().from(schema.hermesTeamCandidateRequests).where(eq(schema.hermesTeamCandidateRequests.contextId, active.contextId)),
      value => value.some(row => row.kind === 'model' && row.state === 'needs_attention'));
    expect(rows.some(row => row.kind === 'model' && row.state === 'needs_attention')).toBe(true);
    await db.update(schema.agentRuns).set({ status: 'cancelled' }).where(eq(schema.agentRuns.id, parent.id)); await settleTeamCandidateRun(parent.id, false, [route]);
    expect(fixture.queued).toHaveLength(1); expect(VERIFIED_TEAM_MODEL_ROUTES).toHaveLength(0); expect(VERIFIED_TEAM_TOOL_ADAPTERS).toHaveLength(0);
  }, 90000);
});
