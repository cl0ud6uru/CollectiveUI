import { readFileSync, readdirSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { Principal } from '@/lib/auth/groups';
import type { Tx } from '@/db';
import type { ResolveModelOptions } from '@/lib/llm';
const fixture = vi.hoisted(() => ({ client: null as PGlite | null, principal: null as Principal | null, query: null as Tx | null,
  sql: [] as string[], generate: vi.fn(), resolve: vi.fn<(app: unknown, options: ResolveModelOptions) => Promise<{ model: object }>>(async () => ({ model: {} })),
  embed: vi.fn<typeof import('@/lib/llm').embedTexts>(async () => null) }));
vi.mock('server-only', () => ({}));
vi.mock('@/db', async () => {
  const { PGlite } = await import('@electric-sql/pglite'), { drizzle } = await import('drizzle-orm/pglite'), schema = await import('@/db/schema');
  fixture.client = new PGlite(); return { db: drizzle(fixture.client, { schema, logger: { logQuery: (query: string) => { fixture.sql.push(query); } } }), schema };
});
vi.mock('ai', async original => ({ ...await original<typeof import('ai')>(), generateText: fixture.generate }));
vi.mock('@/lib/llm', async original => ({ ...await original<typeof import('@/lib/llm')>(), resolveModel: fixture.resolve, embedTexts: fixture.embed }));
vi.mock('@/lib/session', () => ({ requirePrincipal: async () => fixture.principal }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/jobs', () => ({ enqueue: vi.fn(async () => 'fixture'), QUEUES: { learningReview: 'learning.review' } }));
vi.mock('@/lib/hermes-team/learning', async original => {
  const learning = await original<typeof import('@/lib/hermes-team/learning')>();
  return { ...learning, withNonTeamLearning: <T>(id: string, skip: T, work: (q: Tx) => Promise<T>, onSkip?: (q: Tx) => Promise<void>) =>
    learning.withNonTeamLearning(id, skip, async q => { fixture.query = q; try { return await work(q); } finally { fixture.query = null; } }, onSkip) };
});
import { db, schema } from '@/db';
import { loadPrincipal } from '@/lib/auth/groups';
import { configureTeam } from '@/lib/hermes-team/store';
import { extractMemoriesFromConversation } from '@/lib/agent/memory';
import { reviewNativeRun } from '@/lib/agent/learning/review';
import { addKnowledgeFile, draftSkillFromConversation } from '@/app/(chat)/bots/actions';
import { recordUsage } from '@/lib/llm/usage';
let admin: Principal;
const teamInput = { modelPolicy: { mode: 'personal_required' }, maintainerIds: ['admin'], enabled: true, expectedVersion: 0 };
const convert = () => configureTeam(admin, 'bot', teamInput);
const companyCalls = () => { expect(fixture.generate).not.toHaveBeenCalled(); expect(fixture.resolve).not.toHaveBeenCalled(); expect(fixture.embed).not.toHaveBeenCalled(); };
function assertBotLockHeld() {
  const share = fixture.sql.findLastIndex(query => /from "bots".*for share/i.test(query));
  expect(share).toBeGreaterThan(-1);
  expect(fixture.sql.slice(share).some(query => /^(commit|rollback)/i.test(query))).toBe(false);
}
async function convertBeforeAdmission() {
  const original = db.transaction.bind(db);
  vi.spyOn(db, 'transaction').mockImplementationOnce(async (...args: Parameters<typeof db.transaction>) => { await convert(); return original(...args); });
}
beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync('src/db/migrations').filter(name => name.endsWith('.sql')).sort())
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, 'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;', '').replace(/\bvector\b/g, 'real[]'));
}, 45000);
beforeEach(async () => {
  vi.restoreAllMocks(); vi.clearAllMocks(); fixture.query = null; fixture.sql.length = 0;
  vi.stubEnv('HERMES_TEAM_BOTS_ENABLED', '1');
  await fixture.client!.exec('TRUNCATE users, ai_apps, settings CASCADE');
  await db.insert(schema.users).values({ id: 'admin', name: 'Admin', upn: 'admin@test.invalid', authSource: 'local', identityRealm: 'local', isAdmin: true });
  admin = (await loadPrincipal('admin'))!; fixture.principal = admin;
  await db.insert(schema.aiApps).values({ id: 'model', name: 'Company fixture', provider: 'openai', model: 'synthetic', supportsTools: true, isPublic: true });
  await db.insert(schema.settings).values({ key: 'tools', value: { utilityAppId: 'model' } });
  await db.insert(schema.bots).values({ id: 'bot', name: 'Ordinary native bot', ownerId: 'admin', appId: 'model', visibility: 'org' });
  await db.insert(schema.conversations).values({ id: 'chat', userId: 'admin', botId: 'bot', appId: 'model', currentLeafId: 'reply' });
  await db.insert(schema.messages).values([
    { id: 'prompt', conversationId: 'chat', role: 'user', parts: [{ type: 'text', text: 'Remember my preferred report format.' }] },
    { id: 'reply', conversationId: 'chat', parentId: 'prompt', role: 'assistant', parts: [{ type: 'text', text: 'Synthetic reply.' }] },
  ]);
  await db.insert(schema.agentRuns).values({ id: 'run', userId: 'admin', conversationId: 'chat', botId: 'bot', appId: 'model', messageId: 'reply', parentMessageId: 'prompt', status: 'succeeded' });
  await db.insert(schema.botLearningReviews).values({ runId: 'run' });
  await db.insert(schema.attachments).values({ id: 'file', userId: 'admin', filename: 'guide.txt', mediaType: 'text/plain', size: 20, storageKey: 'fixture', extractedText: 'Synthetic company knowledge.' });
  fixture.generate.mockResolvedValue({ output: { lessons: [], memories: [], name: 'Fixture skill', description: 'Fixture', instructions: 'Steps', expectedOutput: '', boundaries: '' } });
  fixture.embed.mockResolvedValue(null); fixture.sql.length = 0;
});
afterAll(async () => { await fixture.client!.close(); vi.unstubAllEnvs(); });

