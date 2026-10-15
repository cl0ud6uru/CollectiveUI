import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeBudgetFixtureURL } from '../fixtures/native-budget/disposable-database';
import { budgetChild } from '../fixtures/native-budget/process-client';
import type { NativeRunBudgetPolicy } from '@/lib/llm/run-budget-policy';
import type { UsageContext } from '@/lib/llm/usage';

// Guard evaluated before any dynamic application or pg import; DATABASE_URL is never a fallback.
const enabled = process.env.NATIVE_BUDGET_POSTGRES_PROOF === '1';
const fixtureURL = enabled ? nativeBudgetFixtureURL() : undefined;
vi.mock('server-only', () => ({}));
vi.mock('@/lib/jobs', async original => ({ ...await original<typeof import('@/lib/jobs')>(), enqueueRun: vi.fn(async () => 'synthetic-job'), enqueue: vi.fn(async () => null), scheduleMemoryExtraction: vi.fn(async () => {}), getBoss: async () => { throw new Error('No live queue transport in the dedicated proof'); } }));
const sandbox = vi.hoisted(() => ({ exec: vi.fn(async () => ({ t: 'exit', code: 0, reason: 'exited', ms: 1, dropped: 0 })) }));
vi.mock('@/lib/sandbox/client', async original => ({ ...await original<typeof import('@/lib/sandbox/client')>(), sandboxd: () => ({ exec: sandbox.exec, kill: async () => ({ killed: false }) }) }));

