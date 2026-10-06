import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { AiApp } from '@/db/schema';
import type { PortalUIMessage } from '@/lib/chat/store';
const fixture = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], where: vi.fn(), get: vi.fn() }));
vi.mock('@/db', () => ({ db: { select: () => ({ from: () => ({ where: (condition: unknown) => { fixture.where(condition); return fixture.rows; } }) }) } }));
vi.mock('@/lib/files/storage', () => ({ storage: () => ({ get: fixture.get }) }));
import { resolveAttachmentsForModel } from '@/lib/agent/prepare';
const app = { provider: 'hermes', providerConfig: { local: {} }, supportsVision: false } as unknown as AiApp;
const message = (id: string, files: string[]): PortalUIMessage => ({ id, role: 'user', parts: files.map(id => ({ type: 'file', url: `/api/files/${id}`, filename: 'client-name.pdf', mediaType: 'application/pdf' })) });
const attachment = (id: string, size = 4) => ({ id, userId: 'owner', filename: `${id}.pdf`, storageKey: `owned/${id}`, mediaType: 'application/pdf', size, extractedText: 'Do not downgrade native PDF to extracted text.' });
beforeEach(() => { fixture.rows = []; vi.clearAllMocks(); fixture.get.mockResolvedValue(Buffer.from('PDF bytes')); });
describe('native Hermes owned attachment resolution', () => {
  it('reads only resolved owned files from the newest user turn and never fetches arbitrary URLs', async () => {
    fixture.rows = [attachment('Old'), attachment('New')];
    const history = [message('old', ['Old']), message('new', ['New', 'Foreign'])];
    history[1].parts.push({ type: 'file', url: 'https://example.test/secret.pdf', mediaType: 'application/pdf' });
    const result = await resolveAttachmentsForModel(history, app, 'owner');
    expect(fixture.get.mock.calls).toEqual([['owned/New']]);
    expect(result[0].parts).toEqual([{ type: 'text', text: '[Earlier attachment: Old.pdf]' }]);
    expect(result[1].parts[0]).toMatchObject({ type: 'file', filename: 'New.pdf', url: `data:application/pdf;base64,${Buffer.from('PDF bytes').toString('base64')}` });
    expect(result[1].parts.slice(1).every(p => p.type === 'text')).toBe(true);
    const query = new PgDialect().sqlToQuery(fixture.where.mock.calls[0][0]);
    expect(query.sql).toContain('"attachments"."user_id"'); expect(query.params).toContain('owner');
  });
  it('rejects per-file, aggregate and count overflow before reading storage', async () => {
    for (const sizes of [[8 * 1024 * 1024 + 1], [8 * 1024 * 1024, 8 * 1024 * 1024, 1], Array(9).fill(1)]) {
      fixture.rows = sizes.map((size, i) => attachment(`File${i}`, size));
      await expect(resolveAttachmentsForModel([message('new', sizes.map((_, i) => `File${i}`))], app, 'owner')).rejects.toMatchObject({ status: 413 });
    }
    expect(fixture.get).not.toHaveBeenCalled();
  });
  it('preserves extracted text behavior for other providers', async () => {
    fixture.rows = [attachment('Doc')];
    const result = await resolveAttachmentsForModel([message('new', ['Doc'])], { ...app, provider: 'openai', providerConfig: {} }, 'owner');
    expect(result[0].parts[0]).toMatchObject({ type: 'text', text: expect.stringContaining('extracted text') });
    expect(fixture.get).not.toHaveBeenCalled();
  });
});
