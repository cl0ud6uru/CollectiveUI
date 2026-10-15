import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { tokenFingerprint } from '@/personal-codex/contracts';
import type { PersistTurnInput } from '@/lib/agent/persist';
import type { TurnOptions } from '@/lib/agent/run';

const fixture = vi.hoisted(() => ({ client: null as PGlite | null, siwcFingerprint: null as string | null,
  syncTokens: [] as { owner: string; accessToken: string; credentialBinding: string }[], refreshTokens: vi.fn(), authCalls: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/llm/chatgpt/store', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/llm/chatgpt/store')>();
  return { ...actual, getChatGPTAuth: (...args: Parameters<typeof actual.getChatGPTAuth>) => {
    fixture.authCalls(...args); return actual.getChatGPTAuth(...args);
  } };
});
vi.mock('@/lib/llm/chatgpt/siwc', async () => {
  const actual = await vi.importActual<typeof import('@/lib/llm/chatgpt/siwc')>('@/lib/llm/chatgpt/siwc');
  return { ...actual, refreshSIWCTokens: (...args: Parameters<typeof actual.refreshSIWCTokens>) => fixture.refreshTokens(...args) };
});
vi.mock('@/personal-codex/control', () => ({
  personalSocket: () => process.env.PERSONAL_CODEX_SOCKET,
  personalControl: vi.fn(async (owner: string, action: string, credential?: { accessToken: string; credentialBinding: string }) => {
    if (action === 'sync-token' && credential) {
      fixture.syncTokens.push({ owner, ...credential });
      fixture.siwcFingerprint = credential.credentialBinding;
      return { synchronized: true };
    }
    return deviceManaged ? { state: 'running' } : { state: 'running', siwc: { available: true, credentialBinding: fixture.siwcFingerprint } };
  }),
}));
vi.mock('@/db', async () => {
  const { PGlite } = await import('@electric-sql/pglite'), { drizzle } = await import('drizzle-orm/pglite'), schema = await import('@/db/schema');
  fixture.client = new PGlite(); return { db: drizzle(fixture.client, { schema }), schema };
});
import { db, schema } from '@/db';
import { loadPrincipal } from '@/lib/auth/groups';
import { resolveTurnTarget } from '@/lib/agent/target';
import { runCodexTurn } from '@/lib/codex/run';
import { assertRuntimeOwner, callerRuntime, RuntimeManifestSchema } from '@/lib/codex/runtime';
import { stopCodexRun, reconcileCodexStops } from '@/lib/codex/recovery';
import { CodexClient } from '@/lib/codex/client';
import { executeCodexSession } from '@/lib/codex/session';
import { checkpointCodexRun, reserveCodexRun } from '@/lib/codex/store';
import { CODEX_VERSION } from '@/lib/codex/config';
import { getChatGPTAuth, openCredentialSecret, saveChatGPTConnection, sealCredentialSecret } from '@/lib/llm/chatgpt/store';

const SIWC_HOST_ID = 'urn:uuid:123e4567-e89b-42d3-a456-426614174000';
const SIWC_SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

