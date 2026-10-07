import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, lstat, rm, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { Principal } from '@/lib/auth/groups';
const fixture = vi.hoisted(() => ({ client: null as PGlite | null, queued: [] as string[] }));
vi.mock('server-only', () => ({}));
// The queue transport is synthetic; scheduling, receipts and worker claims remain production code.
vi.mock('@/lib/jobs', () => ({ enqueueRun: async (run: { id: string }) => { fixture.queued.push(run.id); } }));
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
import { startTeamCandidateRun, settleTeamCandidateRun } from '@/lib/hermes-team/candidate-startup';
import { nativeLearningHandoffHttp } from '@/lib/hermes-team/candidate-learning';
import { claimRun } from '@/lib/runs/state';
import { executeTeamLearningSegment } from '@/lib/runs/team-candidate';
import { startRun, runEvents, getRun, stopRun } from '@/lib/llm/providers/hermes/client';
import { candidateModelHttp, candidateMcpHttp } from '@/lib/hermes-team/candidate-http';
import { candidateWireMetadata } from '@/lib/hermes-team/candidate-wire-metadata';
import { candidateResourceAdapter, candidateResourceAdapterId } from '@/lib/hermes-team/candidate-resource-adapter';
import { candidateToolName, listCandidateApprovals, answerCandidateApproval } from '@/lib/hermes-team/candidate-tools';
import { snapshotHash } from '@/lib/mcp/snapshot';
import { queueTeamAccessReconciliation, reconcileTeamAccess } from '@/lib/hermes-team/revocation';
import { TEAM_MODEL_PURPOSES, type VerifiedTeamModelRoute } from '@/lib/hermes-team/model-policy';
import { sealAppSecret } from '@/lib/llm/secrets';
import { LocalController } from '@/local-hermes/controller';
import { HERMES_COMMIT } from '@/local-hermes/config';
import { DockerBroker } from '@/docker-hermes/broker';
import { BrokerConfig } from '@/docker-hermes/docker';
import { listenBroker } from '@/docker-hermes/main';
import { candidateBootstrap } from '@/docker-hermes/candidate-bundle';
import { NativeRpc } from '@/local-hermes/rpc';
import type { TeamCandidateConfig } from '@/docker-hermes/types';
import { PinnedSourceRuntimeDriver } from '../fixtures/hermes-team-active-driver';
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
async function assertNoNativeSecrets(root: string, secrets: readonly string[]) {
  let files = 0;
  const walk = async (folder: string) => {
    for (const name of await readdir(folder)) {
      const filename = path.join(folder, name), stat = await lstat(filename);
      if (stat.isDirectory()) await walk(filename);
      else if (stat.isFile()) {
        expect(stat.size, filename).toBeLessThan(64 * 1024 * 1024);
        const bytes = await readFile(filename); files++;
        for (const secret of secrets) expect(bytes.includes(Buffer.from(secret)), filename).toBe(false);
      } else throw new Error(`Unexpected native profile entry in the synthetic fixture: ${filename}`);
    }
  };
  await walk(root); expect(files).toBeGreaterThan(4);
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
  vi.stubEnv('HERMES_TEAM_CANDIDATE_RUNTIME_ENABLED', '1');
  vi.stubEnv('HERMES_TEAM_GATEWAY_ORIGIN', 'https://app.test.invalid');
  fixture.queued.length = 0;
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
    const calls: Array<{ contextId: string; purpose: string; body: Record<string, unknown> }> = [];
    const handoffs: Array<{ reviewId: string; snapshot: Record<string, unknown> }> = [];
    const statuses: number[] = [];
    const counts = new Map<string, number>();
    const tool = { name: 'documents.write', inputSchema: { type: 'object' as const, properties: { resourceId: { type: 'string' }, content: { type: 'string' } }, required: ['resourceId', 'content'], additionalProperties: false } };
    const adapterId = candidateResourceAdapterId(tool);
    const adapters = [candidateResourceAdapter('documents', tool, 'write', { id: 'offline-native-tool-only', hermesRevision: HERMES_COMMIT, adapterId, capabilityId: 'documents',
      action: tool.name, effect: 'write', verifiedAt: 1, expiresAt: 4102444800000 })];
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Approved synthetic document update completed.' }] });
    const connect = vi.fn().mockImplementation(async (_server, caller) => {
      expect(caller.subject.id).toBe('admin'); expect(caller.service.server).toBe('company-docs');
      await caller.authorize(); return { callTool, close: async () => {} };
    });
    await db.insert(schema.mcpServers).values({ id: 'company-docs', name: 'Synthetic documents', url: 'https://connector.test.invalid/mcp', status: 'enabled', trust: 'trusted', toolsSnapshot: [tool], toolsHash: snapshotHash([tool]) });
    await configureTeam(admin, 'team', { enabled: true, expectedVersion: 1, maintainerIds: ['admin'], modelPolicy: { mode: 'admin_provided', adminRouteId: route.id },
      toolPolicy: { capabilities: [{ capabilityId: 'documents', connectionMode: 'approved_team_connection', connectionId: 'company-docs', adapterId, action: tool.name,
        resourceIds: ['document-a'], effect: 'write', requireApproval: true }] } });
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
        { name: `mcp__collective_team__${candidateToolName('documents')}`, arguments: { resourceId: 'document-a', content: 'Reviewed synthetic update' } },
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
      const model = /^\/api\/hermes-team\/native\/([^/]+)\/model\/(reply|learning|utility|subagent)\/chat\/completions$/.exec(req.url ?? '');
      const native = /^\/api\/hermes-team\/native\/([^/]+)\/(mcp|learning)$/.exec(req.url ?? '');
      let response: Response;
      if (model) {
        calls.push({ contextId: model[1], purpose: model[2], body: JSON.parse(body.toString()) });
        response = await candidateModelHttp(incoming, { contextId: model[1], purpose: model[2], operation: ['chat', 'completions'] }, { routes: [route], fetch: (_url, init) => provider(model[2], init) });
        statuses.push(response.status);
      } else if (native?.[2] === 'mcp') response = await candidateMcpHttp(incoming, native[1], { routes: [route], adapters, connect });
      else if (native?.[2] === 'learning') { handoffs.push(JSON.parse(body.toString())); response = await nativeLearningHandoffHttp(incoming, native[1], { routes: [route] }); }
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
      network: 'internet', teamBotsEnabled: true, teamCandidateRuntimeEnabled: true }), driver);
    const ipc = await listenBroker(broker);
    vi.stubEnv('DOCKER_HERMES_SOCKET', broker.config.socketPath);
    try {
      const authorization = broker.authorizeTeam('admin', { teamBotId: 'team', mode: 'admin', modelPolicy: 'admin_provided' });
      const native = await broker.ensureTeam('admin', { teamBotId: 'team', mode: 'admin', name: 'Team' }, authorization.grantId);
      const name = native.profile;
      const volume = driver.volume(native.ownerId);
      const profileHome = driver.home(native.ownerId, name);
      await writeFile(path.join(profileHome, 'config.yaml'), JSON.stringify({ skills: { creation_nudge_interval: 1 }, memory: { nudge_interval: 1 } }));
      const chat = await openTeamConversation(admin, 'team', 'admin');
      await db.insert(schema.messages).values({ id: 'source-user-message', conversationId: chat.conversationId, role: 'user',
        parts: [{ type: 'text', text: 'Teach a useful procedure.' }] });
      const profile = await reserveTeamProfile(admin, 'team', 'admin');
      await db.update(schema.hermesTeamProfiles).set({ state: 'ready', binding: native }).where(eq(schema.hermesTeamProfiles.id, profile.id));
      await db.insert(schema.agentRuns).values({ id: 'admin-run', userId: 'admin', botId: 'team', conversationId: chat.conversationId, messageId: 'admin-message' });
      const worker = (await claimRun('admin-run', 'synthetic-native-worker'))!;
      expect(worker).toMatchObject({ status: 'running', holder: 'synthetic-native-worker' });
      const active = await startTeamCandidateRun(admin, 'team', worker.id, { holder: worker.holder!, segment: worker.segment, routes: [route] }).catch(error => { throw new Error(`${String(error)}; synthetic native stderr: ${driver.stderr}`); });
      const contextId = active.contextId;
      const scope = { teamBotId: 'team', mode: 'admin' as const, bindingId: native.bindingId, runId: worker.id, contextId, conversationId: chat.conversationId };
      const fresh = broker.authorizeTeam('admin', { teamBotId: 'team', mode: 'admin', modelPolicy: 'admin_provided' });
      expect(await broker.startTeamCandidate('admin', scope, fresh.grantId)).toMatchObject({ started: true, interruption: 'runtime-wide' });
      expect(driver.launches).toBe(1);
      const access = await broker.forTeamRequest('admin', 'team', 'admin', native.bindingId, fresh.grantId, { runId: scope.runId, contextId });
      controller = access.controller;
      expect(() => controller!.begin(access.nativeBindingId, { input: 'Wrong context', session_id: 'saved-browser-url' }, `portal-${scope.runId}`)).toThrow('another run');
      // Exercise the application client, authenticated proxy and actual Unix-socket broker routes.
      const runId = await startRun(active.target, { input: 'Teach a useful procedure: validate input, record the decision, then report the result.',
        sessionId: `portal-${chat.conversationId}-team`, idempotencyKey: `portal-${scope.runId}` });
      const streamed: string[] = [];
      const stream = (async () => { for await (const event of runEvents(active.target, runId)) streamed.push(event.event); })();
      const approvals = await until(() => listCandidateApprovals(admin, chat.conversationId, { routes: [route], adapters }), value => value.length === 1).catch(error => {
        throw new Error(`${String(error)}; model tool names=${JSON.stringify(calls.flatMap(call => (call.body.tools as Array<{function?:{name?:string}}> | undefined)?.map(tool => tool.function?.name) ?? []))}; native stderr=${driver.stderr}`);
      });
      expect(connect).not.toHaveBeenCalled(); expect(callTool).not.toHaveBeenCalled();
      const wrongHuman = (await loadPrincipal('member'))!;
      await expect(answerCandidateApproval(wrongHuman, approvals[0].id, 'approved', { routes: [route], adapters })).rejects.toMatchObject({ status: 404 });
      await answerCandidateApproval(admin, approvals[0].id, 'approved', { routes: [route], adapters });
      await stream;
      expect(callTool).toHaveBeenCalledOnce();
      expect(callTool.mock.calls[0][0]).toMatchObject({ name: 'documents.write', arguments: { resourceId: 'document-a', content: 'Reviewed synthetic update' } });
      expect((await db.select().from(schema.hermesTeamCandidateApprovals))[0]).toMatchObject({ state: 'consumed' });
      expect(streamed).toContain('tool.completed');
      const result = await until(() => controller!.getRun(runId), value => !['running', 'waiting_for_approval', 'waiting_for_input'].includes(value.status));
      expect(result, driver.stderr).toMatchObject({ status: 'completed', output: 'Learned the useful procedure.' });
      expect(await getRun(active.target, runId)).toMatchObject({ status: 'completed' });
      expect(await readFile(path.join(profileHome, 'skills', 'procedure', 'SKILL.md'), 'utf8')).toBe(SKILL);
      expect(await readFile(path.join(profileHome, 'memories', 'MEMORY.md'), 'utf8')).toContain('Private working note');
      expect(calls.filter(call => call.purpose === 'learning')).toEqual([]);
      expect(handoffs).toHaveLength(1);
      const captured = handoffs[0];
      expect(Object.keys(captured.snapshot).sort()).toEqual(['version', 'messagesSnapshot', 'reviewMemory', 'reviewSkills', 'focus', 'explicit', 'memoryEnabled', 'userProfileEnabled'].sort());
      expect(JSON.stringify(captured)).not.toMatch(/"(?:api_key|modelTokens|credential_pool|client|provider)"/);
      const parentConfig = driver.candidates[0];
      const handoffRequest = (body: unknown) => new Request('https://app.test.invalid/native-learning', { method: 'POST', headers: { 'Content-Type': 'application/json',
        Authorization: `Bearer ${parentConfig.learningToken}` }, body: JSON.stringify(body) });
      expect((await nativeLearningHandoffHttp(handoffRequest(captured), contextId, { routes: [route] })).status).toBe(200);
      expect((await nativeLearningHandoffHttp(handoffRequest({ ...captured, reviewId: randomUUID() }), contextId, { routes: [route] })).status).toBe(409);
      expect(fixture.queued).toEqual([]);
      await db.insert(schema.messages).values({ id: 'admin-message', conversationId: chat.conversationId, role: 'assistant',
        parts: [{ type: 'text', text: result.output }] });
      const sourceMessages = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, chat.conversationId));
      await db.update(schema.agentRuns).set({ status: 'succeeded' }).where(eq(schema.agentRuns.id, worker.id));
      // Terminal reply grants are denied before a new native learning process is admitted.
      const forbidden = new Request('https://app.test.invalid/model', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${parentConfig.modelTokens.reply}` },
        body: JSON.stringify({ model: route.model, messages: [{ role: 'user', content: 'Late parent model request' }] }) });
      expect((await candidateModelHttp(forbidden, { contextId, purpose: 'reply', operation: ['chat', 'completions'] }, { routes: [route], fetch: () => { throw new Error('Terminal parent dispatched'); } })).status).toBe(403);
      expect(await active.retire()).toEqual({ confirmed: true, runtimeWide: true });
      expect(await driver.running(native.ownerId)).toBe(false);
      expect((await db.select().from(schema.hermesTeamCandidateContexts).where(eq(schema.hermesTeamCandidateContexts.id, contextId)))[0])
        .toMatchObject({ retirementState: 'confirmed', nativeStoppedAt: expect.any(Date), revokedAt: expect.any(Date) });
      expect(fixture.queued).toEqual([]);
      // The worker's terminal hook, rather than native retirement itself, queues the child.
      await settleTeamCandidateRun(worker.id, true, [route]);
      expect(fixture.queued).toHaveLength(1);
      const childRunId = fixture.queued[0];
      const child = (await claimRun(childRunId, 'synthetic-native-learning-worker'))!;
      const learning = await startTeamCandidateRun(admin, 'team', child.id, { holder: child.holder!, segment: child.segment, routes: [route] });
      expect(learning.contextId).not.toBe(contextId); expect(driver.launches).toBe(2);
      expect(driver.candidates[1].runPurpose).toBe('learning');
      expect(driver.candidates[1].learningToken).toBeUndefined();
      expect(driver.candidates[1].modelTokens.learning).not.toBe(parentConfig.modelTokens.learning);
      expect(await active.retire()).toEqual({ confirmed: true, runtimeWide: true });
      expect(await driver.running(native.ownerId)).toBe(true);
      // Execute the production worker's native learning segment and its terminal hook.
      // This performs the dedicated native RPC, polls settlement, confirms Stop,
      // then finalizes the durable child without inserting a visible chat reply.
      await executeTeamLearningSegment(child, child.holder!, learning, new AbortController());
      const [finishedChild] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, childRunId));
      expect(finishedChild, `${driver.stderr}; purposes=${JSON.stringify(calls.map(call => call.purpose))}; statuses=${JSON.stringify(statuses)}; native errors=${JSON.stringify(driver.nativeErrors)}`)
        .toMatchObject({ status: 'succeeded', background: true });
      await settleTeamCandidateRun(childRunId, true, [route]);
      expect(await db.select().from(schema.messages).where(eq(schema.messages.conversationId, chat.conversationId))).toEqual(sourceMessages);
      const [childContext] = await db.select().from(schema.hermesTeamCandidateContexts).where(eq(schema.hermesTeamCandidateContexts.id, learning.contextId));
      expect(childContext).toMatchObject({ retirementState: 'confirmed', nativeStoppedAt: expect.any(Date), revokedAt: expect.any(Date) });
      expect(childContext.nativeStoppedAt!.getTime()).toBeLessThanOrEqual(finishedChild.finishedAt!.getTime());
      expect(await readFile(path.join(profileHome, 'skills', 'learned-procedure', 'SKILL.md'), 'utf8'), driver.stderr).toBe(IMPROVED);
      expect(await readFile(path.join(profileHome, 'skills', 'procedure', 'SKILL.md'), 'utf8')).toBe(SKILL);
      expect(calls.filter(call => call.purpose !== 'utility').map(call => call.purpose)).toEqual(['reply', 'reply', 'learning', 'learning', 'learning', 'learning', 'learning']);
      expect(statuses).toHaveLength(8); expect(statuses.every(status => status === 200)).toBe(true);
      expect(calls.filter(call => call.purpose === 'learning').every(call => call.contextId === learning.contextId)).toBe(true);
      expect(calls.filter(call => call.purpose === 'utility').map(call => Object.keys(call.body)))
        .toEqual([['messages', 'model', 'response_format', 'reasoning']]);
      expect(await readFile(path.join(profileHome, 'state.db'))).not.toHaveLength(0);
      expect(await learning.retire()).toEqual({ confirmed: true, runtimeWide: true });
      expect((await db.select().from(schema.hermesTeamLearningHandoffs))[0]).toMatchObject({ state: 'complete', childRunId });
      expect(handoffs).toHaveLength(1); expect(fixture.queued).toHaveLength(1);
      expect(await driver.running(native.ownerId)).toBe(false);
      await assertNoNativeSecrets(profileHome, ['synthetic-never-live-provider-key', ...driver.candidates.flatMap(config =>
        [...Object.values(config.modelTokens), config.toolToken, ...(config.learningToken ? [config.learningToken] : [])])]);
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
      await ipc.close(); await driver.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(temp, { recursive: true, force: true });
    }
  }, 60_000);
  it('rejects a source-hash mismatch and sibling native gateways before model transport; Stop releases the runtime lock', async () => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'hermes-team-native-lock-'));
    let requests = 0;
    let requestErrors = 0;
    const metadata: Array<{ path: string; method: string; rpcMethod: string | null; jsonRpc: boolean; bytes: number; expectedToolGrant: boolean; denied: boolean }> = [];
    // Native entry starts asynchronous MCP discovery before gateway.ready: the
    // pinned transport probes HEAD, then attempts initialize after a 403. This
    // server always denies requests and has no model or company connector handler.
    // Keep diagnostics bounded and never capture bodies or opaque grant values.
    const server = createServer((req, res) => {
      requests++;
      if (requests > 16) { res.writeHead(403); res.end(); return; }
      const record = { path: (req.url ?? '').slice(0, 256), method: (req.method ?? '').slice(0, 16), rpcMethod: null as string | null,
        jsonRpc: false, bytes: 0, expectedToolGrant: req.headers.authorization === `Bearer ${'e'.repeat(64)}`, denied: false };
      metadata.push(record);
      res.on('finish', () => { record.denied = true; });
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          record.bytes += chunk.length;
          if (record.bytes > 4096) throw new Error('Bounded synthetic request exceeded');
          chunks.push(Buffer.from(chunk));
        }
        if (record.bytes) {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          record.rpcMethod = typeof body.method === 'string' ? body.method.slice(0, 64) : '<invalid>';
          record.jsonRpc = body.jsonrpc === '2.0';
        }
        res.writeHead(403); res.end();
      })().catch(() => { requestErrors++; res.writeHead(403); res.end(); });
    });
    const assertDeniedDiscovery = async (offset: number) => {
      await until(() => metadata.slice(offset), records => records.some(record => record.rpcMethod === 'initialize' && record.denied), 15_000);
      expect(requestErrors).toBe(0);
      expect(requests).toBe(offset + 2);
      expect(metadata.slice(offset)).toEqual([
        { path: '/mcp', method: 'HEAD', rpcMethod: null, jsonRpc: false, bytes: 0, expectedToolGrant: true, denied: true },
        { path: '/mcp', method: 'POST', rpcMethod: 'initialize', jsonRpc: true, bytes: expect.any(Number), expectedToolGrant: true, denied: true },
      ]);
      expect(metadata[offset + 1].bytes).toBeGreaterThan(0);
      expect(metadata[offset + 1].bytes).toBeLessThanOrEqual(4096);
      // Includes all four model-purpose routes, tools/call and unknown endpoints.
      expect(metadata.filter(record => record.path !== '/mcp' || (record.method !== 'HEAD' && record.rpcMethod !== 'initialize'))).toEqual([]);
    };
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const driver = new PinnedSourceRuntimeDriver(temp, SOURCE!, path.resolve(PYTHON), port);
    let rpc: NativeRpc | undefined;
    const rawChildren = new Set<ChildProcessWithoutNullStreams>();
    const stopped = async (child: ChildProcessWithoutNullStreams) => {
      child.stdin.on('error', () => {});
      let stderr = ''; child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-16_000); });
      const code = await until(() => child.exitCode ?? (child.signalCode ? -1 : null), code => code !== null, 15_000);
      expect(code).not.toBe(0); return stderr;
    };
    try {
      await driver.ensure('member', () => {});
      const first = await driver.createTeam('member', `cui-team-${'a'.repeat(32)}`);
      const second = await driver.createTeam('member', `cui-team-${'b'.repeat(32)}`);
      const config: TeamCandidateConfig = { teamBotId: 'team', mode: 'member', bindingId: 'c'.repeat(32), runId: 'run', contextId: 'context', expiresAt: Date.now() + 120_000,
        model: route.model, adapterId: 'collective-openai-chat-v1',
        modelBaseUrls: { reply: 'https://app.test.invalid/model/reply', learning: 'https://app.test.invalid/model/learning', utility: 'https://app.test.invalid/model/utility', subagent: 'https://app.test.invalid/model/subagent' },
        modelTokens: { reply: 'a'.repeat(64), learning: 'b'.repeat(64), utility: 'c'.repeat(64), subagent: 'd'.repeat(64) }, toolUrl: 'https://app.test.invalid/mcp', toolToken: 'e'.repeat(64) };
      const start = (mode: string, profile: string, identity: string, bootstrap?: string) => {
        const child = spawn(PYTHON, ['-u', LAUNCHER, mode, driver.volume('member'), profile, String(port), identity], { env: nativeEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
        rawChildren.add(child); child.stdin.on('error', () => {}); if (bootstrap) child.stdin.write(bootstrap); return child;
      };
      const tampered = JSON.parse(candidateBootstrap(config));
      tampered.contract.sourceHashes['run_agent.py'] = '0'.repeat(64);
      expect(await stopped(start('gateway', first.name, first.identity, JSON.stringify(tampered) + '\n'))).toContain('do not match the pinned source');
      expect(requests).toBe(0);
      const stateDir = path.join(temp, 'rpc-state'); await mkdir(stateDir);
      const home = driver.home('member', first.name);
      rpc = new NativeRpc({ trust: 'single-user-exclusive-profile', source: SOURCE!, python: path.resolve(PYTHON), profileHome: home,
        accountHome: path.join(home, 'home'), workDir: path.join(home, 'workspace'), stateDir, socketPath: path.join(temp, 'unused.sock'), label: 'Synthetic native lock' },
        () => {}, () => {}, () => {}, driver.candidateTransport('member', first.name, first.identity, config));
      await rpc.start().catch(error => { throw new Error(`${String(error)}; synthetic native stderr: ${driver.stderr}`); });
      await assertDeniedDiscovery(0);
      const beforeSiblings = requests;
      expect(await stopped(start('gateway', second.name, second.identity, candidateBootstrap(config)))).toContain('Resource temporarily unavailable');
      const personal = (await driver.profiles('member')).find(profile => profile.name === 'default')!;
      expect(await stopped(start('personal-gateway', personal.name, personal.identity))).toContain('Resource temporarily unavailable');
      await rpc.call('ping'); expect(requests).toBe(beforeSiblings);
      await assertDeniedDiscovery(0);
      await rpc.stop(); expect(await driver.running('member')).toBe(false);
      expect(requests).toBe(beforeSiblings);
      await driver.reopen('member');
      const reopened = driver.candidateTransport('member', second.name, second.identity, config);
      const next = new NativeRpc({ trust: 'single-user-exclusive-profile', source: SOURCE!, python: path.resolve(PYTHON), profileHome: driver.home('member', second.name),
        accountHome: path.join(home, 'home'), workDir: path.join(home, 'workspace'), stateDir: path.join(temp, 'next-state'), socketPath: path.join(temp, 'unused.sock'), label: 'Synthetic second native lock' },
        () => {}, () => {}, () => {}, reopened);
      rpc = next; await rpc.start(); await rpc.call('ping');
      await assertDeniedDiscovery(beforeSiblings);
      await rpc.stop(); expect(await driver.running('member')).toBe(false);
      expect(requests).toBe(beforeSiblings + 2);
      expect(requestErrors).toBe(0);
    } finally {
      await rpc?.stop(); await driver.close();
      for (const child of rawChildren) if (child.exitCode === null && child.signalCode === null && child.pid) process.kill(-child.pid, 'SIGKILL');
      await new Promise<void>(resolve => server.close(() => resolve())); await rm(temp, { recursive: true, force: true });
    }
  }, 45_000);

  it.each(['approval-revocation', 'held-model-stop'] as const)('settles actual native %s without connector continuation, retries or private-data deletion', async scenario => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'hermes-team-native-stop-'));
    const member = (await loadPrincipal('member'))!;
    const tool = { name: 'documents.write', inputSchema: { type: 'object' as const, properties: { resourceId: { type: 'string' } }, required: ['resourceId'], additionalProperties: false } };
    const adapterId = candidateResourceAdapterId(tool);
    const adapters = [candidateResourceAdapter('documents', tool, 'write', { id: 'offline-native-stop-only', hermesRevision: HERMES_COMMIT, adapterId, capabilityId: 'documents',
      action: tool.name, effect: 'write', verifiedAt: 1, expiresAt: 4102444800000 })];
    await db.insert(schema.mcpServers).values({ id: 'company-docs', name: 'Synthetic documents', url: 'https://connector.test.invalid/mcp', status: 'enabled', trust: 'trusted', toolsSnapshot: [tool], toolsHash: snapshotHash([tool]) });
    await configureTeam(admin, 'team', { enabled: true, expectedVersion: 1, maintainerIds: ['admin'], modelPolicy: { mode: 'admin_provided', adminRouteId: route.id },
      toolPolicy: { capabilities: [{ capabilityId: 'documents', connectionMode: 'approved_team_connection', connectionId: 'company-docs', adapterId, action: tool.name,
        resourceIds: ['document-a'], effect: 'write', requireApproval: true }] } });
    const connect = vi.fn().mockRejectedValue(new Error('An interrupted native action must never connect'));
    let modelRequests = 0, providerAborted = false;
    const provider = async (_url: RequestInfo | URL, init?: RequestInit) => {
      modelRequests++;
      if (scenario === 'held-model-stop') return new Promise<Response>((_resolve, reject) => {
        const aborted = () => { providerAborted = true; reject(new Error('Synthetic provider request cancelled')); };
        if (init?.signal?.aborted) aborted(); else init?.signal?.addEventListener('abort', aborted, { once: true });
      });
      return completion([{ name: 'memory', arguments: { action: 'add', target: 'memory', content: 'Private member memory remains after audience removal.' } },
        { name: `mcp__collective_team__${candidateToolName('documents')}`, arguments: { resourceId: 'document-a' } }]);
    };
    const server = createServer((req, res) => { void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const disconnected = new AbortController(); req.once('aborted', () => disconnected.abort()); res.once('close', () => { if (!res.writableEnded) disconnected.abort(); });
      const incoming = new Request(`http://127.0.0.1${req.url}`, { method: 'POST', headers: new Headers(req.headers as Record<string, string>), body: Buffer.concat(chunks), signal: disconnected.signal });
      const model = /^\/api\/hermes-team\/native\/([^/]+)\/model\/(reply|learning|utility|subagent)\/chat\/completions$/.exec(req.url ?? '');
      const mcp = /^\/api\/hermes-team\/native\/([^/]+)\/mcp$/.exec(req.url ?? '');
      const response = model ? await candidateModelHttp(incoming, { contextId: model[1], purpose: model[2], operation: ['chat', 'completions'] }, { routes: [route], fetch: provider })
        : mcp ? await candidateMcpHttp(incoming, mcp[1], { routes: [route], adapters, connect }) : new Response(null, { status: 404 });
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
    })().catch(error => { if (!res.destroyed) { res.writeHead(500); res.end(String(error)); } }); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await mkdir(path.join(temp, 'state')); await mkdir(path.join(temp, 'ipc'));
    const driver = new PinnedSourceRuntimeDriver(temp, SOURCE!, path.resolve(PYTHON), port);
    const broker = new DockerBroker(BrokerConfig.parse({ stateDir: path.join(temp, 'state'), socketPath: path.join(temp, 'ipc', 'fixture.sock'), bridgePath: path.resolve('src/docker-hermes/bridge.py'),
      namespace: 'cui-stop-test', image: 'nousresearch/hermes-agent@sha256:2fd023efbb8d3d2b0ce1a73d028b07370cff34f567cfe0e999553e8c327ea283',
      network: 'internet', teamBotsEnabled: true, teamCandidateRuntimeEnabled: true }), driver);
    const ipc = await listenBroker(broker); vi.stubEnv('DOCKER_HERMES_SOCKET', broker.config.socketPath);
    let drain: Promise<unknown> | undefined;
    try {
      const grant = broker.authorizeTeam('member', { teamBotId: 'team', mode: 'member', modelPolicy: 'admin_provided' });
      const native = await broker.ensureTeam('member', { teamBotId: 'team', mode: 'member', name: 'Team' }, grant.grantId);
      const profile = await reserveTeamProfile(member, 'team', 'member');
      const chat = await openTeamConversation(member, 'team', 'member');
      await db.update(schema.hermesTeamProfiles).set({ state: 'ready', binding: native }).where(eq(schema.hermesTeamProfiles.id, profile.id));
      const home = driver.home(native.ownerId, native.profile);
      await writeFile(path.join(home, 'config.yaml'), JSON.stringify({ memory: { nudge_interval: 1000 }, skills: { creation_nudge_interval: 1000 } }));
      await db.insert(schema.agentRuns).values({ id: 'interrupt-run', userId: 'member', botId: 'team', conversationId: chat.conversationId, messageId: 'interrupt-message' });
      const worker = (await claimRun('interrupt-run', 'synthetic-native-worker'))!;
      const active = await startTeamCandidateRun(member, 'team', worker.id, { holder: worker.holder!, segment: worker.segment, routes: [route] });
      const runId = await startRun(active.target, { input: 'Review a scoped document update.', sessionId: `portal-${chat.conversationId}-team`, idempotencyKey: `portal-${worker.id}` });
      // Attach an error handler immediately; revoked streams may close with an authorization error.
      drain = (async () => { for await (const event of runEvents(active.target, runId)) { expect(typeof event.event).toBe('string'); } })().catch(error => error);
      await until(() => modelRequests, count => count === 1);
      if (scenario === 'approval-revocation') {
        const approvals = await until(() => listCandidateApprovals(member, chat.conversationId, { routes: [route], adapters }), rows => rows.length === 1);
        expect(connect).not.toHaveBeenCalled();
        await db.transaction(async tx => {
          await tx.delete(schema.botUserAccess).where(eq(schema.botUserAccess.userId, 'member'));
          await queueTeamAccessReconciliation(tx, 'team', 'admin', { reason: 'audience_changed', scopeUserId: 'member', mutationId: randomUUID() });
        });
        await reconcileTeamAccess('team');
        await expect(answerCandidateApproval(member, approvals[0].id, 'approved', { routes: [route], adapters })).rejects.toBeDefined();
        expect((await db.select().from(schema.hermesTeamCandidateApprovals))[0]).toMatchObject({ state: 'pending' });
        expect((await db.select().from(schema.hermesTeamOperations)).filter(row => row.kind === 'revoke')).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'complete' })]));
        expect(await readFile(path.join(home, 'memories', 'MEMORY.md'), 'utf8')).toContain('Private member memory remains');
      } else {
        await stopRun(active.target, runId);
        await until(() => getRun(active.target, runId), state => ['cancelled', 'interrupted', 'failed'].includes(state.status), 12_000);
        await db.update(schema.agentRuns).set({ status: 'cancelled', cancelRequestedAt: new Date() }).where(eq(schema.agentRuns.id, worker.id));
      }
      expect(await active.retire()).toEqual({ confirmed: true, runtimeWide: true });
      expect(await driver.running(native.ownerId)).toBe(false);
      if (scenario === 'held-model-stop') await until(() => providerAborted, aborted => aborted);
      await drain;
      expect(modelRequests).toBe(1); expect(connect).not.toHaveBeenCalled(); expect(driver.launches).toBe(1);
      expect(await readFile(path.join(home, 'state.db'))).not.toHaveLength(0);
      expect((await driver.profiles(native.ownerId)).find(row => row.name === native.profile)?.identity).toBe(native.identity);
      expect(await db.select().from(schema.hermesTeamLearningHandoffs)).toEqual([]); expect(fixture.queued).toEqual([]);
      await expect(startRun(active.target, { input: 'Late saved URL replay', sessionId: `portal-${chat.conversationId}-team`, idempotencyKey: `portal-${worker.id}` })).rejects.toBeDefined();
      expect(modelRequests).toBe(1);
    } finally {
      await ipc.close(); await driver.close(); await drain;
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(temp, { recursive: true, force: true });
    }
  }, 45_000);

});
