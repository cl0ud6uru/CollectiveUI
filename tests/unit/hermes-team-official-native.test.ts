import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, lstat, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { Principal } from '@/lib/auth/groups';
const fixture = vi.hoisted(() => ({ client: null as PGlite | null, queued: [] as string[] }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/jobs', () => ({ enqueueRun: async (run: { id: string }) => { fixture.queued.push(run.id); } }));
vi.mock('@/db', async () => {
  const { PGlite } = await import('@electric-sql/pglite'), { drizzle } = await import('drizzle-orm/pglite'), schema = await import('@/db/schema');
  fixture.client = new PGlite(); return { db: drizzle(fixture.client, { schema }), schema };
});
import { db, schema } from '@/db';
import { loadPrincipal } from '@/lib/auth/groups';
import { configureTeam, reserveTeamProfile } from '@/lib/hermes-team/store';
import { openTeamConversation } from '@/lib/hermes-team/conversations';
import { candidateWireMetadata } from '@/lib/hermes-team/candidate-wire-metadata';
import { candidateModelHttp, candidateMcpHttp } from '@/lib/hermes-team/candidate-http';
import { startTeamCandidateRun, settleTeamCandidateRun } from '@/lib/hermes-team/candidate-startup';
import { nativeLearningHandoffHttp } from '@/lib/hermes-team/candidate-learning';
import { storeVerifiedOfficialPlanGrant, OFFICIAL_PLAN_ADAPTER, OFFICIAL_PLAN_ORIGIN } from '@/lib/hermes-team/official-plan';
import { TEAM_MODEL_PURPOSES, type VerifiedTeamModelRoute } from '@/lib/hermes-team/model-policy';
import { claimRun } from '@/lib/runs/state';
import { executeTeamLearningSegment } from '@/lib/runs/team-candidate';
import { startRun, runEvents, getRun } from '@/lib/llm/providers/hermes/client';
import { sealAppSecret } from '@/lib/llm/secrets';
import { DockerBroker } from '@/docker-hermes/broker';
import { BrokerConfig } from '@/docker-hermes/docker';
import { listenBroker } from '@/docker-hermes/main';
import { HERMES_COMMIT } from '@/local-hermes/config';
import { PinnedSourceRuntimeDriver } from '../fixtures/hermes-team-active-driver';

const SOURCE = process.env.HERMES_SOURCE;
const PYTHON = process.env.HERMES_TEAM_CANDIDATE_PYTHON ?? 'python';
const route: VerifiedTeamModelRoute = { id: 'official-source-only', adapterId: OFFICIAL_PLAN_ADAPTER, model: 'synthetic-model',
  billing: 'personal', integration: 'openai_chatgpt_plan_usage', credentialHandling: 'server_gateway', limitContract: 'local_only',
  evidence: { id: 'offline-source-only', hermesRevision: HERMES_COMMIT, adapterId: OFFICIAL_PLAN_ADAPTER, model: 'synthetic-model',
    integration: 'openai_chatgpt_plan_usage', purposes: TEAM_MODEL_PURPOSES, verifiedAt: 1, expiresAt: 4102444800000 } };
const skill = (owner: string, name = `${owner}-procedure`) => `---\nname: ${name}\ndescription: A synthetic procedure for ${owner}.\n---\n\nValidate input and record the decision for ${owner}.\n`;

function officialStream(tools: Array<{ name: string; args: Record<string, unknown> }>, text: string) {
  const id = `resp_${Math.random().toString(16).slice(2)}`;
  const output: Array<Record<string, unknown>> = tools.map((tool, index) => ({ type: 'function_call', id: `fc_${id}_${index}`,
    call_id: `call_${id}_${index}`, namespace: 'collective_native', name: tool.name, arguments: JSON.stringify(tool.args), status: 'completed' }));
  if (text) output.push({ type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] });
  // Native Responses assembles authoritative item.done events rather than only
  // reading completed.response.output. Exercise both forms of the real protocol.
  const events: Record<string, unknown>[] = output.flatMap((item, index) => [
    { type: 'response.output_item.added', output_index: index, item: { ...item, status: 'in_progress' } },
    ...(item.type === 'message' ? [{ type: 'response.output_text.delta', item_id: item.id, output_index: index, content_index: 0, delta: text }] : []),
    { type: 'response.output_item.done', output_index: index, item },
  ]);
  events.push({ type: 'response.completed', response: { id, object: 'response', model: route.model, status: 'completed', output,
    usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } } });
  return new Response(events.map((event, index) => `data: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`).join(''),
    { headers: { 'Content-Type': 'text/event-stream' } });
}
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean) {
  const deadline = Date.now() + 15_000;
  for (;;) { const value = await read(); if (done(value)) return value;
    if (Date.now() >= deadline) throw new Error(`Synthetic official native wait timed out: ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 50)); }
}
async function noNativeSecrets(root: string, values: readonly string[]) {
  for (const name of await readdir(root)) {
    const filename = path.join(root, name), stat = await lstat(filename);
    if (stat.isDirectory()) await noNativeSecrets(filename, values);
    else if (stat.isFile()) { expect(stat.size).toBeLessThan(64 * 1024 * 1024); const bytes = await readFile(filename);
      for (const value of values) expect(bytes.includes(Buffer.from(value)), filename).toBe(false); }
    else throw new Error('Unexpected synthetic native profile entry');
  }
}
let admin: Principal, alice: Principal, bob: Principal;
beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync('src/db/migrations').filter(file => file.endsWith('.sql')).sort())
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, 'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;', '').replace(/\bvector\b/g, 'real[]'));
}, 45_000);
beforeEach(async () => {
  vi.stubEnv('HERMES_TEAM_BOTS_ENABLED', '1'); vi.stubEnv('AUTH_URL', 'https://app.test.invalid');
  vi.stubEnv('HERMES_TEAM_CANDIDATE_RUNTIME_ENABLED', '1'); vi.stubEnv('HERMES_TEAM_GATEWAY_ORIGIN', 'https://app.test.invalid');
  vi.stubEnv('ENCRYPTION_KEY', 'synthetic-official-native-only'); fixture.queued.length = 0;
  await fixture.client!.exec('TRUNCATE users,ai_apps,groups,mcp_servers CASCADE');
  await db.insert(schema.users).values([{ id: 'admin', upn: 'admin@test.invalid', name: 'Admin', isAdmin: true, authSource: 'local' as const, identityRealm: 'local' as const },
    ...['alice', 'bob'].map(id => ({ id, upn: `${id}@test.invalid`, name: id, authSource: 'local' as const, identityRealm: 'local' as const }))]);
  admin = (await loadPrincipal('admin'))!; alice = (await loadPrincipal('alice'))!; bob = (await loadPrincipal('bob'))!;
  await db.insert(schema.aiApps).values({ id: 'company', name: 'Never dispatch this company fallback', provider: 'openai-compatible', model: route.model,
    credentialMode: 'org', baseUrl: 'https://company.test.invalid/v1', apiKeyEnc: sealAppSecret('company', 'synthetic-company-fallback-forbidden') });
  await db.insert(schema.bots).values({ id: 'team', ownerId: 'admin', appId: 'company', name: 'Team', visibility: 'groups' });
  await db.insert(schema.botUserAccess).values([{ botId: 'team', userId: 'alice' }, { botId: 'team', userId: 'bob' }]);
  await configureTeam(admin, 'team', { enabled: true, expectedVersion: 0, maintainerIds: ['admin'],
    modelPolicy: { mode: 'personal_required', personalRouteId: route.id, personalWorkspaceId: 'synthetic-work', adminRouteId: 'app:company' } });
  for (const owner of [alice, bob]) {
    const access = `synthetic-${owner.user.id}-official-access`;
    await storeVerifiedOfficialPlanGrant(owner, { clientId: 'synthetic-client', hostId: `synthetic-host-${owner.user.id}`, subject: `synthetic-subject-${owner.user.id}`,
      access, refresh: `synthetic-${owner.user.id}-refresh`, provenance: { ownerId: owner.user.id, clientId: 'synthetic-client', subject: `synthetic-subject-${owner.user.id}`, workspaceId: 'synthetic-work', sourceHostId: `source-${owner.user.id}`, destinationHostId: `synthetic-host-${owner.user.id}`, transportId: 'synthetic-transfer', handoffId: 'synthetic-native-fixture', refreshOwner: 'collective_vm', verifiedAt: Date.now(), expiresAt: Date.now() + 86400000 } }, {
      verifyAccessToken: async token => { expect(token).toBe(access); return { issuer: 'https://auth.openai.com', audience: OFFICIAL_PLAN_ORIGIN,
        subject: `synthetic-subject-${owner.user.id}`, clientId: 'synthetic-client', scopes: ['chatgpt.tokens.use.direct', 'resource.invoke'],
        issuedAt: Date.now() - 1000, notBefore: Date.now() - 1000, expiresAt: Date.now() + 3500000 }; },
      fetch: async (url, init) => { expect(String(url)).toBe(`${OFFICIAL_PLAN_ORIGIN}/models`);
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${access}`); expect(init?.redirect).toBe('error');
        return Response.json({ models: [{ slug: route.model, display_name: route.model, visibility: 'list' }] }); },
    });
  }
  route.transportHash = (await candidateWireMetadata(alice, route)).hash;
  expect((await candidateWireMetadata(bob, route)).hash).toBe(route.transportHash);
  expect((await candidateWireMetadata(bob, route)).personalBindingHash).not.toBe((await candidateWireMetadata(alice, route)).personalBindingHash);
}, 15_000);
afterAll(async () => { await fixture.client!.close(); vi.unstubAllEnvs(); });

