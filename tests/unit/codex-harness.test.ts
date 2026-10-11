import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { PersistTurnInput } from '@/lib/agent/persist';
import type { TurnOptions } from '@/lib/agent/run';

const fixture = vi.hoisted(() => ({ client: null as PGlite | null }));
vi.mock('server-only', () => ({}));
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

const server = createServer(), wss = new WebSocketServer({ server });
let root: string, origin: string;
let mode: 'normal' | 'hold' | 'lost_ack' | 'approval' | 'wrong_account' | 'unreachable_stop' | 'switch_preflight' | 'native_tool' | 'completed_tool' | 'completed_text' = 'normal';
const seen: { owner: string; method: string; params: Record<string, unknown> }[] = [];
let subscription = false;
const states = new Map<string, { id: string; status: string }>();
const send = (ws: WebSocket, value: unknown) => ws.send(JSON.stringify(value));
wss.on('connection', (ws, req) => {
  const owner = req.url!.slice(1);
  expect(req.headers.authorization).toBe(`Bearer fixture-only-${owner}-transport-token-00000000`);
  ws.on('message', bytes => {
    const m = JSON.parse(bytes.toString());
    if (!m.method) return;
    seen.push({ owner, method: m.method, params: m.params });
    const reply = (result: unknown) => send(ws, { id: m.id, result });
    const notification = (method: string, params: unknown) => send(ws, { method, params });
    if (m.method === 'initialize') reply({ userAgent: `codex_cli_rs/${CODEX_VERSION} (Linux)` });
    else if (m.method === 'account/read') reply({ account: mode === 'wrong_account' || subscription ? { type: 'chatgpt', email: mode === 'wrong_account' ? 'other@test.invalid' : `${owner}@test.invalid`, planType: 'business' } : { type: 'apiKey' }, requiresOpenaiAuth: true });
    else if (m.method === 'config/read') reply({ config: subscription ? { forced_login_method: 'chatgpt', forced_chatgpt_workspace_id: 'shared-workspace' } : {} });
    else if (m.method === 'model/list') { if (mode === 'switch_preflight') notification('account/updated', { authMode: 'chatgpt' }); reply({ data: [{ model: 'fixture-model', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }], nextCursor: null }); }
    else if (m.method === 'thread/start') reply({ thread: { id: `thread-${owner}` }, model: 'fixture-model', modelProvider: 'openai', cwd: '/audit',
      approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false } });
    else if (m.method === 'turn/start') {
      const threadId = String(m.params.threadId), turnId = `turn-${owner}`;
      states.set(threadId, { id: turnId, status: 'inProgress' });
      if (mode === 'lost_ack' || mode === 'unreachable_stop') { ws.terminate(); return; }
      if (mode === 'hold') { reply({ turn: { id: turnId } }); return; }
      if (mode === 'approval') {
        reply({ turn: { id: turnId } }); send(ws, { id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId, turnId } }); return;
      }
      if (mode === 'native_tool' || mode === 'completed_tool') { reply({ turn: { id: turnId } }); notification(mode === 'completed_tool' ? 'item/completed' : 'item/started', { threadId, turnId, item: { type: 'fileChange' } }); return; }
      // Real race: events may be delivered before the turn/start response. Foreign events cannot contaminate it.
      notification('item/agentMessage/delta', { threadId: 'foreign', turnId, itemId: 'bad', delta: 'not yours' });
      notification('item/agentMessage/delta', { threadId, turnId: 'foreign', itemId: 'bad', delta: 'not yours either' });
      if (mode !== 'completed_text') notification('item/agentMessage/delta', { threadId, turnId, itemId: 'answer', delta: `Hello ${owner}` });
      notification('item/completed', { threadId, turnId, item: { id: 'answer', type: 'agentMessage', text: `Hello ${owner}` } });
      notification('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: { inputTokens: 7, outputTokens: 3, cachedInputTokens: 2, reasoningOutputTokens: 1 }, last: { inputTokens: 2, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0 } } });
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
}, 45000);
beforeEach(async () => {
  mode = 'normal'; subscription = false; seen.length = 0; states.clear();
  await fixture.client!.exec('TRUNCATE users, ai_apps, codex_runs CASCADE');
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
});
