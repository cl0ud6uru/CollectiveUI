import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText } from 'ai';
import { MockEmbeddingModelV4, MockLanguageModelV4 } from 'ai/test';
import type { PGlite } from '@electric-sql/pglite';
import type { UsageScope } from '@/lib/llm/usage';

const fixture = vi.hoisted(() => ({ client: null as PGlite | null, sql: [] as string[] }));
vi.mock('server-only', () => ({}));
vi.mock('@/db', async () => {
  const { PGlite } = await import('@electric-sql/pglite'), { drizzle } = await import('drizzle-orm/pglite'), schema = await import('@/db/schema');
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client, { schema, logger: { logQuery: (query: string) => { fixture.sql.push(query); } } }), schema };
});

import { db, schema } from '@/db';
import { utilityApp } from '@/lib/llm/apps';
import { embedTexts } from '@/lib/llm/embeddings';
import { resolveModel } from '@/lib/llm/resolve';
import { PROVIDERS } from '@/lib/llm/providers';
import { sealProviderCredential } from '@/lib/llm/provider-connections';
import { newUsageScope, restoreUsageAfterRollback, recordUsage } from '@/lib/llm/usage';

beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync('src/db/migrations').filter(name => name.endsWith('.sql')).sort())
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, 'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;', '').replace(/\bvector\b/g, 'real[]'));
}, 45000);
beforeEach(async () => {
  vi.restoreAllMocks();
  await fixture.client!.exec('TRUNCATE users, ai_apps, provider_connections, settings CASCADE');
  await db.insert(schema.users).values({ id: 'owner', name: 'Fixture owner', upn: 'owner@test.invalid', authSource: 'local', identityRealm: 'local' });
  await db.insert(schema.providerConnections).values({ id: 'saved', name: 'Synthetic saved connection', credentialEnc: sealProviderCredential('saved', 'fixture-key'), createdBy: 'owner' });
  await db.insert(schema.aiApps).values({ id: 'utility', name: 'Synthetic company model', provider: 'openai', providerConnectionId: 'saved', model: 'fixture-chat', embeddingModel: 'fixture-embed', isPublic: true });
  await db.insert(schema.settings).values({ key: 'tools', value: { utilityAppId: 'utility', embeddingAppId: 'utility' } });
  const chat = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: 'Synthetic result' }], finishReason: { unified: 'stop', raw: 'stop' }, warnings: [],
    usage: { inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 3, text: 3, reasoning: 0 } } }) });
  const embedding = new MockEmbeddingModelV4({ doEmbed: async () => ({ embeddings: [[0.25, 0.5]], usage: { tokens: 4 }, warnings: [] }) });
  vi.spyOn(PROVIDERS.openai, 'create').mockImplementation(async context => {
    expect(context.secret).toBeDefined(); expect(context.baseUrl).toBeNull();
    return { chat: () => chat, embedding: () => embedding };
  });
  // No fixture can accidentally dispatch a real provider request.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected live inference'); }));
  fixture.sql.length = 0;
});
afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await fixture.client!.close(); });

describe('transaction-scoped company utility connections and accounting', () => {
  it('uses the admitted transaction for settings, saved credentials, embedding resolution and ledger writes', async () => {
    await db.transaction(async q => {
      const globalSelect = vi.spyOn(db, 'select').mockImplementation(() => { throw new Error('Global select while admission is held'); });
      const globalInsert = vi.spyOn(db, 'insert').mockImplementation(() => { throw new Error('Global insert while admission is held'); });
      try {
        const usage = newUsageScope({}, q), app = (await utilityApp(undefined, q))!;
        const { model } = await resolveModel(app, { purpose: 'memory', userId: 'owner', q, usage });
        expect((await generateText({ model, prompt: 'Synthetic prompt', maxRetries: 0, abortSignal: AbortSignal.timeout(60000) })).text).toBe('Synthetic result');
        await Promise.all(usage.pending);
        expect(await embedTexts(['Synthetic fact'], { userId: 'owner' }, { q, usage, maxRetries: 0, abortSignal: AbortSignal.timeout(60000) })).toEqual([[0.25, 0.5]]);
        expect(await q.select().from(schema.usageEvents)).toHaveLength(2);
      } finally { globalSelect.mockRestore(); globalInsert.mockRestore(); }
    });
    expect(await db.select().from(schema.usageEvents)).toMatchObject([{ purpose: 'memory', inputTokens: 7 }, { purpose: 'embedding', inputTokens: 4 }]);
    expect(fixture.sql.filter(query => /from "provider_connections"/.test(query))).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('replays reported usage after a rolled-back utility job with stable IDs and no duplicates', async () => {
    let scope: UsageScope | undefined;
    await expect(db.transaction(async q => {
      const usage = scope = newUsageScope({}, q), app = (await utilityApp(undefined, q))!;
      const { model } = await resolveModel(app, { purpose: 'draft', userId: 'owner', q, usage });
      await generateText({ model, prompt: 'Synthetic prompt', maxRetries: 0 });
      await Promise.all(usage.pending);
      await embedTexts(['Synthetic fact'], { userId: 'owner' }, { q, usage, maxRetries: 0 });
      throw new Error('Synthetic failed save');
    })).rejects.toThrow('Synthetic failed save');
    expect(await db.select().from(schema.usageEvents)).toHaveLength(0);
    await restoreUsageAfterRollback(scope);
    const first = await db.select().from(schema.usageEvents);
    expect(first).toHaveLength(2);
    await restoreUsageAfterRollback(scope);
    expect(await db.select().from(schema.usageEvents)).toEqual(first);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rolls a failed accounting insert back to its savepoint without aborting ordinary work', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await db.transaction(async q => {
      const usage = newUsageScope({}, q);
      await recordUsage({ purpose: 'memory', billingSource: 'org', providerKind: 'openai', model: null as never, appId: 'utility', userId: 'owner', scope: usage },
        { inputTokens: 7, outputTokens: 3, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null });
      expect(await q.select().from(schema.users)).toHaveLength(1);
    });
    expect(await db.select().from(schema.usageEvents)).toHaveLength(0);
    expect(log).toHaveBeenCalledOnce();
  });
});