const input = { prompt: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic race' }] }] };
const policy: NativeRunBudgetPolicy = { enabled: true, maxTokens: 1_000_000, maxCostMicros: 2_000_000, maxInputTokensPerCall: 500_000, maxOutputTokensPerCall: 64,
  routes: [{ provider: 'openai-compatible', model: 'fixture-budget', inputContract: 'conservative-text-v1', inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000 }] };
let q: typeof import('@/db'); let api: typeof import('@/lib/llm/run-budget-store');
let eq: typeof import('drizzle-orm')['eq'];
const children: Awaited<ReturnType<typeof budgetChild>>[] = [];
const ctx = (root: string, owner = 'owner'): UsageContext => ({ purpose: 'chat', billingSource: 'org', providerKind: 'openai-compatible', model: 'fixture-budget', appId: null, userId: owner, billingRoute: 'api:openai-compatible', scope: { pending: [], messageId: root, runId: `run-${root}`, rootBudgetId: root } });
async function root(id: string) { return (await q.db.select().from(q.schema.nativeRunBudgets).where(eq(q.schema.nativeRunBudgets.rootMessageId, id)))[0]; }
async function attempts(id: string) { return q.db.select().from(q.schema.nativeRunBudgetAttempts).where(eq(q.schema.nativeRunBudgetAttempts.rootMessageId, id)).orderBy(q.schema.nativeRunBudgetAttempts.createdAt); }
async function child(config = JSON.stringify(policy)) { const worker = await budgetChild(fixtureURL!, config); children.push(worker); return worker; }
async function contention(rootId: string, workers: Awaited<ReturnType<typeof child>>[], operation: (worker: Awaited<ReturnType<typeof child>>) => Promise<unknown>) {
  const lock = await q.pool.connect(); await lock.query('BEGIN');
  await lock.query('SELECT root_message_id FROM native_run_budgets WHERE root_message_id=$1 FOR UPDATE', [rootId]);
  const results = workers.map(operation);
  try {
    await vi.waitFor(async () => {
      const blocked = await q.pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid=ANY($1::int[]) AND wait_event_type='Lock'", [workers.map(worker => worker.backend)]);
      expect(blocked.rowCount).toBe(workers.length);
    }, { timeout: 15000 });
  } finally { await lock.query('COMMIT'); lock.release(); }
  return Promise.all(results);
}
async function migrateThrough(last: number) {
  const journal = JSON.parse(readFileSync('src/db/migrations/meta/_journal.json', 'utf8'));
  const entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= last);
  const directory = mkdtempSync(path.join(tmpdir(), 'native-budget-migrations-'));
  try {
    mkdirSync(path.join(directory, 'meta'));
    writeFileSync(path.join(directory, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
    for (const entry of entries) copyFileSync(`src/db/migrations/${entry.tag}.sql`, path.join(directory, `${entry.tag}.sql`));
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await migrate(q.db, { migrationsFolder: directory });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe.skipIf(!enabled)('required dedicated PostgreSQL native budget proof', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = fixtureURL!;
    process.env.DATABASE_POOL_MAX = '12';
    process.env.AUTH_SECRET = 'synthetic-native-budget-proof-secret';
    process.env.ENCRYPTION_KEY = 'synthetic-native-budget-proof-encryption';
    q = await import('@/db'); api = await import('@/lib/llm/run-budget-store'); ({ eq } = await import('drizzle-orm'));
    // Destructive setup is possible only after the exact dedicated URL/opt-in guard above.
    await q.pool.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public');
    await migrateThrough(58);
    expect((await q.pool.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='ai_apps' AND column_name='context_window_tokens'")).rows[0].n).toBe(0);
    await q.pool.query("INSERT INTO ai_apps(id,name,base_url,model) VALUES ('migration-preserved','Synthetic upgrade','http://127.0.0.1:9/v1','fixture-budget')");
    await migrateThrough(59);
    expect((await q.pool.query("SELECT context_window_tokens FROM ai_apps WHERE id='migration-preserved'")).rows).toEqual([{ context_window_tokens: null }]);
    expect((await q.pool.query("SELECT to_regclass('public.native_run_budgets') AS name")).rows[0].name).toBeNull();
    await migrateThrough(60); await migrateThrough(60);
    expect((await q.pool.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows[0].n).toBe(61);
    expect((await q.pool.query("SELECT extversion FROM pg_extension WHERE extname='vector'")).rowCount).toBe(1);
    expect((await q.pool.query("SELECT to_regclass('public.native_run_budget_attempts') AS name")).rows[0].name).toBe('native_run_budget_attempts');
  }, 60000);
  beforeEach(async () => {
    await q.pool.query('TRUNCATE users, ai_apps, settings CASCADE');
    await q.db.insert(q.schema.users).values(['owner', 'other'].map(id => ({ id, name: 'Synthetic fixture', upn: `${id}@fixture.invalid`, authSource: 'ldap' as const, prefs: { memoryEnabled: false } })));
    vi.stubEnv('NATIVE_RUN_BUDGET', JSON.stringify(policy));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No unplanned network or inference is permitted by this fixture'); }));
    sandbox.exec.mockClear();
  });
  afterEach(async () => { await Promise.all(children.splice(0).map(worker => worker.close())); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
  afterAll(async () => {
    if (!q) return;
    const { runHost } = await import('@/lib/runs/host'); const { runListener } = await import('@/lib/runs/listener');
    await runHost().shutdown(2000); await runListener().close(); await q.pool.end();
  });

  it.each(['tokens', 'money'] as const)('serializes separate processes blocked on one root without over-reserving %s', async cap => {
    const { nativeBudgetEnvelope } = await import('@/lib/llm/run-budget-policy');
    const quote = nativeBudgetEnvelope(policy, policy.routes[0], input, 64);
    const active = { ...policy, maxTokens: cap === 'tokens' ? quote.tokens * 2 : null, maxCostMicros: cap === 'money' ? quote.costMicros * 2 : null };
    vi.stubEnv('NATIVE_RUN_BUDGET', JSON.stringify(active));
    await api.nativeBudgetHandle(ctx('contended'));
    const workers = await Promise.all(Array.from({ length: 6 }, () => child(JSON.stringify(active))));
    expect(new Set(workers.map(worker => worker.pid)).size).toBe(6); expect(new Set(workers.map(worker => worker.backend)).size).toBe(6);
    const outcomes = await contention('contended', workers, worker => worker.command({ action: 'reserve', root: 'contended', owner: 'owner' })) as { receiptId?: string; error?: string }[];
    expect(outcomes.filter(result => result.receiptId)).toHaveLength(2);
    expect(outcomes.filter(result => result.error === 'NativeRunBudgetError')).toHaveLength(4);
    expect(await root('contended')).toMatchObject({ usedTokens: 0, reservedTokens: quote.tokens * 2, reservedCostMicros: quote.costMicros * 2 });
    expect(await attempts('contended')).toHaveLength(2);
  }, 45000);

  it('holds uncertainty and process death, and settles/releases each receipt once across process replays', async () => {
    const { nativeBudgetEnvelope } = await import('@/lib/llm/run-budget-policy'); const quote = nativeBudgetEnvelope(policy, policy.routes[0], input, 64);
    const active = { ...policy, maxTokens: quote.tokens * 2, maxCostMicros: null }; vi.stubEnv('NATIVE_RUN_BUDGET', JSON.stringify(active));
    await api.nativeBudgetHandle(ctx('replay'));
    const workers = await Promise.all(Array.from({ length: 4 }, () => child(JSON.stringify(active))));
    const first = (await workers[0].command({ action: 'reserve', root: 'replay', owner: 'owner' })).receiptId!;
    const second = (await workers[1].command({ action: 'reserve', root: 'replay', owner: 'owner' })).receiptId!;
    await workers[0].command({ action: 'dispatch', root: 'replay', owner: 'owner', receiptId: first });
    await workers[0].command({ action: 'settle', root: 'replay', owner: 'owner', receiptId: first, input: 11, output: null });
    await workers[1].command({ action: 'dispatch', root: 'replay', owner: 'owner', receiptId: second });
    await expect(workers[1].command({ action: 'crash', root: 'replay', owner: 'owner' })).rejects.toThrow('17');
    expect(await root('replay')).toMatchObject({ reservedTokens: quote.tokens * 2, usedTokens: 0 });
    const live = [workers[0], workers[2], workers[3]];
    await contention('replay', live, worker => worker.command({ action: 'settle', root: 'replay', owner: 'owner', receiptId: first, input: 11, output: 3 }));
    expect(await root('replay')).toMatchObject({ usedTokens: 14, usedCostMicros: 17, reservedTokens: quote.tokens, reservedCostMicros: quote.costMicros });
    await Promise.all(live.map(worker => worker.command({ action: 'release', root: 'replay', owner: 'owner', receiptId: second })));
    expect(await root('replay')).toMatchObject({ reservedTokens: quote.tokens });
    expect(await workers[0].command({ action: 'reserve', root: 'replay', owner: 'owner' })).toMatchObject({ error: 'NativeRunBudgetError' });
    const unset = await child('');
    expect(await unset.command({ action: 'reserve', root: 'replay', owner: 'owner' })).toMatchObject({ error: 'NativeRunBudgetError' });
    await unset.command({ action: 'settle', root: 'replay', owner: 'owner', receiptId: second, input: 25, output: 5 });
    expect(await root('replay')).toMatchObject({ usedTokens: 44, usedCostMicros: 52, reservedTokens: 0 });
    const predispatch = (await workers[0].command({ action: 'reserve', root: 'replay', owner: 'owner' })).receiptId!;
    await contention('replay', live, worker => worker.command({ action: 'release', root: 'replay', owner: 'owner', receiptId: predispatch }));
    expect(await root('replay')).toMatchObject({ usedTokens: 44, reservedTokens: 0 });
    expect(await workers[0].command({ action: 'dispatch', root: 'replay', owner: 'owner', receiptId: predispatch })).toMatchObject({ error: 'NativeRunBudgetError' });
  }, 45000);

  it('isolates roots/owners and enforces PostgreSQL receipt/counter constraints', async () => {
    await api.nativeBudgetHandle(ctx('owner-root')); await api.nativeBudgetHandle(ctx('other-root', 'other'));
    const workers = await Promise.all([child(), child()]);
    const admitted = await Promise.all([workers[0].command({ action: 'reserve', root: 'owner-root', owner: 'owner' }), workers[1].command({ action: 'reserve', root: 'other-root', owner: 'other' })]);
    expect(admitted.every(result => result.receiptId)).toBe(true);
    expect(await workers[1].command({ action: 'reserve', root: 'owner-root', owner: 'other' })).toMatchObject({ error: 'NativeRunBudgetError' });
    expect(await attempts('owner-root')).toHaveLength(1); expect(await attempts('other-root')).toHaveLength(1);
    for (const statement of ["UPDATE native_run_budgets SET used_tokens=-1 WHERE root_message_id='owner-root'", "UPDATE native_run_budget_attempts SET state='invented' WHERE id=$1", 'UPDATE native_run_budget_attempts SET input_reserved=-1 WHERE id=$1'])
      await expect(q.pool.query(statement, statement.includes('$1') ? [admitted[0].receiptId] : [])).rejects.toMatchObject({ code: '23514' });
    expect((await attempts('owner-root'))[0].state).toBe('reserved');
  }, 30000);

  type Script = { text?: string; tool?: { name: string; args: object }; chargeQuote?: boolean; overage?: boolean; failure?: boolean; after?: () => void };
  let scripts: Script[] = []; let calls: Record<string, unknown>[] = [];
  function provider(...steps: Script[]) {
    scripts = steps; calls = [];
    vi.stubGlobal('fetch', vi.fn(async (target, init) => {
      if (String(target) !== 'http://127.0.0.1:9/v1/chat/completions') throw new Error('Synthetic proof refuses every other network target');
      const body = JSON.parse(String(init?.body)); calls.push(body);
      const step = scripts.shift(); if (!step) throw new Error('Unexpected synthetic provider dispatch');
      expect(body.max_tokens).toBe(64);
      step.after?.();
      if (step.failure) return new Response('Synthetic unavailable', { status: 503 });
      const latest = (await q.pool.query("SELECT input_reserved,output_reserved FROM native_run_budget_attempts WHERE state='dispatched' ORDER BY created_at DESC LIMIT 1")).rows[0];
      const inputTokens = step.chargeQuote ? Number(latest.input_reserved) + (step.overage ? 1 : 0) : 3;
      const outputTokens = step.chargeQuote ? Number(latest.output_reserved) : 2;
      if (!body.stream) return Response.json({ id: 'synthetic-completion', object: 'chat.completion', created: 1, model: 'fixture-budget',
        choices: [{ index: 0, message: { role: 'assistant', content: step.text ?? 'Synthetic result' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } });
      const chunk = (delta: unknown, finish: string | null = null, choices?: unknown[]) => `data: ${JSON.stringify({ id: 'synthetic-completion', object: 'chat.completion.chunk', created: 1, model: 'fixture-budget', choices: choices ?? [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      let wire = chunk({ role: 'assistant', content: '' });
      if (step.tool) {
        wire += chunk({ tool_calls: [{ index: 0, id: `synthetic-call-${calls.length}`, type: 'function', function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }] });
        wire += chunk({}, 'tool_calls');
      } else { wire += chunk({ content: step.text ?? 'Synthetic result' }); wire += chunk({}, 'stop'); }
      wire += `data: ${JSON.stringify({ id: 'synthetic-completion', object: 'chat.completion.chunk', created: 1, model: 'fixture-budget', choices: [], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } })}\n\ndata: [DONE]\n\n`;
      return new Response(wire, { headers: { 'Content-Type': 'text/event-stream' } });
    }));
  }
  async function setupHarness(workspace = false, maxSteps = 20) {
    const { loadPrincipal } = await import('@/lib/auth/groups');
    await q.db.update(q.schema.users).set({ prefs: { memoryEnabled: true } }).where(eq(q.schema.users.id, 'owner'));
    const [app] = await q.db.insert(q.schema.aiApps).values({ id: 'model', name: 'Synthetic model', provider: 'openai-compatible', model: 'fixture-budget', baseUrl: 'http://127.0.0.1:9/v1', supportsTools: true, maxTokens: 1000, contextWindowTokens: 1_000_000, isPublic: true }).returning();
    const bots = await q.db.insert(q.schema.bots).values(['Queen', 'Worker', 'Writer'].map(name => ({ id: name.toLowerCase(), ownerId: 'owner', appId: app.id, name, maxSteps, visibility: 'org' as const }))).returning();
    await q.db.insert(q.schema.botDelegates).values({ botId: 'queen', delegateBotId: 'worker' });
    await q.db.insert(q.schema.botTools).values({ botId: 'queen', toolKey: 'memory', approval: 'ask' });
    if (workspace) {
      const { setSetting } = await import('@/lib/settings');
      await setSetting('sandbox', { enabled: true, access: 'everyone', allowedGroupIds: [], allowedUpns: [], allowRunc: false, commandTimeoutSec: 120, outputKb: 32, deleteAfterDays: 30 });
      await q.db.insert(q.schema.botTools).values({ botId: 'worker', toolKey: 'workspace', approval: 'auto' });
    }
    return { app, bots, principal: (await loadPrincipal('owner'))! };
  }
  async function group(harness: Awaited<ReturnType<typeof setupHarness>>) {
    const { insertMessage } = await import('@/lib/chat/store'); const { runGroupTurn } = await import('@/lib/agent/group');
    const [conversation] = await q.db.insert(q.schema.conversations).values({ userId: 'owner', isGroup: true, title: 'Synthetic group' }).returning();
    const history = [{ id: `question-${conversation.id}`, role: 'user' as const, parts: [{ type: 'text' as const, text: 'Please begin' }] }];
    await insertMessage(conversation.id, history[0], null);
    const stream = await runGroupTurn({ principal: harness.principal, conversation, members: ['worker', 'writer'].map(id => ({ bot: harness.bots.find(bot => bot.id === id)!, app: harness.app })), history });
    const reader = stream.getReader(); const chunks = [];
    for (;;) { const part = await reader.read(); if (part.done) break; chunks.push(part.value); }
    const start = chunks.find(chunk => chunk.type === 'start');
    if (!start || start.type !== 'start') throw new Error('Missing persisted group reply identity');
    return { id: start.messageId!, chunks };
  }
  async function start(harness: Awaited<ReturnType<typeof setupHarness>>, text: string) {
    const { startRun } = await import('@/lib/runs/store'); const { newId } = await import('@/lib/ids');
    const [conversation] = await q.db.insert(q.schema.conversations).values({ userId: 'owner', botId: 'queen', title: 'Synthetic durable origin' }).returning();
    const run = await startRun({ principal: harness.principal, conversation, app: harness.app, bot: harness.bots.find(bot => bot.id === 'queen')!, parentId: null, userMessage: { id: newId(), role: 'user', parts: [{ type: 'text', text }] } });
    return { conversation, run };
  }
  async function saved(id: string) { return (await q.db.select().from(q.schema.messages).where(eq(q.schema.messages.id, id)))[0]; }

  it('charges two real group speakers under their persisted reply root with frozen policy and provider output clamps', async () => {
    const harness = await setupHarness();
    provider({ text: '@Writer please finish', after: () => vi.stubEnv('NATIVE_RUN_BUDGET', JSON.stringify({ ...policy, maxTokens: 1 })) }, { text: 'Finished' });
    const result = await group(harness);
    expect(calls).toHaveLength(2); expect(result.chunks.filter(chunk => chunk.type === 'data-bot-error')).toHaveLength(0);
    const receipts = await attempts(result.id); expect(receipts).toHaveLength(2);
    expect(new Set(receipts.map(row => row.rootMessageId))).toEqual(new Set([result.id]));
    expect(receipts.every(row => row.state === 'settled' && row.outputReserved === 64)).toBe(true);
    expect(await root(result.id)).toMatchObject({ policy, usedTokens: 10, usedCostMicros: 14, reservedTokens: 0, reservedCostMicros: 0 });
    expect((await saved(result.id)).role).toBe('assistant');
    expect((await q.db.select().from(q.schema.usageEvents)).every(row => row.messageId === result.id)).toBe(true);
  }, 30000);

  it('denies a second group speaker before provider dispatch at the shared cap and gives a later turn a separate root', async () => {
    const harness = await setupHarness();
    provider({ text: '@Writer please finish', chargeQuote: true }, { text: 'Finished' });
    const calibration = await group(harness); const first = (await attempts(calibration.id))[0];
    const cap = first.inputReserved + first.outputReserved;
    vi.stubEnv('NATIVE_RUN_BUDGET', JSON.stringify({ ...policy, maxTokens: cap, maxCostMicros: null }));
    provider({ text: '@Writer please finish', chargeQuote: true });
    const bounded = await group(harness);
    expect(calls).toHaveLength(1); expect(bounded.chunks.filter(chunk => chunk.type === 'data-bot-error')).toHaveLength(1);
    expect(await root(bounded.id)).toMatchObject({ usedTokens: cap, reservedTokens: 0 });
    expect(await attempts(bounded.id)).toHaveLength(1);
    provider({ text: '@Writer please finish', chargeQuote: true });
    const next = await group(harness);
    expect(next.id).not.toBe(bounded.id); expect(calls).toHaveLength(1); expect(await attempts(next.id)).toHaveLength(1);
  }, 30000);

  it('executes a durable approval continuation on its original charged root after configuration is disabled, without replay charges', async () => {
    const harness = await setupHarness();
    const { executeRun } = await import('@/lib/runs/execute'); const { getRun } = await import('@/lib/runs/state'); const { continueRun } = await import('@/lib/runs/store');
    provider({ tool: { name: 'remember', args: { fact: 'Synthetic durable budget proof' } } }, { text: 'Remembered' });
    const setup = await start(harness, 'Remember this synthetic fact'); await executeRun(setup.run.id);
    expect(await getRun(setup.run.id)).toMatchObject({ status: 'waiting', segment: 0 });
    const card = (await saved(setup.run.messageId)).parts as { state?: string; approval?: { id: string } }[];
    const approval = card.find(part => part.state === 'approval-requested')!.approval!.id;
    vi.stubEnv('NATIVE_RUN_BUDGET', '');
    await continueRun({ principal: harness.principal, conversation: setup.conversation, messageId: setup.run.messageId, decisions: new Map([[approval, { approved: true }]]) });
    await executeRun(setup.run.id); await executeRun(setup.run.id);
    expect(await getRun(setup.run.id)).toMatchObject({ status: 'succeeded', segment: 1 }); expect(calls).toHaveLength(2);
    const receipts = await attempts(setup.run.messageId); expect(receipts).toHaveLength(2);
    expect(receipts.every(row => row.runId === setup.run.id && row.state === 'settled')).toBe(true);
    expect(await root(setup.run.messageId)).toMatchObject({ policy, usedTokens: 10, reservedTokens: 0 });
    expect(await q.db.select().from(q.schema.memories)).toHaveLength(1);
  }, 30000);

  it('preserves the merged exhausted-step approval preflight before committing a decision', async () => {
    const harness = await setupHarness(false, 1); const { executeRun } = await import('@/lib/runs/execute'); const { continueRun } = await import('@/lib/runs/store');
    provider({ tool: { name: 'remember', args: { fact: 'Must stay unapproved' } } });
    const setup = await start(harness, 'Synthetic last-step approval'); await executeRun(setup.run.id);
    const before = (await saved(setup.run.messageId)).parts; const approval = (before as { state?: string; approval?: { id: string } }[]).find(part => part.state === 'approval-requested')!.approval!.id;
    await expect(continueRun({ principal: harness.principal, conversation: setup.conversation, messageId: setup.run.messageId, decisions: new Map([[approval, { approved: true }]]) })).rejects.toMatchObject({ status: 409 });
    expect((await saved(setup.run.messageId)).parts).toEqual(before); expect(await q.db.select().from(q.schema.memories)).toHaveLength(0); expect(calls).toHaveLength(1);
  }, 30000);

  async function pausedChild() {
    const harness = await setupHarness(true); const { executeRun } = await import('@/lib/runs/execute'); const { getRun } = await import('@/lib/runs/state');
    provider({ tool: { name: 'ask_worker_worker', args: { task: 'Synthetic workspace task', mode: 'async' } } }, { tool: { name: 'workspace_bash', args: { command: 'printf synthetic' } } });
    const setup = await start(harness, 'Delegate this synthetic workspace task'); await executeRun(setup.run.id);
    expect(await getRun(setup.run.id)).toMatchObject({ status: 'waiting_tasks' });
    const [task] = await q.db.select().from(q.schema.delegatedTasks).where(eq(q.schema.delegatedTasks.parentRunId, setup.run.id));
    await executeRun(task.childRunId!); expect(await getRun(task.childRunId!)).toMatchObject({ status: 'waiting' });
    const { pendingTaskApprovals } = await import('@/lib/delegation/approvals'); const [request] = await pendingTaskApprovals(harness.principal, setup.conversation.id);
    expect(request).toBeDefined(); expect(sandbox.exec).not.toHaveBeenCalled();
    return { ...setup, harness, task, request };
  }
  it('charges real parent delegation, child approval/resume and parent resume to one root with actual run identities', async () => {
    const setup = await pausedChild(); const { answerTaskApproval } = await import('@/lib/delegation/approvals'); const { executeRun } = await import('@/lib/runs/execute'); const { getRun } = await import('@/lib/runs/state');
    expect(await attempts(setup.run.messageId)).toHaveLength(2); vi.stubEnv('NATIVE_RUN_BUDGET', '');
    scripts.push({ text: 'Synthetic child finished' }, { text: 'Synthetic parent finished' });
    await answerTaskApproval(setup.harness.principal, setup.conversation.id, { runId: setup.request.runId, approvalId: setup.request.part.approval!.id, approved: true });
    await executeRun(setup.task.childRunId!); expect(await getRun(setup.task.childRunId!)).toMatchObject({ status: 'succeeded' });
    await executeRun(setup.run.id); expect(await getRun(setup.run.id)).toMatchObject({ status: 'succeeded', segment: 1 });
    await executeRun(setup.task.childRunId!); await executeRun(setup.run.id);
    const receipts = await attempts(setup.run.messageId); expect(receipts).toHaveLength(4);
    expect(receipts.map(row => row.runId).sort()).toEqual([setup.run.id, setup.run.id, setup.task.childRunId, setup.task.childRunId].sort());
    expect(await q.db.select().from(q.schema.nativeRunBudgets)).toHaveLength(1);
    expect(await root(setup.run.messageId)).toMatchObject({ policy, usedTokens: 20, reservedTokens: 0 });
    expect(sandbox.exec).toHaveBeenCalledTimes(1); expect(calls).toHaveLength(4);
  }, 45000);

  it.each(['exhausted', 'uncertain'] as const)('refuses resumed child/parent model dispatch on a shared %s root without refund or child budget', async reason => {
    const setup = await pausedChild(); const { resolveModel, newUsageScope } = await import('@/lib/llm'); const { generateText } = await import('ai');
    const scope = newUsageScope({ runId: setup.run.id, messageId: setup.run.messageId, rootBudgetId: setup.run.messageId });
    const model = (await resolveModel(setup.harness.app, { purpose: 'draft', principal: setup.harness.principal, usage: scope })).model;
    if (reason === 'exhausted') {
      scripts.push({ text: 'Synthetic overage', chargeQuote: true, overage: true });
      await generateText({ model, prompt: 'Synthetic provider counter overage', maxRetries: 0 });
      expect((await root(setup.run.messageId)).exhausted).toBe(true);
    } else {
      for (const size of [150000, 1000, 0]) for (let retry = 0; retry < 200; retry++) {
        scripts.push({ failure: true });
        try { await generateText({ model, prompt: 'x'.repeat(size) || 'Synthetic', maxRetries: 0 }); throw new Error('Synthetic failed dispatch unexpectedly succeeded'); }
        catch (error) {
          if ((error as Error).name === 'NativeRunBudgetError') { scripts.pop(); break; }
          expect((error as Error).name).toMatch(/AI_APICallError/);
        }
      }
      expect((await root(setup.run.messageId)).reservedTokens).toBeGreaterThan(0);
    }
    const before = await root(setup.run.messageId); const receiptCount = (await attempts(setup.run.messageId)).length; const dispatched = calls.length;
    vi.stubEnv('NATIVE_RUN_BUDGET', '');
    const { answerTaskApproval } = await import('@/lib/delegation/approvals'); const { executeRun } = await import('@/lib/runs/execute'); const { getRun } = await import('@/lib/runs/state');
    await answerTaskApproval(setup.harness.principal, setup.conversation.id, { runId: setup.request.runId, approvalId: setup.request.part.approval!.id, approved: true });
    await executeRun(setup.task.childRunId!);
    expect(await getRun(setup.task.childRunId!)).toMatchObject({ status: 'failed', error: expect.stringContaining('budget') });
    await executeRun(setup.run.id); expect(await getRun(setup.run.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('budget') });
    expect(sandbox.exec).toHaveBeenCalledTimes(1); // Approval authorizes this tool; model admission is a separate boundary.
    expect(calls).toHaveLength(dispatched); expect(await attempts(setup.run.messageId)).toHaveLength(receiptCount);
    expect(await q.db.select().from(q.schema.nativeRunBudgets)).toHaveLength(1);
    expect(await root(setup.run.messageId)).toMatchObject({ usedTokens: before.usedTokens, reservedTokens: before.reservedTokens });
  }, 60000);
});
