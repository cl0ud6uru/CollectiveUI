import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { Principal } from '@/lib/auth/groups';
const fixture = vi.hoisted(() => ({ client: null as PGlite | null }));
vi.mock('@/lib/docker-hermes/client', () => ({ dockerControl: vi.fn().mockResolvedValue({ stopped: true }), dockerFetch: vi.fn() }));
vi.mock('@/db', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const schema = await import('@/db/schema');
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client, { schema }), schema };
});
import { db, schema } from '@/db';
import { loadPrincipal } from '@/lib/auth/groups';
import { configureTeam, reserveTeamProfile } from '@/lib/hermes-team/store';
import { openTeamConversation } from '@/lib/hermes-team/conversations';
import { issueTeamCandidateContext } from '@/lib/hermes-team/candidate-context';
import { candidateModelHttp, candidateMcpHttp } from '@/lib/hermes-team/candidate-http';
import { candidateWireMetadata } from '@/lib/hermes-team/candidate-wire-metadata';
import { TEAM_MODEL_PURPOSES, type VerifiedTeamModelRoute } from '@/lib/hermes-team/model-policy';
import { sealAppSecret } from '@/lib/llm/secrets';
import { LocalController } from '@/local-hermes/controller';
import { HERMES_COMMIT } from '@/local-hermes/config';
import { DockerBroker } from '@/docker-hermes/broker';
import { BrokerConfig } from '@/docker-hermes/docker';
import { PinnedSourceRuntimeDriver } from '../fixtures/hermes-team-active-driver';
import type { TeamCandidateConfig } from '@/docker-hermes/types';
import { createTeamPublicationService } from '@/lib/hermes-team/publication';
import { createMemberUpdateService } from '@/lib/hermes-team/member-updates';
import type { TeamResourceSnapshot } from '@/lib/hermes-team/resources';

const exec = promisify(execFile);
const SOURCE = process.env.HERMES_SOURCE;
const PYTHON = process.env.HERMES_TEAM_CANDIDATE_PYTHON ?? 'python';
const LAUNCHER = 'tests/fixtures/hermes-team-active-gateway.py';
const nativeEnv = { NODE_ENV: 'test' as const, HERMES_SOURCE: SOURCE, PATH: '/usr/bin:/bin' };
const SKILL = '---\nname: procedure\ndescription: A synthetic useful Team procedure.\n---\n\nValidate the input, record the decision, then report the result.\n';
const LEARNED_SKILL = SKILL.replace('name: procedure', 'name: learned-procedure');
const IMPROVED = LEARNED_SKILL.replace('record the decision', 'record the reviewed decision');
const route: VerifiedTeamModelRoute = {
  id: 'app:provider', adapterId: 'collective-openai-chat-v1', model: 'synthetic-model', billing: 'admin',
  integration: 'admin_inference_gateway', credentialHandling: 'server_gateway', evidence: {
    id: 'offline-native-lifecycle-only', hermesRevision: HERMES_COMMIT, adapterId: 'collective-openai-chat-v1',
    model: 'synthetic-model', integration: 'admin_inference_gateway', purposes: TEAM_MODEL_PURPOSES,
    verifiedAt: 1, expiresAt: 4102444800000,
  },
};
let admin: Principal;