describe('Team conversion fences company utility admission', () => {
  it.each(['memory', 'review', 'draft', 'knowledge'])('makes zero provider calls when conversion wins admission: %s', async target => {
    await convertBeforeAdmission();
    if (target === 'memory') expect(await extractMemoriesFromConversation('chat')).toBe(0);
    if (target === 'review') { expect(await reviewNativeRun('run')).toBe(0); expect((await db.select().from(schema.botLearningReviews))[0].completedAt).not.toBeNull(); }
    if (target === 'draft') await expect(draftSkillFromConversation('chat')).rejects.toMatchObject({ status: 409 });
    if (target === 'knowledge') await expect(addKnowledgeFile('bot', 'file')).rejects.toMatchObject({ status: 400 });
    companyCalls(); expect(await db.select().from(schema.memories)).toHaveLength(0); expect(await db.select().from(schema.knowledgeChunks)).toHaveLength(0);
  });
  it('rejects native profile knowledge files before company embedding even when the utility model is configured', async () => {
    await db.update(schema.aiApps).set({ provider: 'hermes', baseUrl: 'http://native.test.invalid', providerConfig: { local: {} } }).where(eq(schema.aiApps.id, 'model'));
    await expect(addKnowledgeFile('bot', 'file')).rejects.toMatchObject({ status: 400 }); companyCalls();
  });
  it('holds the shared bot lock through ordinary memory generation/embedding/save and blocks conversion until completion', async () => {
    let conversion: Promise<unknown> | undefined, converted = false;
    fixture.generate.mockImplementation(async options => {
      assertBotLockHeld(); expect(fixture.query).not.toBeNull(); expect(options.abortSignal).toBeInstanceOf(AbortSignal); expect(options.maxRetries).toBe(0);
      conversion = convert().then(result => { converted = true; return result; });
      await new Promise(resolve => setTimeout(resolve, 25)); expect(converted).toBe(false);
      return { output: { memories: [{ content: 'Prefers brief report summaries.', shared: false }] } };
    });
    fixture.embed.mockImplementation(async (_texts, _context, options) => { assertBotLockHeld(); expect(options!.abortSignal).toBeInstanceOf(AbortSignal); expect(options!.maxRetries).toBe(0); return null; });
    expect(await extractMemoriesFromConversation('chat')).toBe(1); await conversion;
    expect(converted).toBe(true); expect(fixture.generate).toHaveBeenCalledTimes(1); expect(fixture.embed).toHaveBeenCalledTimes(1);
    expect((await db.select().from(schema.bots))[0].hermesTeam).toBe(true); expect((await db.select().from(schema.memories))[0].content).toBe('Prefers brief report summaries.');
    expect(await extractMemoriesFromConversation('chat')).toBe(0); expect(fixture.generate).toHaveBeenCalledTimes(1);
  });
  it('keeps ordinary skill drafting available with a shared lock, transaction queries and a bounded utility call', async () => {
    fixture.generate.mockImplementation(async options => { assertBotLockHeld(); expect(options.abortSignal).toBeInstanceOf(AbortSignal); expect(options.maxRetries).toBe(0);
      return { output: { name: 'Fixture skill', description: 'Synthetic draft', instructions: 'Read and report.', expectedOutput: '', boundaries: '' } }; });
    expect(await draftSkillFromConversation('chat')).toMatchObject({ name: 'Fixture skill', botId: 'bot' });
    expect(fixture.generate).toHaveBeenCalledTimes(1); expect(fixture.embed).not.toHaveBeenCalled();
  });
  it('embeds and saves an ordinary knowledge file under its shared row lock without a lock upgrade or global query deadlock', async () => {
    fixture.embed.mockImplementation(async (_texts, _context, options) => { assertBotLockHeld(); expect(options!.abortSignal).toBeInstanceOf(AbortSignal); expect(options!.maxRetries).toBe(0); expect(options!.q).toBeDefined(); return null; });
    expect(await addKnowledgeFile('bot', 'file')).toEqual({ chunks: 1, embedded: false });
    expect(await db.select().from(schema.knowledgeChunks)).toHaveLength(1); expect(fixture.embed).toHaveBeenCalledTimes(1);
    expect(fixture.sql.some(query => /from "bots".*for update/i.test(query))).toBe(false);
    expect(fixture.generate).not.toHaveBeenCalled();
  });
  it('keeps failed native reviews bounded and persists attempts while holding the admission fence', async () => {
    fixture.generate.mockImplementation(async options => { assertBotLockHeld(); expect(options.maxRetries).toBe(0); throw new Error('Synthetic utility error'); });
    for (let attempt = 0; attempt < 3; attempt++) await expect(reviewNativeRun('run')).rejects.toThrow('Synthetic utility error');
    expect(await reviewNativeRun('run')).toBe(0); expect(fixture.generate).toHaveBeenCalledTimes(3);
    expect((await db.select().from(schema.botLearningReviews))[0].attempts).toBe(3);
  });
  it.each(['memory', 'draft', 'review'])('drains and retains charged usage after a synthetic structured-output failure: %s', async target => {
    fixture.generate.mockImplementation(async () => {
      const options = fixture.resolve.mock.calls.at(-1)![1];
      void recordUsage({ purpose: options.purpose, billingSource: 'org', providerKind: 'openai', model: 'synthetic', appId: 'model', userId: 'admin', conversationId: 'chat', scope: options.usage },
        { inputTokens: 7, outputTokens: 3, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null });
      throw new Error('Synthetic invalid structured output');
    });
    await expect(target === 'memory' ? extractMemoriesFromConversation('chat') : target === 'draft' ? draftSkillFromConversation('chat') : reviewNativeRun('run')).rejects.toThrow('Synthetic invalid structured output');
    expect(await db.select().from(schema.usageEvents)).toMatchObject([{ inputTokens: 7, outputTokens: 3 }]);
    expect(await db.select().from(schema.memories)).toHaveLength(0);
    expect((await db.select().from(schema.conversations))[0].memoryProcessedAt).toBeNull();
  });
  it('restores generation and embedding usage after failed memory persistence without saving partial memories', async () => {
    await fixture.client!.exec("CREATE FUNCTION reject_fixture_memory() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic memory write failure'; END $$; CREATE TRIGGER reject_fixture_memory BEFORE INSERT ON memories FOR EACH ROW EXECUTE FUNCTION reject_fixture_memory();");
    fixture.generate.mockImplementation(async () => {
      const options = fixture.resolve.mock.calls.at(-1)![1];
      await recordUsage({ purpose: 'memory', billingSource: 'org', providerKind: 'openai', model: 'synthetic', appId: 'model', userId: 'admin', scope: options.usage },
        { inputTokens: 7, outputTokens: 3, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null });
      return { output: { memories: [{ content: 'Synthetic durable fact.', shared: false }] } };
    });
    fixture.embed.mockImplementation(async (_texts, _ctx, options) => {
      await recordUsage({ purpose: 'embedding', billingSource: 'org', providerKind: 'openai', model: 'synthetic', appId: 'model', userId: 'admin', scope: options!.usage },
        { inputTokens: 4, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null });
      return null;
    });
    try {
      await expect(extractMemoriesFromConversation('chat')).rejects.toMatchObject({ cause: { message: 'synthetic memory write failure' } });
      expect(await db.select().from(schema.usageEvents)).toHaveLength(2);
      expect(await db.select().from(schema.memories)).toHaveLength(0);
      expect((await db.select().from(schema.conversations))[0].memoryProcessedAt).toBeNull();
    } finally { await fixture.client!.exec('DROP TRIGGER reject_fixture_memory ON memories; DROP FUNCTION reject_fixture_memory();'); }
  });
  it('retains paid embedding usage after a knowledge save rolls back', async () => {
    await fixture.client!.exec("CREATE FUNCTION reject_fixture_knowledge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic knowledge write failure'; END $$; CREATE TRIGGER reject_fixture_knowledge BEFORE INSERT ON knowledge_chunks FOR EACH ROW EXECUTE FUNCTION reject_fixture_knowledge();");
    fixture.embed.mockImplementation(async (_texts, _ctx, options) => {
      await recordUsage({ purpose: 'embedding', billingSource: 'org', providerKind: 'openai', model: 'synthetic', appId: 'model', userId: 'admin', scope: options!.usage },
        { inputTokens: 4, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null });
      return null;
    });
    try {
      await expect(addKnowledgeFile('bot', 'file')).rejects.toMatchObject({ cause: { message: 'synthetic knowledge write failure' } });
      expect(await db.select().from(schema.usageEvents)).toMatchObject([{ inputTokens: 4 }]);
      expect(await db.select().from(schema.knowledgeChunks)).toHaveLength(0);
    } finally { await fixture.client!.exec('DROP TRIGGER reject_fixture_knowledge ON knowledge_chunks; DROP FUNCTION reject_fixture_knowledge();'); }
  });
});