describe.skipIf(!SOURCE)('actual pinned official Responses native lifecycle, synthetic owner accounts only', () => {
  it.each(['alice', 'bob'] as const)('uses %s own gateway for native tools, title, delegate and a separately attributed learning child', async ownerId => {
    const owner = ownerId === 'alice' ? alice : bob;
    const temp = await mkdtemp(path.join(os.tmpdir(), 'hermes-team-official-native-'));
    const calls: Array<{ purpose: string; operation: string; body: Record<string, unknown> }> = [];
    const statuses: number[] = [], counts = new Map<string, number>();
    const upstream: Array<{ purpose: string; body: Record<string, unknown> }> = [];
    const provider = async (purpose: string, url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe(`${OFFICIAL_PLAN_ORIGIN}/responses`); expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer synthetic-${ownerId}-official-access`);
      const body = JSON.parse(String(init?.body)); upstream.push({ purpose, body });
      expect(body).toMatchObject({ model: route.model, store: false, stream: true }); expect(body).not.toHaveProperty('max_output_tokens');
      const count = counts.get(purpose) ?? 0; counts.set(purpose, count + 1);
      if (purpose === 'utility') { expect(body.text.format).toMatchObject({ type: 'json_schema' });
        return officialStream([], JSON.stringify({ title: `Synthetic ${ownerId} procedure` })); }
      expect(body.tools).toEqual([expect.objectContaining({ type: 'namespace', name: 'collective_native' })]);
      if (purpose === 'subagent') {
        expect(JSON.stringify(body.input)).toContain(`Return a synthetic summary for ${ownerId}.`);
        return officialStream([], `Native subagent for ${ownerId} completed.`);
      }
      if (purpose === 'reply' && count === 0) return officialStream([
        { name: 'skill_manage', args: { operations: [{ action: 'create', name: `${ownerId}-procedure`, content: skill(ownerId) }] } },
        { name: 'memory', args: { action: 'add', target: 'memory', content: `Private ${ownerId} native learning.` } },
        { name: 'delegate_task', args: { tasks: [{ goal: `Return a synthetic summary for ${ownerId}.` }] } },
      ], '');
      if (purpose === 'learning' && count === 0) return officialStream([
        { name: 'skill_manage', args: { operations: [{ action: 'create', name: `${ownerId}-learned`, content: skill(ownerId, `${ownerId}-learned`) }] } },
      ], '');
      expect((body.input as Array<{ type?: string }>).some(item => item.type === 'function_call_output')).toBe(true);
      expect((body.input as Array<{ type?: string; namespace?: string }>).filter(item => item.type === 'function_call').every(item => item.namespace === 'collective_native')).toBe(true);
      return officialStream([], purpose === 'learning' ? 'Native review completed.' : `Learned the ${ownerId} procedure.`);
    };
    const forbiddenConnector = async () => { throw new Error('No company or personal connector is configured in this fixture'); };
    const server = createServer((req, res) => { void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const bytes = Buffer.concat(chunks);
      const disconnected = new AbortController(); req.once('aborted', () => disconnected.abort());
      res.once('close', () => { if (!res.writableEnded) disconnected.abort(); });
      const request = new Request(`http://127.0.0.1${req.url}`, { method: 'POST', headers: new Headers(req.headers as Record<string, string>), body: bytes, signal: disconnected.signal });
      const model = /^\/api\/hermes-team\/native\/([^/]+)\/model\/(reply|learning|utility|subagent)\/(responses|chat\/completions)$/.exec(req.url ?? '');
      const native = /^\/api\/hermes-team\/native\/([^/]+)\/(mcp|learning)$/.exec(req.url ?? '');
      let response: Response;
      if (model) {
        calls.push({ purpose: model[2], operation: model[3], body: JSON.parse(bytes.toString()) });
        response = await candidateModelHttp(request, { contextId: model[1], purpose: model[2], operation: model[3].split('/') },
          { routes: [route], fetch: (url, init) => provider(model[2], url, init) }); statuses.push(response.status);
      } else if (native?.[2] === 'mcp') response = await candidateMcpHttp(request, native[1], { routes: [route], adapters: [], connect: forbiddenConnector, connectMember: forbiddenConnector });
      else if (native?.[2] === 'learning') response = await nativeLearningHandoffHttp(request, native[1], { routes: [route] });
      else response = new Response(null, { status: 404 });
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
    })().catch(error => { if (!res.destroyed) { res.writeHead(500); res.end(String(error)); } }); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const port = (server.address() as { port: number }).port;
    await mkdir(path.join(temp, 'state')); await mkdir(path.join(temp, 'ipc'));
    const driver = new PinnedSourceRuntimeDriver(temp, SOURCE!, path.resolve(PYTHON), port);
    const broker = new DockerBroker(BrokerConfig.parse({ stateDir: path.join(temp, 'state'), socketPath: path.join(temp, 'ipc', 'fixture.sock'),
      bridgePath: path.resolve('src/docker-hermes/bridge.py'), namespace: 'cui-official-test',
      image: 'nousresearch/hermes-agent@sha256:2fd023efbb8d3d2b0ce1a73d028b07370cff34f567cfe0e999553e8c327ea283',
      network: 'internet', teamBotsEnabled: true, teamCandidateRuntimeEnabled: true }), driver);
    const ipc = await listenBroker(broker); vi.stubEnv('DOCKER_HERMES_SOCKET', broker.config.socketPath);
    try {
      const grant = broker.authorizeTeam(ownerId, { teamBotId: 'team', mode: 'member', modelPolicy: 'personal_required' });
      const native = await broker.ensureTeam(ownerId, { teamBotId: 'team', mode: 'member', name: 'Team' }, grant.grantId);
      const home = driver.home(native.ownerId, native.profile), chat = await openTeamConversation(owner, 'team', 'member');
      const profile = await reserveTeamProfile(owner, 'team', 'member');
      await db.update(schema.hermesTeamProfiles).set({ state: 'ready', binding: native }).where(eq(schema.hermesTeamProfiles.id, profile.id));
      await writeFile(path.join(home, 'config.yaml'), JSON.stringify({ skills: { creation_nudge_interval: 1 }, memory: { nudge_interval: 1 } }));
      await db.insert(schema.agentRuns).values({ id: `${ownerId}-run`, userId: ownerId, botId: 'team', conversationId: chat.conversationId, messageId: `${ownerId}-reply` });
      const worker = (await claimRun(`${ownerId}-run`, 'synthetic-official-worker'))!;
      const active = await startTeamCandidateRun(owner, 'team', worker.id, { holder: worker.holder!, segment: worker.segment, routes: [route] });
      const [account] = await db.select().from(schema.officialPlanConnections).where(eq(schema.officialPlanConnections.userId, ownerId));
      const [parentContext] = await db.select().from(schema.hermesTeamCandidateContexts).where(eq(schema.hermesTeamCandidateContexts.id, active.contextId));
      expect(parentContext).toMatchObject({ actorId: ownerId, personalConnectionId: account.id,
        personalBindingHash: (await candidateWireMetadata(owner, route)).personalBindingHash });
      const runId = await startRun(active.target, { input: `Learn a useful procedure for ${ownerId}.`, sessionId: `portal-${chat.conversationId}-team`, idempotencyKey: `portal-${worker.id}` });
      for await (const event of runEvents(active.target, runId)) expect(typeof event.event).toBe('string');
      const result = await getRun(active.target, runId);
      expect(result, `${JSON.stringify(calls.map(call => ({ purpose: call.purpose, operation: call.operation, keys: Object.keys(call.body) })))}; statuses=${JSON.stringify(statuses)}; ${JSON.stringify(driver.nativeErrors)}; ${driver.stderr}`)
        .toMatchObject({ status: 'completed', output: `Learned the ${ownerId} procedure.` });
      expect(await readFile(path.join(home, 'skills', `${ownerId}-procedure`, 'SKILL.md'), 'utf8')).toBe(skill(ownerId));
      expect(await readFile(path.join(home, 'memories', 'MEMORY.md'), 'utf8')).toContain(`Private ${ownerId} native learning.`);
      expect(await db.select().from(schema.hermesTeamLearningHandoffs)).toHaveLength(1);
      expect(fixture.queued).toEqual([]); expect(await active.retire()).toEqual({ confirmed: true, runtimeWide: true });
      await db.update(schema.agentRuns).set({ status: 'succeeded' }).where(eq(schema.agentRuns.id, worker.id));
      await settleTeamCandidateRun(worker.id, true, [route]); expect(fixture.queued).toHaveLength(1);
      const child = (await claimRun(fixture.queued[0], 'synthetic-official-review-worker'))!;
      const learning = await startTeamCandidateRun(owner, 'team', child.id, { holder: child.holder!, segment: child.segment, routes: [route] });
      expect(learning.contextId).not.toBe(active.contextId);
      expect(driver.candidates[1].modelTokens.learning).not.toBe(driver.candidates[0].modelTokens.learning);
      await executeTeamLearningSegment(child, child.holder!, learning, new AbortController());
      const [done] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, child.id));
      expect(done, `${JSON.stringify(calls.map(call => ({ purpose: call.purpose, operation: call.operation, keys: Object.keys(call.body) })))}; statuses=${JSON.stringify(statuses)}; ${JSON.stringify(driver.nativeErrors)}; ${driver.stderr}`)
        .toMatchObject({ status: 'succeeded', background: true });
      await settleTeamCandidateRun(child.id, true, [route]);
      expect(await readFile(path.join(home, 'skills', `${ownerId}-learned`, 'SKILL.md'), 'utf8')).toBe(skill(ownerId, `${ownerId}-learned`));
      expect(calls.filter(call => call.purpose !== 'utility').every(call => call.operation === 'responses')).toBe(true);
      const utilities = calls.filter(call => call.purpose === 'utility');
      // The pin starts title work asynchronously; a delegate closeout may also
      // schedule it before the first title reaches SQLite. Both use utility.
      expect(utilities.length).toBeGreaterThanOrEqual(1); expect(utilities.length).toBeLessThanOrEqual(2);
      expect(utilities.every(call => call.operation === 'chat/completions')).toBe(true);
      // Native background delegation re-enters the parent for one closeout turn.
      // Count it separately from the title, delegate and durable review calls.
      expect(upstream.filter(call => call.purpose !== 'utility').map(call => call.purpose).sort()).toEqual(['reply', 'reply', 'reply', 'subagent', 'learning', 'learning'].sort());
      expect(upstream).toHaveLength(6 + utilities.length);
      expect(statuses).toHaveLength(upstream.length); expect(statuses.every(status => status === 200)).toBe(true);
      expect((await db.select().from(schema.usageEvents))).toHaveLength(upstream.length);
      expect((await db.select().from(schema.usageEvents)).every(row => row.userId === ownerId && row.appId === null && row.billingSource === 'chatgpt_plan' && row.providerKind === 'chatgpt' && row.costMicros === null)).toBe(true);
      expect((await db.select().from(schema.hermesTeamLearningHandoffs))[0]).toMatchObject({ state: 'complete', childRunId: child.id });
      const [childContext] = await db.select().from(schema.hermesTeamCandidateContexts).where(eq(schema.hermesTeamCandidateContexts.id, learning.contextId));
      expect(childContext).toMatchObject({ actorId: ownerId, personalConnectionId: account.id, retirementState: 'confirmed' });
      expect(childContext.nativeStoppedAt!.getTime()).toBeLessThanOrEqual(done.finishedAt!.getTime());
      const requests = await db.select().from(schema.hermesTeamCandidateRequests);
      expect(requests.filter(row => row.contextId === learning.contextId).map(row => row.purpose)).toEqual(['learning', 'learning']);
      expect(requests.filter(row => row.contextId === active.contextId).every(row => row.purpose !== 'learning' && row.state === 'complete')).toBe(true);
      expect(await driver.running(native.ownerId)).toBe(false);
      await noNativeSecrets(home, ['synthetic-company-fallback-forbidden', 'synthetic-alice-official-access', 'synthetic-bob-official-access', 'synthetic-alice-refresh', 'synthetic-bob-refresh',
        ...driver.candidates.flatMap(config => [...Object.values(config.modelTokens), config.toolToken, ...(config.learningToken ? [config.learningToken] : [])])]);
      // Retained parent tokens cannot revive any purpose or company fallback after retirement.
      const attempts = upstream.length;
      for (const purpose of TEAM_MODEL_PURPOSES) {
        const denied = await candidateModelHttp(new Request('https://app.test.invalid/native', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${driver.candidates[0].modelTokens[purpose]}` },
          body: JSON.stringify({ model: route.model, input: [{ role: 'user', content: 'Late request' }] }) }), { contextId: active.contextId, purpose, operation: ['responses'] },
        { routes: [route], fetch: (url, init) => provider(purpose, url, init) }); expect(denied.status).toBeGreaterThanOrEqual(400);
      }
      expect(upstream).toHaveLength(attempts);
      await until(() => driver.running(native.ownerId), running => !running);
    } finally {
      await ipc.close(); await driver.close(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve())); await rm(temp, { recursive: true, force: true });
    }
  }, 60_000);
});