/** Deterministic provider wire data, not inference and not a native-loop substitute. */
function completion(calls: Array<{ name: string; arguments: unknown }> = [], content = 'Learned the useful procedure.') {
  const toolCalls = calls.map((call, index) => ({ index, id: `native-tool-${index}`, type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
  const chunk = (delta: unknown, finish_reason: string | null, usage?: unknown) => ({ id: 'synthetic-native',
    object: 'chat.completion.chunk', created: 1, model: route.model, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) });
  return new Response(`data: ${JSON.stringify(chunk({ role: 'assistant', ...(calls.length ? { tool_calls: toolCalls } : { content }) }, null))}\n\n` +
    `data: ${JSON.stringify(chunk({}, calls.length ? 'tool_calls' : 'stop', { prompt_tokens: 7, completion_tokens: 3 }))}\n\ndata: [DONE]\n\n`,
  { headers: { 'Content-Type': 'text/event-stream' } });
}
async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() >= deadline) throw new Error(`Synthetic native fixture timed out: ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync('src/db/migrations').filter(file => file.endsWith('.sql')).sort()) {
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, 'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;', '').replace(/\bvector\b/g, 'real[]'));
  }
}, 45_000);
beforeEach(async () => {
  vi.stubEnv('HERMES_TEAM_BOTS_ENABLED', '1');
  vi.stubEnv('AUTH_URL', 'https://app.test.invalid');
  vi.stubEnv('ENCRYPTION_KEY', 'synthetic-lifecycle-encryption-only');
  await fixture.client!.exec('TRUNCATE users,ai_apps,groups,mcp_servers CASCADE');
  await db.insert(schema.users).values([{ id: 'admin', upn: 'admin@test.invalid', name: 'Admin', isAdmin: true, authSource: 'local', identityRealm: 'local' },
    { id: 'member', upn: 'member@test.invalid', name: 'Member', authSource: 'local', identityRealm: 'local' }]);
  admin = (await loadPrincipal('admin'))!;
  await db.insert(schema.aiApps).values({ id: 'provider', name: 'Synthetic provider', provider: 'openai-compatible',
    baseUrl: 'https://provider.test.invalid/v1', model: route.model, credentialMode: 'org',
    apiKeyEnc: sealAppSecret('provider', 'synthetic-never-live-provider-key'), providerConfig: {} });
  route.transportHash = (await candidateWireMetadata(admin, route)).hash;
  await db.insert(schema.bots).values({ id: 'team', ownerId: 'admin', appId: 'provider', name: 'Team', visibility: 'groups' });
  await db.insert(schema.botUserAccess).values({ botId: 'team', userId: 'member' });
  await configureTeam(admin, 'team', { enabled: true, expectedVersion: 0, maintainerIds: ['admin'],
    modelPolicy: { mode: 'admin_provided', adminRouteId: route.id } });
});
afterAll(async () => { await fixture.client!.close(); vi.unstubAllEnvs(); });

describe.skipIf(!SOURCE)('actual pinned native Team conversational lifecycle, synthetic providers only', () => {
  it('uses real gateway sessions, native tools and background review through production model handlers', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'hermes-team-active-source-'));
    const calls: Array<{ purpose: string; body: Record<string, unknown> }> = [];
    const statuses: number[] = [];
    const counts = new Map<string, number>();
    let contextId = '';
    const provider = async (purpose: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.max_tokens).toBe(256); expect(body.reasoning).toBeUndefined();
      const count = counts.get(purpose) ?? 0; counts.set(purpose, count + 1);
      if (purpose === 'utility') return new Response(JSON.stringify({ id: 'synthetic-title', object: 'chat.completion', model: route.model,
        choices: [{ index: 0, message: { role: 'assistant', content: '{"title":"Synthetic useful procedure"}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 3 } }), { headers: { 'Content-Type': 'application/json' } });
      if (purpose === 'reply' && count === 0) return completion([
        { name: 'skill_manage', arguments: { operations: [{ action: 'create', name: 'procedure', content: SKILL }] } },
        { name: 'memory', arguments: { action: 'add', target: 'memory', content: 'Private working note: validate synthetic input before reporting.' } },
      ]);
      if (purpose === 'learning' && count === 0) return completion([{ name: 'skill_manage', arguments: {
        operations: [{ action: 'patch', name: 'procedure', old_string: 'record the decision', new_string: 'record the reviewed decision' }],
      } }]);
      if (purpose === 'learning' && count === 1) return completion([{ name: 'skill_manage', arguments: {
        operations: [{ action: 'create', name: 'learned-procedure', content: LEARNED_SKILL }],
      } }]);
      if (purpose === 'learning' && count === 2) return completion([{ name: 'skill_view', arguments: { name: 'learned-procedure' } }]);
      if (purpose === 'learning' && count === 3) return completion([{ name: 'skill_manage', arguments: {
        operations: [{ action: 'patch', name: 'learned-procedure', old_string: 'record the decision', new_string: 'record the reviewed decision' }],
      } }]);
      // Assert the actual native loop returns tool results to the model.
      if (purpose === 'reply') expect((body.messages as Array<{ role: string }>).some(message => message.role === 'tool')).toBe(true);
      return completion([], purpose === 'learning' ? 'Improved the reusable skill.' : 'Learned the useful procedure.');
    };
    const server = createServer((req, res) => { void (async () => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const disconnected = new AbortController();
      req.once('aborted', () => disconnected.abort());
      res.once('close', () => { if (!res.writableEnded) disconnected.abort(); });
      const incoming = new Request(`http://127.0.0.1${req.url}`, { method: 'POST', headers: new Headers(req.headers as Record<string, string>), body, signal: disconnected.signal });
      const model = /^\/model\/(reply|learning|utility|subagent)\/chat\/completions$/.exec(req.url ?? '');
      let response: Response;
      if (model) {
        calls.push({ purpose: model[1], body: JSON.parse(body.toString()) });
        response = await candidateModelHttp(incoming, { contextId, purpose: model[1], operation: ['chat', 'completions'] }, { routes: [route], fetch: (_url, init) => provider(model[1], init) });
        statuses.push(response.status);
      } else if (req.url === '/mcp') response = await candidateMcpHttp(incoming, contextId, { routes: [route], adapters: [] });
      else response = new Response(null, { status: 404 });
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
    })().catch(error => { res.writeHead(500); res.end(String(error)); }); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    let controller: LocalController | undefined;
    await mkdir(path.join(temp, 'state'), { mode: 0o700 }); await mkdir(path.join(temp, 'ipc'), { mode: 0o700 });
    const driver = new PinnedSourceRuntimeDriver(temp, SOURCE!, path.resolve(PYTHON), port);
    const broker = new DockerBroker(BrokerConfig.parse({ stateDir: path.join(temp, 'state'), socketPath: path.join(temp, 'ipc', 'fixture.sock'),
      bridgePath: path.resolve('src/docker-hermes/bridge.py'), namespace: 'cui-native-test',
      image: 'nousresearch/hermes-agent@sha256:2fd023efbb8d3d2b0ce1a73d028b07370cff34f567cfe0e999553e8c327ea283',
      network: 'none', teamBotsEnabled: true, teamCandidateRuntimeEnabled: true }), driver);
    try {
      const authorization = broker.authorizeTeam('admin', { teamBotId: 'team', mode: 'admin', modelPolicy: 'admin_provided' });
      const native = await broker.ensureTeam('admin', { teamBotId: 'team', mode: 'admin', name: 'Team' }, authorization.grantId);
      const name = native.profile;
      const volume = driver.volume(native.ownerId);
      const profileHome = driver.home(native.ownerId, name);
      await writeFile(path.join(profileHome, 'config.yaml'), JSON.stringify({ skills: { creation_nudge_interval: 1 }, memory: { nudge_interval: 1 } }));
      const chat = await openTeamConversation(admin, 'team', 'admin');
      const profile = await reserveTeamProfile(admin, 'team', 'admin');
      await db.update(schema.hermesTeamProfiles).set({ state: 'ready', binding: native }).where(eq(schema.hermesTeamProfiles.id, profile.id));
      await db.insert(schema.agentRuns).values({ id: 'admin-run', userId: 'admin', botId: 'team', conversationId: chat.conversationId, messageId: 'admin-message' });
      const grant = await issueTeamCandidateContext(admin, 'admin-run', 'default', [route]); contextId = grant.contextId;
      const config = { teamBotId: 'team', mode: 'admin', bindingId: native.bindingId, runId: 'admin-run', contextId, expiresAt: grant.expiresAt,
        model: route.model, adapterId: route.adapterId, modelBaseUrls: Object.fromEntries(TEAM_MODEL_PURPOSES.map(purpose => [purpose, `https://app.test.invalid/model/${purpose}`])),
        modelTokens: grant.modelTokens, toolUrl: 'https://app.test.invalid/mcp', toolToken: grant.toolToken } as TeamCandidateConfig;
      broker.prepareTeamCandidate('admin', config, authorization.grantId);
      const scope = { teamBotId: 'team', mode: 'admin' as const, bindingId: native.bindingId, runId: 'admin-run', contextId, conversationId: chat.conversationId };
      const [started, repeated] = await Promise.all([broker.startTeamCandidate('admin', scope, authorization.grantId), broker.startTeamCandidate('admin', scope, authorization.grantId)]);
      expect(started).toEqual(repeated); expect(driver.launches).toBe(1);
      const access = await broker.forTeamRequest('admin', 'team', 'admin', native.bindingId, authorization.grantId, { runId: scope.runId, contextId });
      controller = access.controller;
      expect(() => controller!.begin(access.nativeBindingId, { input: 'Wrong context', session_id: 'saved-browser-url' }, `portal-${scope.runId}`)).toThrow('another run');
      const runId = controller.begin(access.nativeBindingId, { input: 'Teach a useful procedure: validate input, record the decision, then report the result.',
        session_id: `portal-${chat.conversationId}-team` }, `portal-${scope.runId}`);
      const result = await until(() => controller!.getRun(runId), value => !['running', 'waiting_for_approval', 'waiting_for_input'].includes(value.status));
      expect(result, driver.stderr).toMatchObject({ status: 'completed', output: 'Learned the useful procedure.' });
      try {
        await until(async () => readFile(path.join(profileHome, 'skills', 'learned-procedure', 'SKILL.md'), 'utf8').catch(() => ''), value => value === IMPROVED, 5000);
      } catch (error) {
        const toolResults = calls.filter(call => call.purpose === 'learning').flatMap(call =>
          (call.body.messages as Array<{ role: string; content: unknown }>).filter(message => message.role === 'tool').map(message => message.content));
        throw new Error(`${String(error)}; purpose counts=${JSON.stringify([...counts])}; statuses=${JSON.stringify(statuses)}; synthetic tool results=${JSON.stringify(toolResults)}; synthetic stderr=${driver.stderr}`);
      }
      expect(await readFile(path.join(profileHome, 'skills', 'procedure', 'SKILL.md'), 'utf8')).toBe(SKILL);
      expect(await readFile(path.join(profileHome, 'memories', 'MEMORY.md'), 'utf8')).toContain('Private working note');
      expect(calls.filter(call => call.purpose !== 'utility').map(call => call.purpose)).toEqual(['reply', 'reply', 'learning', 'learning', 'learning', 'learning', 'learning']);
      expect(statuses).toHaveLength(8); expect(statuses.every(status => status === 200)).toBe(true);
      // This is the pin's real title task. The server strips its disable-reasoning
      // hint and supplies a bounded output limit before synthetic provider dispatch.
      expect(calls.filter(call => call.purpose === 'utility').map(call => ({ fields: Object.keys(call.body), maxTokens: call.body.max_tokens, maxCompletionTokens: call.body.max_completion_tokens })))
        .toEqual([{ fields: ['messages', 'model', 'response_format', 'reasoning'], maxTokens: undefined, maxCompletionTokens: undefined }]);
      expect(controller.events(runId, 0).events.some(event => event.event === 'tool.completed')).toBe(true);
      expect(await readFile(path.join(profileHome, 'state.db'))).not.toHaveLength(0);
      // Publication starts only after confirmed process-group Stop. It captures
      // selected native files through the actual helper, never a profile clone.
      expect(await broker.retireTeamCandidate('admin', { teamBotId: scope.teamBotId, mode: scope.mode, bindingId: scope.bindingId, runId: scope.runId, contextId: scope.contextId }))
        .toEqual({ confirmed: true, runtimeWide: true });
      expect(await driver.running(native.ownerId)).toBe(false);
      await db.update(schema.agentRuns).set({ status: 'succeeded' }).where(eq(schema.agentRuns.id, 'admin-run'));
      const publication = createTeamPublicationService({ captureResources: async (p, _bot, selection) => {
        expect(p.user.id).toBe('admin');
        const fresh = broker.authorizeTeam('admin', { teamBotId: 'team', mode: 'admin', modelPolicy: 'admin_provided' });
        return broker.captureTeamResources('admin', { teamBotId: 'team', mode: 'admin', selection }, fresh.grantId);
      } });
      const publish = async (expectedRevision: number) => {
        const review = await publication.capture(admin, 'team', { expectedRevision, selection: { skillPackages: ['learned-procedure'], includeRole: false, documents: [] } });
        const input = { snapshotId: review.snapshotId, expectedRevision, selectedKeys: ['skills/learned-procedure'], removalKeys: [], releaseNote: 'Reviewed native learned procedure', requestId: randomUUID() };
        const released = await publication.publish(admin, 'team', input);
        expect(await publication.publish(admin, 'team', input)).toEqual(released);
        return released;
      };
      await publish(0);
      const [firstRevision] = await db.select().from(schema.hermesTeamRevisions);
      const shared = firstRevision.manifest as unknown as TeamResourceSnapshot;
      expect(shared.resources.map(resource => resource.path)).toEqual(['skills/learned-procedure/SKILL.md']);
      expect(shared.resources[0].content).toBe(IMPROVED);
      expect(JSON.stringify(shared)).not.toContain('Private working note');
      const member = (await loadPrincipal('member'))!;
      const memberProfile = await reserveTeamProfile(member, 'team', 'member');
      const memberGrant = broker.authorizeTeam('member', { teamBotId: 'team', mode: 'member', modelPolicy: 'admin_provided' });
      const memberNative = await broker.ensureTeam('member', { teamBotId: 'team', mode: 'member', name: 'Team' }, memberGrant.grantId);
      const memberName = memberNative.profile;
      const memberVolume = driver.volume(memberNative.ownerId);
      const memberHome = driver.home(memberNative.ownerId, memberName);
      expect(memberVolume).not.toBe(volume); expect(memberHome).not.toBe(profileHome);
      await db.update(schema.hermesTeamProfiles).set({ state: 'connection_needed', binding: memberNative }).where(eq(schema.hermesTeamProfiles.id, memberProfile.id));
      // This separate subprocess calls the pin's real skill/memory functions in
      // the member profile. The foreground conversational loop was tested above.
      await exec(PYTHON, [LAUNCHER, 'private-learning', memberVolume, memberName, String(port), memberNative.identity], { env: nativeEnv });
      const privateBefore = await readFile(path.join(memberHome, 'skills', 'private-notes', 'SKILL.md'), 'utf8');
      const memoryBefore = await readFile(path.join(memberHome, 'memories', 'MEMORY.md'), 'utf8');
      const updates = createMemberUpdateService({
        inventoryResources: async (p, _bot, trackedPackageIds) => {
          expect(p.user.id).toBe('member');
          const fresh = broker.authorizeTeam('member', { teamBotId: 'team', mode: 'member', modelPolicy: 'admin_provided' });
          return broker.inventoryTeamMemberResources('member', { teamBotId: 'team', mode: 'member', trackedPackageIds }, fresh.grantId);
        },
        applyResources: async (p, _bot, input) => {
          expect(p.user.id).toBe('member');
          const fresh = broker.authorizeTeam('member', { teamBotId: 'team', mode: 'member', modelPolicy: 'admin_provided' });
          return broker.applyTeamMemberResources('member', { teamBotId: 'team', mode: 'member', ...input }, fresh.grantId);
        },
        abortResources: async (_p, _bot, input) => {
          const fresh = broker.authorizeTeam('member', { teamBotId: 'team', mode: 'member', modelPolicy: 'admin_provided' });
          return broker.abortTeamMemberResources('member', { teamBotId: 'team', mode: 'member', ...input }, fresh.grantId);
        },
      });
      const install = { expectedInstalledRevision: null, requestId: randomUUID() };
      expect(await updates.update(member, 'team', install)).toMatchObject({ status: 'complete', installedRevision: 1, conflictCount: 0 });
      expect(await updates.update(member, 'team', install)).toMatchObject({ status: 'complete', installedRevision: 1 });
      expect(await readFile(path.join(memberHome, 'skills', 'learned-procedure', 'SKILL.md'), 'utf8')).toBe(IMPROVED);
      expect(await readFile(path.join(memberHome, 'skills', 'private-notes', 'SKILL.md'), 'utf8')).toBe(privateBefore);
      expect(await readFile(path.join(memberHome, 'memories', 'MEMORY.md'), 'utf8')).toBe(memoryBefore);
      expect(memoryBefore).not.toContain('Private working note');
      // Both corrections use native skill_manage. The team revision must preserve
      // the member's changed copy and retain the exact conflict preview hashes.
      await exec(PYTHON, [LAUNCHER, 'correct-team', memberVolume, memberName, String(port), memberNative.identity], { env: nativeEnv });
      await exec(PYTHON, [LAUNCHER, 'revise-working', volume, name, String(port), native.identity], { env: nativeEnv });
      await publish(1);
      expect(await updates.update(member, 'team', { expectedInstalledRevision: 1, requestId: randomUUID() })).toMatchObject({ status: 'complete', installedRevision: 2, conflictCount: 1 });
      expect(await readFile(path.join(memberHome, 'skills', 'learned-procedure', 'SKILL.md'), 'utf8')).toContain('record my private correction');
      const preview = await updates.preview(member, 'team');
      expect(preview.conflicts).toHaveLength(1);
      const conflict = preview.conflicts[0];
      expect(await updates.resolve(member, 'team', { expectedInstalledRevision: 2, targetRevision: 2, requestId: randomUUID(), packageId: conflict.packageId,
        choice: 'use-team', expectedMemberHash: conflict.expectedMemberHash, expectedTeamHash: conflict.expectedTeamHash })).toMatchObject({ status: 'complete', installedRevision: 2, conflictCount: 0 });
      expect(await readFile(path.join(memberHome, 'skills', 'learned-procedure', 'SKILL.md'), 'utf8')).toContain('record the approved team decision');
      expect(await readFile(path.join(memberHome, 'skills', 'private-notes', 'SKILL.md'), 'utf8')).toBe(privateBefore);
      expect(await readFile(path.join(memberHome, 'memories', 'MEMORY.md'), 'utf8')).toBe(memoryBefore);
      expect(await db.select().from(schema.hermesTeamRevisions)).toHaveLength(2);
    } finally {
      await broker.close(); await driver.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(temp, { recursive: true, force: true });
    }
  }, 60_000);
});