const unixServer = createServer();
const server = createServer(), wss = new WebSocketServer({ server });
let root: string, origin: string;
const serverReplies: unknown[] = [];
unixServer.on('upgrade', (req, socket, head) => server.emit('upgrade', req, socket, head));
let mode: 'normal' | 'hold' | 'lost_ack' | 'approval' | 'wrong_account' | 'unreachable_stop' | 'switch_preflight' | 'native_tool' | 'completed_tool' | 'completed_text' | 'agent_tools' | 'switch_at_completion' | 'resolved_approval' = 'normal';
const seen: { owner: string; method: string; params: Record<string, unknown> }[] = [];
let subscription = false, managed = false, deviceManaged = false, nativeSequence = 0;
let nativeWorkspace: string | undefined, nativePlan = 'business';
const states = new Map<string, { id: string; status: string }>();
const heldTurns: { ws: WebSocket; threadId: string; turnId: string }[] = [];
const send = (ws: WebSocket, value: unknown) => ws.send(JSON.stringify(value));
wss.on('connection', (ws, req) => {
  const owner = String(req.headers['x-collective-owner'] ?? req.url!.slice(1));
  if (!managed) expect(req.headers.authorization).toBe(`Bearer fixture-only-${owner}-transport-token-00000000`);
  let lateAccountChange = false;
  ws.on('message', bytes => {
    const m = JSON.parse(bytes.toString());
    if (!m.method) {
      serverReplies.push(m);
      if (managed && m.id === 'approval' && m.result?.decision) {
        const turn = states.get(`thread-${owner}`)!;
        turn.status = m.result.decision === 'cancel' ? 'interrupted' : 'completed';
        send(ws, { method: 'turn/completed', params: { threadId: `thread-${owner}`, turn: { ...turn } } });
      }
      return;
    }
    seen.push({ owner, method: m.method, params: m.params });
    const reply = (result: unknown) => send(ws, { id: m.id, result });
    const notification = (method: string, params: unknown) => send(ws, { method, params });
    if (m.method === 'initialize') reply({ userAgent: `codex_cli_rs/${CODEX_VERSION} (Linux)` });
    else if (m.method === 'account/read') {
      const accountReply = () => reply({ account: mode === 'wrong_account' || subscription || managed ? { type: 'chatgpt', email: mode === 'wrong_account' || lateAccountChange ? 'other@test.invalid' : `${owner}@test.invalid`, planType: deviceManaged ? nativePlan : 'business' } : { type: 'apiKey' }, requiresOpenaiAuth: true, ...(managed ? { workspaceRouting: { chatgptAccountId: deviceManaged ? nativeWorkspace ?? `workspace-${owner}` : 'shared-workspace', backendOrigin: 'https://chatgpt.com/backend-api', accountRoutingOverride: 'NO_CONSTRAINT' } } : {}) });
      if (lateAccountChange) setTimeout(accountReply, 30); else accountReply();
    }
    else if (m.method === 'config/read') reply({ config: deviceManaged ? { forced_login_method: 'chatgpt', model_provider: 'openai' } : managed ? {
      model_provider: 'openai_chatgpt_plan', model_providers: { openai_chatgpt_plan: {
        base_url: 'https://api.openai.com/v1', env_key: 'ACCESS_TOKEN', wire_api: 'responses',
        requires_openai_auth: false, supports_websockets: false,
      } }, shell_environment_policy: { inherit: 'none', filters: { ACCESS_TOKEN: 'exclude' } },
    } : subscription ? { forced_login_method: 'chatgpt', forced_chatgpt_workspace_id: 'shared-workspace' } : {} });
    else if (m.method === 'configRequirements/read') reply({ requirements: { defaultPermissions: 'collective-personal', allowedPermissionProfiles: { 'collective-personal': true }, allowedLoginMethods: ['chatgpt'], allowedApprovalsReviewers: ['user'], allowedApprovalPolicies: ['on-request'] } });
    else if (m.method === 'model/list') { if (mode === 'switch_preflight') { fixture.siwcFingerprint = 'changed-before-dispatch'; lateAccountChange = deviceManaged; notification('account/updated', { authMode: 'chatgpt' }); } reply({ data: [{ model: 'fixture-model', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }], nextCursor: null }); }
    else if (m.method === 'thread/start' || m.method === 'thread/resume') reply({ thread: { id: `thread-${owner}`, turns: m.method === 'thread/resume' && states.has(`thread-${owner}`) ? [states.get(`thread-${owner}`)!] : [] }, model: 'fixture-model', modelProvider: managed && !deviceManaged ? 'openai_chatgpt_plan' : 'openai', cwd: managed ? '/home/agent/workspace' : '/audit',
      ...(managed ? { activePermissionProfile: { id: 'collective-personal', extends: null } } : {}),
      approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: managed ? 'workspaceWrite' : 'readOnly', networkAccess: false } });
    else if (m.method === 'turn/start') {
      const threadId = String(m.params.threadId), turnId = managed ? `turn-${owner}-${++nativeSequence}` : `turn-${owner}`;
      states.set(threadId, { id: turnId, status: 'inProgress' });
      if (mode === 'lost_ack' || mode === 'unreachable_stop') { ws.terminate(); return; }
      if (mode === 'hold') { heldTurns.push({ ws, threadId, turnId }); reply({ turn: { id: turnId } }); return; }
      if (mode === 'approval') {
        reply({ turn: { id: turnId } }); send(ws, { id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId, turnId, ...(managed ? { itemId: 'native-command', command: 'protected-command', reason: 'Additional permissions' } : {}) } }); return;
      }
      if (mode === 'native_tool' || mode === 'completed_tool') { reply({ turn: { id: turnId } }); notification(mode === 'completed_tool' ? 'item/completed' : 'item/started', { threadId, turnId, item: { type: 'fileChange' } }); return; }
      if (mode === 'switch_at_completion') { lateAccountChange = true; fixture.siwcFingerprint = 'changed-at-completion'; notification('account/updated', { authMode: 'chatgpt' }); }
      if (mode === 'resolved_approval') {
        send(ws, { id: 'resolved-native', method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'native-command' } });
        notification('serverRequest/resolved', { threadId, requestId: 'resolved-native' });
      }
      if (mode === 'agent_tools') {
        notification('item/started', { threadId, turnId, item: { id: 'cmd', type: 'commandExecution', command: 'python3 report.py', cwd: '/home/agent/workspace', status: 'inProgress' } });
        notification('item/completed', { threadId, turnId, item: { id: 'cmd', type: 'commandExecution', command: 'python3 report.py', cwd: '/home/agent/workspace', status: 'completed', aggregatedOutput: 'report ready', exitCode: 0 } });
        notification('item/completed', { threadId, turnId, item: { id: 'patch', type: 'fileChange', status: 'completed', changes: [{ path: '/home/agent/workspace/report.py', diff: '+print(1)' }] } });
      }
      // Real race: events may be delivered before the turn/start response. Foreign events cannot contaminate it.
      notification('item/agentMessage/delta', { threadId: 'foreign', turnId, itemId: 'bad', delta: 'not yours' });
      notification('item/agentMessage/delta', { threadId, turnId: 'foreign', itemId: 'bad', delta: 'not yours either' });
      if (mode !== 'completed_text') notification('item/agentMessage/delta', { threadId, turnId, itemId: 'answer', delta: `Hello ${owner}` });
      notification('item/completed', { threadId, turnId, item: { id: 'answer', type: 'agentMessage', text: `Hello ${owner}` } });
      notification('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: { inputTokens: managed ? nativeSequence * 7 : 7, outputTokens: managed ? nativeSequence * 3 : 3, cachedInputTokens: managed ? nativeSequence * 2 : 2, reasoningOutputTokens: managed ? nativeSequence : 1 }, last: { inputTokens: 2, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0 } } });
      states.set(threadId, { id: turnId, status: 'completed' });
      notification('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
      reply({ turn: { id: turnId } });
    } else if (m.method === 'turn/interrupt') {
      if (mode === 'unreachable_stop') { ws.terminate(); return; }
      const turn = states.get(String(m.params.threadId)); if (turn) turn.status = 'interrupted'; reply({});
    } else if (m.method === 'thread/read') reply({ thread: { turns: [...(states.has(String(m.params.threadId)) ? [states.get(String(m.params.threadId))!] : [])] } });
  });
});

beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync('src/db/migrations').filter(f => f.endsWith('.sql')).sort())
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, 'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;', '').replace(/\bvector\b/g, 'real[]'));
  root = await mkdtemp(join(tmpdir(), 'codex-harness-fixture-'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture address');
  origin = `ws://127.0.0.1:${address.port}`;
  await new Promise<void>(resolve => unixServer.listen(join(root, 'native.sock'), resolve));
}, 45000);
beforeEach(async () => {
  mode = 'normal'; subscription = false; managed = false; deviceManaged = false; nativeWorkspace = undefined; nativePlan = 'business'; nativeSequence = 0; fixture.siwcFingerprint = null; fixture.syncTokens.length = 0; serverReplies.length = 0; vi.stubEnv('PERSONAL_CODEX_SOCKET', ''); seen.length = 0; states.clear();
  fixture.refreshTokens.mockReset();
  fixture.authCalls.mockReset();
  heldTurns.length = 0;
  await fixture.client!.exec('TRUNCATE users, ai_apps, codex_runs, settings, codex_approvals CASCADE');
  await db.insert(schema.users).values(['alice', 'bob'].map(id => ({ id, upn: `${id}@test.invalid`, name: id, authSource: 'local' as const, identityRealm: 'local' as const })));
  await db.insert(schema.bots).values({ id: 'audit', ownerId: 'alice', name: 'Shared example bot', visibility: 'org' });
  await db.insert(schema.codexBotConfigs).values({ botId: 'audit', policy: { funding: 'api', model: 'fixture-model', effort: 'medium' } });
  const runtimes = [];
  for (const ownerId of ['alice', 'bob']) {
    const tokenFile = join(root, `${ownerId}-token`);
    await writeFile(tokenFile, `fixture-only-${ownerId}-transport-token-00000000`);
    runtimes.push({ id: ownerId, ownerId, funding: 'api', endpoint: `${origin}/${ownerId}`, tokenFile,
      isolationId: `${ownerId}-container`, credentialBinding: `${ownerId}-account`, cwd: '/audit', isolated: true, nativeMcpDisabled: true });
  }
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ version: 1, runtimes }));
  vi.stubEnv('CODEX_RUNTIME_MANIFEST', join(root, 'manifest.json'));
});
afterAll(async () => {
  for (const ws of wss.clients) ws.terminate();
  await new Promise<void>(resolve => wss.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
  await new Promise<void>(resolve => unixServer.close(() => resolve()));
  await fixture.client!.close(); await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs();
});
async function options(owner: string, suffix = '1') {
  const p = (await loadPrincipal(owner))!;
  const conversationId = `${owner}-${suffix}`, runId = `run-${conversationId}`;
  const [conversation] = await db.insert(schema.conversations).values({ id: conversationId, userId: owner, botId: 'audit' }).returning();
  const { app, bot } = await resolveTurnTarget(p, conversation);
  await db.insert(schema.agentRuns).values({ id: runId, userId: owner, conversationId, messageId: `answer-${runId}`, botId: 'audit',
    appId: app.id, status: 'running', holder: 'fixture-worker' });
  const saved: PersistTurnInput[] = [];
  const opts: TurnOptions = { principal: p, conversation, app, bot, history: [{ id: `question-${runId}`, role: 'user', parts: [{ type: 'text', text: 'Audit this text.' }] }],
    continuation: false, responseMessageId: `answer-${runId}`, run: { id: runId, holder: 'fixture-worker', segment: 0, legacy: false, resumeState: null, saveResumeState() {} },
    persist: async i => { saved.push(i); } };
  return { opts, saved, runId };
}
async function consume(opts: TurnOptions) {
  const turn = await runCodexTurn(opts), chunks = [];
  const reader = turn.stream.getReader(); for (;;) { const v = await reader.read(); if (v.done) break; chunks.push(v.value); }
  const result = await turn.done;
  if (result.error) await stopCodexRun(opts.run!.id); // executor's post-finalization recovery hook
  return { result, chunks, billing: turn.billing };
}
async function until(fn: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('fixture wait timed out');
}

describe('Codex native app-server harness (local protocol fixtures, no live inference)', () => {
  it('runs one shared bot on two caller-owned runtimes, streams pre-ack events, and records distinct bindings', async () => {
    for (const owner of ['alice', 'bob']) {
      const { opts, saved, runId } = await options(owner);
      const { result, chunks, billing } = await consume(opts);
      expect(result.error).toBeUndefined(); expect(result.responseMessage.parts).toEqual([{ type: 'text', text: `Hello ${owner}`, state: 'done' }]);
      expect(chunks.some(c => c.type === 'text-delta')).toBe(true); expect(billing?.source).toBe('codex_api');
      expect(saved[0].background).toBe(true); expect(saved[0].userId).toBe(owner);
      const [row] = await db.select().from(schema.codexRuns).where(eq(schema.codexRuns.runId, runId));
      expect(row).toMatchObject({ userId: owner, runtimeId: owner, threadId: `thread-${owner}`, turnId: `turn-${owner}`, phase: 'terminal' });
      expect(JSON.stringify(row)).not.toContain('transport-token');
    }
    const ledger = await db.select().from(schema.usageEvents);
    expect(ledger.map(r => r.billingSource)).toEqual(['codex_api', 'codex_api']);
    expect(ledger.every(r => r.costMicros === null && r.inputTokens === 7 && r.outputTokens === 3)).toBe(true);
    expect(seen.filter(s => s.method === 'turn/start').map(s => s.owner)).toEqual(['alice', 'bob']);
    expect(seen.filter(s => s.method === 'thread/start').every(s => (s.params.config as Record<string, unknown>)['features.shell_tool'] === false)).toBe(true);
    expect(seen.some(s => s.method.startsWith('account/login'))).toBe(false);
  });
  it('projects a completed agent message when no text delta was delivered', async () => {
    mode = 'completed_text'; const { opts } = await options('alice');
    const result = await consume(opts);
    expect(result.result.error).toBeUndefined();
    expect(result.result.responseMessage.parts).toEqual([{ type: 'text', text: 'Hello alice', state: 'done' }]);
  });
  it('refuses an API/subscription account mismatch before thread or paid turn dispatch', async () => {
    mode = 'wrong_account'; const { opts } = await options('alice');
    expect((await consume(opts)).result.error).toContain('funding and identity');
    expect(seen.some(s => s.method === 'turn/start' || s.method === 'thread/start')).toBe(false);
  });
  it('never substitutes the owner runtime when a shared-bot caller has no assigned connection', async () => {
    const { opts } = await options('bob'); vi.stubEnv('CODEX_RUNTIME_MANIFEST', '');
    await expect(runCodexTurn(opts)).rejects.toThrow('No other account'); expect(seen).toEqual([]);
  });
  it('serializes a stop competing with the dispatch checkpoint without treating a possible write as terminal', async () => {
    for (let i = 0; i < 8; i++) {
      const { opts, runId } = await options('alice', `race-${i}`);
      await reserveCodexRun(opts.run!, await callerRuntime('alice', 'api'));
      await checkpointCodexRun(opts.run!, 'alice', { phase: 'ready', threadId: `race-thread-${i}` });
      const [dispatch] = await Promise.allSettled([
        checkpointCodexRun(opts.run!, 'alice', { phase: 'dispatching' }), stopCodexRun(runId),
      ]);
      const [row] = await db.select().from(schema.codexRuns).where(eq(schema.codexRuns.runId, runId));
      if (dispatch.status === 'fulfilled') expect(row.phase).toBe('stop_unconfirmed');
      else expect(row.phase).toBe('terminal');
      // Fixture cleanup only: there was no actual turn/start in this race test.
      await db.update(schema.codexRuns).set({ phase: 'terminal' }).where(eq(schema.codexRuns.runId, runId));
    }
  });
  it('does not replay an uncertain turn/start; recovery reconnects only to stop/read the recorded thread', async () => {
    mode = 'lost_ack'; const { opts, runId } = await options('alice');
    expect((await consume(opts)).result.error).toContain('not be replayed');
    await stopCodexRun(runId);
    await expect(runCodexTurn(opts)).rejects.toThrow('cannot be replayed');
    expect(seen.filter(s => s.method === 'turn/start')).toHaveLength(1);
    expect(seen.find(s => s.method === 'turn/interrupt')?.params).toEqual({ threadId: 'thread-alice', turnId: '' });
    expect((await db.select().from(schema.codexRuns))[0].phase).toBe('terminal');
  });
  it('interrupts an accepted turn on cancellation without waiting for the browser to remain connected', async () => {
    mode = 'hold'; const { opts, runId } = await options('alice'); const ac = new AbortController(); opts.abortSignal = ac.signal;
    const result = consume(opts); await until(async () => seen.some(s => s.method === 'turn/start'));
    ac.abort(); expect((await result).result.error).toContain('stopped'); await stopCodexRun(runId);
    expect(seen.some(s => s.method === 'turn/interrupt')).toBe(true);
  });
  it('retains unconfirmed stops for retry while blocking new work', async () => {
    mode = 'unreachable_stop'; const { opts, runId } = await options('alice'); await consume(opts); await stopCodexRun(runId);
    expect((await db.select().from(schema.codexRuns))[0].phase).toBe('stop_unconfirmed');
    const next = await options('alice', '2'); await expect(runCodexTurn(next.opts)).rejects.toThrow('stop is unconfirmed');
    await db.update(schema.agentRuns).set({ status: 'interrupted' }).where(eq(schema.agentRuns.id, runId));
    await db.update(schema.codexRuns).set({ updatedAt: new Date(0) }).where(eq(schema.codexRuns.runId, runId));
    mode = 'normal'; await reconcileCodexStops(); expect((await db.select().from(schema.codexRuns))[0].phase).toBe('terminal');
  });
  it('detects an account change during preflight and never dispatches the turn', async () => {
    mode = 'switch_preflight'; const { opts } = await options('alice');
    expect((await consume(opts)).result.error).toContain('account changed');
    expect(seen.some(s => s.method === 'turn/start')).toBe(false);
  });
  it.each(['native_tool', 'completed_tool'] as const)('stops unexpected %s events including apply-patch file changes', async scenario => {
    mode = scenario; const { opts, runId } = await options('alice');
    expect((await consume(opts)).result.error).toContain('native tool'); await stopCodexRun(runId);
  });
  it('rejects interactive approvals rather than auto-accepting them', async () => {
    mode = 'approval'; const { opts, runId } = await options('alice');
    expect((await consume(opts)).result.error).toContain('unsupported approval'); await stopCodexRun(runId);
  });
  it('rejects files, routines and continuations before opening a runtime connection', async () => {
    const { opts } = await options('alice');
    await expect(runCodexTurn({ ...opts, background: true })).rejects.toThrow('direct text');
    await expect(runCodexTurn({ ...opts, continuation: true })).rejects.toThrow('direct text');
    opts.history[0].parts.push({ type: 'file', url: '/api/files/not-transferred', mediaType: 'text/plain' });
    await expect(runCodexTurn(opts)).rejects.toThrow('direct text'); expect(seen).toEqual([]);
  });
  it('keeps two subscription callers on distinct accounts while enforcing their shared workspace restriction', async () => {
    subscription = true;
    for (const owner of ['alice', 'bob']) {
      const runtime = { ...await callerRuntime(owner, 'api'), funding: 'chatgpt_subscription' as const,
        expectedEmail: `${owner}@test.invalid`, expectedWorkspaceId: 'shared-workspace',
        subscriptionAuthorization: { reference: 'fixture-only-not-an-entitlement', expiresAt: Date.now() + 60000 } };
      const client = await CodexClient.connect(runtime), text: string[] = [];
      try { await executeCodexSession(client, runtime, { funding: 'chatgpt_subscription', model: 'fixture-model', effort: 'medium' }, 'hello', '',
        { checkpoint: async () => {}, text: (_id, delta) => { text.push(delta); } }, AbortSignal.timeout(2000)); }
      finally { client.close(); }
      expect(text).toEqual([`Hello ${owner}`]);
    }
  });
  it('does not bypass the installation personal-plan policy for a subscription bot', async () => {
    await db.update(schema.codexBotConfigs).set({ policy: { funding: 'chatgpt_subscription', model: 'fixture-model', effort: 'medium' } });
    const p = (await loadPrincipal('alice'))!;
    await expect(resolveTurnTarget(p, { botId: 'audit', appId: null })).rejects.toThrow('not enabled personal ChatGPT');
    expect(seen).toEqual([]);
  });
  it('rejects a subscription account that is assigned to the caller but belongs to another signed-in identity', async () => {
    const runtime = { ...await callerRuntime('alice', 'api'), funding: 'chatgpt_subscription' as const, expectedEmail: 'other@test.invalid' };
    expect(() => assertRuntimeOwner(runtime, { id: 'alice', upn: 'alice@test.invalid', email: null })).toThrow('different person');
  });
  it('rejects pooled endpoints, shared subscription identities, insecure remote transport and unapproved subscription bindings', async () => {
    const runtime = await callerRuntime('alice', 'api');
    expect(RuntimeManifestSchema.safeParse({ version: 1, runtimes: [runtime, { ...runtime, id: 'bob', ownerId: 'bob' }] }).success).toBe(false);
    expect(RuntimeManifestSchema.safeParse({ version: 1, runtimes: [{ ...runtime, endpoint: 'ws://remote.example' }] }).success).toBe(false);
    expect(RuntimeManifestSchema.safeParse({ version: 1, runtimes: [{ ...runtime, funding: 'chatgpt_subscription' }] }).success).toBe(false);
  });
  it('resumes the same managed native thread, allows command/file items, and reports per-turn usage deltas', async () => {
    await managedConnection(); mode = 'agent_tools';
    const runtime = await callerRuntime('alice', 'chatgpt_subscription', { synchronize: true });
    let totals: import('@/lib/codex/session').CodexTokenUsage | undefined;
    const tools: unknown[] = [], usage: unknown[] = [];
    for (let turn = 0; turn < 2; turn++) {
      const client = await CodexClient.connect(runtime);
      try { await executeCodexSession(client, runtime, { funding: 'chatgpt_subscription', model: 'fixture-model', effort: 'medium' }, 'create report', '',
        { checkpoint: async () => {}, text: () => {}, resumeThreadId: turn ? 'thread-alice' : undefined,
          baselineUsage: totals, totalUsage: value => { totals = value; }, usage: value => usage.push(value), tool: (item, phase) => tools.push({ item, phase }) }, AbortSignal.timeout(3000)); }
      finally { client.close(); }
    }
    expect(seen.filter(s => s.method === 'thread/start')).toHaveLength(1);
    expect(seen.filter(s => s.method === 'thread/resume')).toHaveLength(1);
    expect(seen.filter(s => s.method === 'turn/start').every(s => s.params.permissions === 'collective-personal' && !s.params.sandboxPolicy)).toBe(true);
    expect(tools).toHaveLength(6);
    expect(usage).toEqual([{ inputTokens: 7, outputTokens: 3, cachedInputTokens: 2, reasoningOutputTokens: 1 }, { inputTokens: 7, outputTokens: 3, cachedInputTokens: 2, reasoningOutputTokens: 1 }]);
  });
  it('does not mistake the previous completed native turn for an uncertain new dispatch', async () => {
    const { opts, runId } = await options('alice');
    await reserveCodexRun(opts.run!, await callerRuntime('alice', 'api'));
    await checkpointCodexRun(opts.run!, 'alice', { phase: 'ready', threadId: 'thread-alice', baselineTurnId: 'old-completed' });
    await checkpointCodexRun(opts.run!, 'alice', { phase: 'dispatching' });
    states.set('thread-alice', { id: 'old-completed', status: 'completed' });
    await stopCodexRun(runId);
    expect((await db.select().from(schema.codexRuns))[0].phase).toBe('stop_unconfirmed');
  });

  async function managedConnection() {
    managed = true; vi.stubEnv('PERSONAL_CODEX_SOCKET', join(root, 'native.sock'));
    vi.stubEnv('CHATGPT_SIWC_HOST_ID', SIWC_HOST_ID);
    await db.insert(schema.settings).values({ key: 'chatgpt', value: { enabled: true, access: 'everyone', allowPersonalPlans: true, allowedUpns: [], allowedGroupIds: [], allowedWorkspaceIds: [] } });
    await db.update(schema.codexBotConfigs).set({ policy: { funding: 'chatgpt_subscription', model: 'fixture-model', effort: 'medium' } });
    await saveChatGPTConnection('alice', { accessToken: 'fixture-managed-access-token', refreshToken: 'fixture-managed-refresh-token', idToken: 'fixture-managed-id-token', expiresIn: 3600 },
      { accountId: 'siwc:issued-client-id', userId: 'fixture-managed-subject', email: 'alice@test.invalid', planType: null, residency: null, isFedramp: false, expiresAt: new Date(Date.now() + 3_600_000) },
      undefined, { clientId: 'issued-client-id', hostId: SIWC_HOST_ID, scope: SIWC_SCOPE });
  }
  async function deviceConnections() {
    managed = true; deviceManaged = true;
    vi.stubEnv('PERSONAL_CODEX_SOCKET', join(root, 'native.sock'));
    vi.stubEnv('CHATGPT_SIWC_HOST_ID', '');
    await db.insert(schema.settings).values({ key: 'chatgpt', value: { enabled: true, access: 'everyone', allowPersonalPlans: true, allowedUpns: [], allowedGroupIds: [], allowedWorkspaceIds: [] } });
    await db.update(schema.codexBotConfigs).set({ policy: { funding: 'chatgpt_subscription', model: 'fixture-model', effort: 'medium' } });
    await db.update(schema.users).set({ upn: 'local:jhartley', email: null }).where(eq(schema.users.id, 'alice'));
    await db.insert(schema.personalCodexAccounts).values(['alice', 'bob'].map(userId => ({
      userId, credentialBinding: `device-binding-${userId}`, email: `${userId}@test.invalid`,
      workspaceId: `workspace-${userId}`, planType: 'business', connected: true,
    })));
  }
  it('requires stock device connection without refreshing an unrelated Native SIWC credential', async () => {
    await deviceConnections();
    await db.update(schema.personalCodexAccounts).set({ connected: false }).where(eq(schema.personalCodexAccounts.userId, 'alice'));
    await expect(callerRuntime('alice', 'chatgpt_subscription', { synchronize: true })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Connect stock Codex') });
    expect(fixture.authCalls).not.toHaveBeenCalled();
    expect(fixture.refreshTokens).not.toHaveBeenCalled();
    expect(fixture.syncTokens).toHaveLength(0);
  });
  it('runs native device messages and command/file items on two confirmed owner-isolated accounts without portal credentials', async () => {
    await deviceConnections();
    for (const owner of ['alice', 'bob']) {
      mode = owner === 'alice' ? 'normal' : 'agent_tools';
      const runtime = await callerRuntime(owner, 'chatgpt_subscription', { synchronize: true });
      expect(runtime).toMatchObject({ id: `personal:${owner}`, ownerId: owner, authMode: 'chatgpt', managed: true,
        credentialBinding: `device-binding-${owner}`, expectedWorkspaceId: `workspace-${owner}` });
      expect(() => assertRuntimeOwner(runtime, { id: owner, upn: `local:${owner}`, email: null })).not.toThrow();
      expect(() => assertRuntimeOwner(runtime, { id: owner === 'alice' ? 'bob' : 'alice', upn: `${owner}@test.invalid`, email: null })).toThrow('different person');
      const { opts, runId, saved } = await options(owner);
      const result = await consume(opts);
      expect(result.result.error).toBeUndefined();
      expect(result.result.responseMessage.parts).toContainEqual({ type: 'text', text: `Hello ${owner}`, state: 'done' });
      expect(result.billing?.source).toBe('chatgpt_plan');
      expect(saved[0].userId).toBe(owner);
      expect((await db.select().from(schema.codexRuns).where(eq(schema.codexRuns.runId, runId)))[0]).toMatchObject({
        userId: owner, runtimeId: `personal:${owner}`, threadId: `thread-${owner}`, phase: 'terminal',
      });
      if (owner === 'bob') {
        expect(result.result.responseMessage.parts).toContainEqual(expect.objectContaining({ type: 'dynamic-tool', toolName: 'codex_commandExecution', state: 'output-available', output: { status: 'completed', stdout: 'report ready', exitCode: 0 } }));
        expect(result.result.responseMessage.parts).toContainEqual(expect.objectContaining({ type: 'dynamic-tool', toolName: 'codex_fileChange', state: 'output-available' }));
      }
    }
    expect(seen.filter(call => call.method === 'turn/start').map(call => call.owner)).toEqual(['alice', 'bob']);
    for (const owner of ['alice', 'bob']) {
      const reads = seen.filter(call => call.owner === owner && call.method === 'account/read');
      expect(reads[0].params).toEqual({ refreshToken: true });
      expect(reads.slice(1).every(call => call.params.refreshToken === false)).toBe(true);
    }
    expect(seen.filter(call => call.method === 'thread/start').every(call => call.params.modelProvider === 'openai' &&
      (call.params.config as Record<string, unknown>).forced_chatgpt_workspace_id === `workspace-${call.owner}` && call.params.permissions === 'collective-personal')).toBe(true);
    expect(await db.select().from(schema.userCredentials)).toHaveLength(0);
    expect(fixture.authCalls).not.toHaveBeenCalled();
    expect(fixture.refreshTokens).not.toHaveBeenCalled();
    expect(fixture.syncTokens).toHaveLength(0);
  });
  it.each(['switch_preflight', 'switch_at_completion'] as const)('rejects native device identity changes at %s', async scenario => {
    await deviceConnections(); mode = scenario;
    const { opts } = await options('alice');
    const result = await consume(opts);
    expect(result.result.error).toContain('account does not match');
    expect(result.chunks.find(chunk => chunk.type === 'finish')).toMatchObject({ finishReason: 'error' });
    expect(seen.filter(call => call.method === 'turn/start')).toHaveLength(scenario === 'switch_preflight' ? 0 : 1);
    expect(fixture.authCalls).not.toHaveBeenCalled();
  });
  it.each(['workspace', 'workspace policy', 'personal plan policy', 'access policy'] as const)('rechecks native %s before accepting held completion', async cause => {
    await deviceConnections(); mode = 'hold';
    const { opts } = await options('alice'), running = consume(opts);
    await until(async () => heldTurns.length === 1 && (await db.select().from(schema.codexRuns))[0]?.phase === 'running');
    if (cause === 'workspace') nativeWorkspace = 'replacement-workspace';
    else {
      const value = { enabled: cause !== 'access policy', access: 'everyone', allowPersonalPlans: cause !== 'personal plan policy',
        allowedUpns: [], allowedGroupIds: [], allowedWorkspaceIds: cause === 'workspace policy' ? ['other-workspace'] : [] };
      await db.update(schema.settings).set({ value }).where(eq(schema.settings.key, 'chatgpt'));
      if (cause === 'personal plan policy') nativePlan = 'plus';
    }
    completeHeldTurn();
    const result = await running;
    expect(result.result.error).toMatch(/workspace changed|workspace isn't|Personal ChatGPT/);
    expect(result.chunks.find(chunk => chunk.type === 'finish')).toMatchObject({ finishReason: 'error' });
    expect(seen.filter(call => call.method === 'turn/start')).toHaveLength(1);
    expect(fixture.authCalls).not.toHaveBeenCalled();
  });
  function completeHeldTurn(recheckAccount = true) {
    const { ws, threadId, turnId } = heldTurns[0];
    if (recheckAccount) send(ws, { method: 'account/updated', params: { authMode: 'chatgpt' } });
    send(ws, { method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'answer', delta: 'Completed after refresh' } });
    states.set(threadId, { id: turnId, status: 'completed' });
    send(ws, { method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
  }
  it('completes an in-flight stock turn after the native harness rotates only the SIWC tokens', async () => {
    await managedConnection(); mode = 'hold';
    const { opts } = await options('alice'), running = consume(opts);
    await until(async () => heldTurns.length === 1 && (await db.select().from(schema.codexRuns))[0]?.phase === 'running');
    const originalFingerprint = fixture.siwcFingerprint;
    const [before] = await db.select().from(schema.userCredentials);
    const [bindingBefore] = await db.select().from(schema.personalCodexAccounts);
    fixture.refreshTokens.mockResolvedValue({ ok: true, tokens: { accessToken: 'native-rotated-access', refreshToken: 'native-rotated-refresh', expiresIn: 3600 } });
    expect((await getChatGPTAuth('alice', { rejectedToken: 'fixture-managed-access-token' })).accessToken).toBe('native-rotated-access');
    expect(fixture.siwcFingerprint).toBe(originalFingerprint);
    expect(fixture.syncTokens).toHaveLength(1);
    const [after] = await db.select().from(schema.userCredentials);
    expect(after).toMatchObject({ id: before.id, accountId: before.accountId, externalSubject: before.externalSubject, email: before.email });
    expect((await db.select().from(schema.personalCodexAccounts))[0].credentialBinding).toBe(bindingBefore.credentialBinding);
    // A native-harness refresh does not publish an account update on the stock app-server.
    completeHeldTurn(false);
    const result = await running;
    expect(result.result.error).toBeUndefined();
    expect(result.result.responseMessage.parts).toContainEqual({ type: 'text', text: 'Completed after refresh', state: 'done' });
    expect((await db.select().from(schema.codexRuns))[0].phase).toBe('terminal');
  });
  it('strictly rechecks the dispatch token after a checkpoint refresh without an account notification', async () => {
    await managedConnection();
    const runtime = await callerRuntime('alice', 'chatgpt_subscription', { synchronize: true });
    fixture.refreshTokens.mockResolvedValue({ ok: true, tokens: { accessToken: 'checkpoint-rotated-access', refreshToken: 'checkpoint-rotated-refresh', expiresIn: 3600 } });
    const client = await CodexClient.connect(runtime);
    try {
      await expect(executeCodexSession(client, runtime, { funding: 'chatgpt_subscription', model: 'fixture-model', effort: 'medium' }, 'hello', '', {
        checkpoint: async value => { if (value.phase === 'dispatching') await getChatGPTAuth('alice', { rejectedToken: 'fixture-managed-access-token' }); },
        text: () => {},
      }, AbortSignal.timeout(2000))).rejects.toThrow('Your ChatGPT connection changed');
    } finally { client.close(); }
    expect(fixture.refreshTokens).toHaveBeenCalledTimes(1);
    expect(fixture.siwcFingerprint).toBe(runtime.tokenFingerprint);
    expect(seen.some(call => call.method === 'turn/start')).toBe(false);
  });
  it.each(['disabled owner', 'removed credential', 'disconnected binding', 'rotated binding', 'session version', 'credential ID',
    'account ID', 'subject', 'email', 'client registration', 'host registration', 'scope registration', 'inactive credential', 'broker fingerprint'] as const)
  ('rejects an in-flight completion after changing %s', async cause => {
    await managedConnection(); mode = 'hold';
    const { opts } = await options('alice'), running = consume(opts);
    await until(async () => heldTurns.length === 1 && (await db.select().from(schema.codexRuns))[0]?.phase === 'running');
    const [credential] = await db.select().from(schema.userCredentials);
    const secret = openCredentialSecret(credential);
    switch (cause) {
      case 'disabled owner': await db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, 'alice')); break;
      case 'removed credential': await db.delete(schema.userCredentials).where(eq(schema.userCredentials.id, credential.id)); break;
      case 'disconnected binding': await db.update(schema.personalCodexAccounts).set({ connected: false }).where(eq(schema.personalCodexAccounts.userId, 'alice')); break;
      case 'rotated binding': await db.update(schema.personalCodexAccounts).set({ credentialBinding: 'replacement-binding' }).where(eq(schema.personalCodexAccounts.userId, 'alice')); break;
      case 'session version': await db.update(schema.users).set({ sessionVersion: 1 }).where(eq(schema.users.id, 'alice')); break;
      case 'credential ID': await db.update(schema.userCredentials).set({ id: 'replacement-credential', secretEnc: sealCredentialSecret('replacement-credential', secret) }).where(eq(schema.userCredentials.id, credential.id)); break;
      case 'account ID':
        await db.update(schema.userCredentials).set({ accountId: 'siwc:replacement-account' }).where(eq(schema.userCredentials.id, credential.id));
        await db.update(schema.personalCodexAccounts).set({ workspaceId: 'siwc:replacement-account' }).where(eq(schema.personalCodexAccounts.userId, 'alice')); break;
      case 'subject': await db.update(schema.userCredentials).set({ externalSubject: 'replacement-subject' }).where(eq(schema.userCredentials.id, credential.id)); break;
      case 'email':
        await db.update(schema.userCredentials).set({ email: 'replacement@test.invalid' }).where(eq(schema.userCredentials.id, credential.id));
        await db.update(schema.personalCodexAccounts).set({ email: 'replacement@test.invalid' }).where(eq(schema.personalCodexAccounts.userId, 'alice')); break;
      case 'client registration':
        await db.update(schema.userCredentials).set({ secretEnc: sealCredentialSecret(credential.id, { ...secret, siwc: { ...secret.siwc!, clientId: 'replacement-client' } }) }).where(eq(schema.userCredentials.id, credential.id)); break;
      case 'host registration': {
        const hostId = 'urn:uuid:123e4567-e89b-42d3-b456-426614174000';
        vi.stubEnv('CHATGPT_SIWC_HOST_ID', hostId);
        await db.update(schema.userCredentials).set({ secretEnc: sealCredentialSecret(credential.id, { ...secret, siwc: { ...secret.siwc!, hostId } }) }).where(eq(schema.userCredentials.id, credential.id)); break;
      }
      case 'scope registration':
        await db.update(schema.userCredentials).set({ secretEnc: sealCredentialSecret(credential.id, { ...secret, siwc: { ...secret.siwc!, scope: `${SIWC_SCOPE} changed-registration` } }) }).where(eq(schema.userCredentials.id, credential.id)); break;
      case 'inactive credential': await db.update(schema.userCredentials).set({ status: 'needs_reauth' }).where(eq(schema.userCredentials.id, credential.id)); break;
      case 'broker fingerprint': fixture.siwcFingerprint = 'replacement-broker-token'; break;
    }
    completeHeldTurn();
    const result = await running;
    expect(result.result.error).toMatch(/ChatGPT connection/);
    expect(result.chunks.find(chunk => chunk.type === 'finish')).toMatchObject({ finishReason: 'error' });
    expect(seen.filter(call => call.method === 'turn/start')).toHaveLength(1);
  });
  it.each(['disabled owner', 'deleted credential', 'disconnected binding'])('never dispatches with a stale broker fingerprint after %s', async cause => {
    await managedConnection();
    const runtime = await callerRuntime('alice', 'chatgpt_subscription', { synchronize: true });
    expect(fixture.siwcFingerprint).toBe(runtime.tokenFingerprint);
    if (cause === 'disabled owner') await db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, 'alice'));
    else if (cause === 'deleted credential') await db.delete(schema.userCredentials).where(eq(schema.userCredentials.userId, 'alice'));
    else await db.update(schema.personalCodexAccounts).set({ connected: false }).where(eq(schema.personalCodexAccounts.userId, 'alice'));
    const client = await CodexClient.connect(runtime);
    try {
      await expect(executeCodexSession(client, runtime, { funding: 'chatgpt_subscription', model: 'fixture-model', effort: 'medium' }, 'hello', '',
        { checkpoint: async () => {}, text: () => {} }, AbortSignal.timeout(2000))).rejects.toThrow('connection is no longer available');
    } finally { client.close(); }
    expect(seen.some(call => call.method === 'thread/start' || call.method === 'turn/start')).toBe(false);
  });
  it('persists native tool parts and continues the same owner-bound thread through the production run adapter', async () => {
    await managedConnection(); mode = 'agent_tools';
    const first = await options('alice'); const reply = await consume(first.opts);
    expect(reply.result.error).toBeUndefined();
    expect(reply.chunks.filter(c => c.type === 'tool-input-available')).toHaveLength(2);
    expect(reply.result.responseMessage.parts.some(p => p.type === 'dynamic-tool')).toBe(true);
    const stableBinding = (await db.select().from(schema.personalCodexAccounts))[0].credentialBinding;
    await db.update(schema.userCredentials).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.userCredentials.userId, 'alice'));
    fixture.refreshTokens.mockResolvedValue({ ok: true, tokens: { accessToken: 'fixture-managed-access-token-rotated', refreshToken: 'fixture-managed-refresh-token-rotated', expiresIn: 3600 } });
    await db.update(schema.agentRuns).set({ status: 'succeeded' }).where(eq(schema.agentRuns.id, first.runId));
    const next = await options('alice', 'followup');
    next.opts.conversation = first.opts.conversation;
    next.opts.history = [...first.opts.history, reply.result.responseMessage, { id: 'followup-user', role: 'user', parts: [{ type: 'text', text: 'Now update the report.' }] }];
    await db.update(schema.agentRuns).set({ conversationId: first.opts.conversation.id }).where(eq(schema.agentRuns.id, next.runId));
    expect((await consume(next.opts)).result.error).toBeUndefined();
    expect(fixture.refreshTokens).toHaveBeenCalledWith('fixture-managed-refresh-token', 'issued-client-id', undefined, 'fixture-managed-subject');
    expect(fixture.syncTokens[1]).toMatchObject({ owner: 'alice', accessToken: 'fixture-managed-access-token-rotated', credentialBinding: tokenFingerprint('fixture-managed-access-token-rotated') });
    expect(seen.filter(s => s.method === 'thread/start')).toHaveLength(1);
    expect(seen.filter(s => s.method === 'thread/resume')).toHaveLength(1);
    expect(seen.filter(s => s.method === 'turn/start')[1].params.input).toEqual([{ type: 'text', text: 'Now update the report.', text_elements: [] }]);
    expect((await db.select().from(schema.codexThreads))[0]).toMatchObject({ userId: 'alice', threadId: 'thread-alice', lastMessageId: next.opts.responseMessageId });
    expect((await db.select().from(schema.usageEvents)).map(row => row.inputTokens)).toEqual([7, 7]);
    expect(fixture.syncTokens[0]).toMatchObject({ owner: 'alice', accessToken: 'fixture-managed-access-token', credentialBinding: tokenFingerprint('fixture-managed-access-token') });
    expect((await db.select().from(schema.personalCodexAccounts))[0].credentialBinding).toBe(stableBinding);
    next.opts.history.at(-2)!.id = 'another-branch';
    await expect(runCodexTurn(next.opts)).rejects.toThrow('conversation branch');
  });
  it('requires the caller’s explicit decline for native escalation and never grants expanded permissions', async () => {
    await managedConnection(); mode = 'approval';
    const { opts } = await options('alice'); const running = consume(opts);
    await until(async () => (await db.select().from(schema.codexApprovals)).length === 1);
    const [approval] = await db.select().from(schema.codexApprovals);
    const { decideApproval } = await import('@/personal-codex/approvals');
    await expect(decideApproval('bob', 0, approval.id, 'decline')).rejects.toThrow('no longer pending');
    await decideApproval('alice', opts.principal.user.sessionVersion, approval.id, 'decline');
    const result = await running;
    expect(result.result.error).toBeUndefined();
    expect(result.result.responseMessage.parts.some(p => p.type === 'data-codex-approval' && (p.data as { state: string }).state === 'decline')).toBe(true);
    expect(serverReplies).toContainEqual({ id: 'approval', result: { decision: 'decline' } });
    await expect(decideApproval('alice', opts.principal.user.sessionVersion, approval.id, 'decline')).rejects.toThrow('no longer pending');
    expect(JSON.stringify(serverReplies)).not.toContain('accept');
  });
  it('expires pending approval callbacks when the owner cancels, without replay on reconnect', async () => {
    await managedConnection(); mode = 'approval';
    const { opts, runId } = await options('alice'); const stop = new AbortController(); opts.abortSignal = stop.signal;
    const running = consume(opts);
    await until(async () => (await db.select().from(schema.codexApprovals)).length === 1);
    stop.abort(); const cancelled = await running; expect(cancelled.result.error).toContain('stopped');
    expect(cancelled.result.responseMessage.parts.some(p => p.type === 'data-codex-approval' && (p.data as { state: string }).state === 'pending')).toBe(false);
    await until(async () => (await db.select().from(schema.codexApprovals))[0].decision === 'cancel');
    expect(seen.filter(s => s.method === 'turn/start')).toHaveLength(1);
    await stopCodexRun(runId);
    expect((await db.select().from(schema.codexRuns))[0].phase).toBe('terminal');
  });

  it('awaits a delayed account recheck before accepting terminal success', async () => {
    await managedConnection(); mode = 'switch_at_completion';
    const { opts } = await options('alice');
    const result = await consume(opts);
    expect(result.result.error).toContain('not synchronized with your verified ChatGPT connection');
    expect(result.chunks.find(c => c.type === 'finish')).toMatchObject({ finishReason: 'error' });
  });
  it('suppresses pre-ack approval callbacks already resolved by the native server', async () => {
    await managedConnection(); mode = 'resolved_approval';
    const { opts } = await options('alice');
    const result = await consume(opts);
    expect(result.result.error).toBeUndefined();
    expect(await db.select().from(schema.codexApprovals)).toHaveLength(0);
    expect(result.result.responseMessage.parts.some(p => p.type === 'data-codex-approval')).toBe(false);
    expect(serverReplies.some(r => (r as { id: string }).id === 'resolved-native')).toBe(false);
  });

});
