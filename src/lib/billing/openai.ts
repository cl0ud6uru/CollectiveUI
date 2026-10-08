import { z } from 'zod';
import type { DailySpend, Money, ReadStatus, SpendingSnapshot, SpendLimit } from './contracts';

const selector = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const Amount = z.object({ value: z.number().finite(), currency: z.string().regex(/^[a-zA-Z]{3}$/) });
const Page = z.object({ data: z.array(z.object({ start_time: z.number().int(), end_time: z.number().int(), results: z.array(z.object({
  object: z.literal('organization.costs.result'), amount: Amount.nullish(), project_id: z.string().nullable().optional(),
})) })), has_more: z.boolean(), next_page: z.string().nullable() });
const Limit = z.object({ object: z.enum(['organization.spend_limit', 'project.spend_limit']), threshold_amount: z.number().finite().nonnegative(),
  currency: z.string().regex(/^[a-zA-Z]{3}$/), interval: z.literal('month'), enforcement: z.object({ status: z.string().min(1).max(80) }) });
const emptyLimit = (status: ReadStatus): SpendLimit => ({ status, amount: null, currency: null, enforcement: null });
class ReadError extends Error { constructor(public status: ReadStatus) { super(status); } }
export function utcMonth(now: Date) {
  return { month: now.toISOString().slice(0, 7), start: Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000), through: Math.floor(now.getTime() / 1000) };
}
/** Fixed public provider origin, GET only, no redirects, bodies/errors/headers never logged or returned. */
export async function readOpenAISpending(organization: string, key: string, projectIds: string[], now = new Date(), fetcher: typeof fetch = fetch): Promise<SpendingSnapshot> {
  selector.parse(organization); projectIds.forEach(p => selector.parse(p));
  const period = utcMonth(now);
  const get = async (path: string, query = new URLSearchParams()) => {
    try {
      const response = await fetcher(`https://api.openai.com/v1/organization/${path}?${query}`, {
        method: 'GET', headers: { Authorization: `Bearer ${key}`, 'OpenAI-Organization': organization },
        cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new ReadError(response.status === 401 || response.status === 403 ? 'permission_denied' : 'unavailable');
      // Bound parsing of costs pages. Do not consume arbitrarily large provider errors or responses.
      const reader = response.body?.getReader(); if (!reader) throw new ReadError('unknown');
      const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2_000_000) throw new ReadError('unknown'); chunks.push(value); } }
      finally { await reader.cancel().catch(() => {}); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const text = new TextDecoder().decode(bytes);
      if (key && text.includes(key)) throw new ReadError('unknown');
      return JSON.parse(text);
    } catch (error) { throw error instanceof ReadError ? error : new ReadError('unavailable'); }
  };
  const limit = async (path: string): Promise<SpendLimit> => {
    try {
      const raw = await get(path);
      // Only an explicit null is treated as unset; a 404 is not evidence of an unset limit.
      if (raw === null) return emptyLimit('unset');
      const parsed = Limit.safeParse(raw); if (!parsed.success) return emptyLimit('unknown');
      const expected = path === 'spend_limit' ? 'organization.spend_limit' : 'project.spend_limit';
      if (parsed.data.object !== expected) return emptyLimit('unknown');
      return { status: 'known', amount: parsed.data.threshold_amount / 100, currency: parsed.data.currency.toUpperCase(), enforcement: parsed.data.enforcement.status };
    } catch (error) { return emptyLimit(error instanceof ReadError ? error.status : 'unknown'); }
  };
  const costs = async (grouped: boolean) => {
    const daily: DailySpend[] = []; const sums = new Map<string, number>(); const projects = new Map<string | null, Map<string, number>>();
    const cursors = new Set<string>(); const buckets = new Set<number>();
    const add = (map: Map<string, number>, amount: Money) => map.set(amount.currency, (map.get(amount.currency) ?? 0) + amount.value);
    const amounts = (map: Map<string, number>) => [...map].map(([currency, value]) => ({ currency, value }));
    const query = new URLSearchParams({ start_time: String(period.start), end_time: String(period.through), bucket_width: '1d', limit: '31' });
    if (grouped) query.set('group_by[]', 'project_id');
    for (let page = 0; page < 20; page++) {
      const parsed = Page.safeParse(await get('costs', query)); if (!parsed.success) throw new ReadError('unknown');
      for (const bucket of parsed.data.data) {
        if (bucket.start_time < period.start || bucket.start_time >= period.through || bucket.end_time <= bucket.start_time || buckets.has(bucket.start_time)) throw new ReadError('unknown');
        buckets.add(bucket.start_time); const day = new Map<string, number>();
        for (const result of bucket.results) {
          if (!result.amount || (grouped && result.project_id === undefined)) throw new ReadError('unknown');
          const amount = { value: result.amount.value, currency: result.amount.currency.toUpperCase() };
          add(sums, amount); add(day, amount);
          const id = result.project_id ?? null; const project = projects.get(id) ?? new Map<string, number>(); add(project, amount); projects.set(id, project);
        }
        daily.push({ start: bucket.start_time, end: Math.min(bucket.end_time, period.through), amounts: amounts(day) });
      }
      if (!parsed.data.has_more) return { amounts: amounts(sums), daily: daily.sort((a, b) => a.start - b.start), projects: [...projects].map(([id, map]) => ({ id, amounts: amounts(map) })) };
      const next = parsed.data.next_page; if (!next || cursors.has(next)) throw new ReadError('unknown'); cursors.add(next); query.set('page', next);
    }
    throw new ReadError('unknown');
  };
  const [total, breakdown, organizationLimit, projectLimits] = await Promise.all([
    costs(false).then(data => ({ status: 'known' as ReadStatus, ...data }), error => ({ status: error instanceof ReadError ? error.status : 'unknown' as ReadStatus, amounts: [], daily: [] })),
    costs(true).then(data => ({ status: 'known' as ReadStatus, ...data }), error => ({ status: error instanceof ReadError ? error.status : 'unknown' as ReadStatus, projects: [] })),
    limit('spend_limit'), Promise.all(projectIds.map(async id => [id, await limit(`projects/${encodeURIComponent(id)}/spend_limit`)] as const)),
  ]);
  return { ...period, organization, refreshedAt: now.toISOString(), costsStatus: total.status, amounts: total.amounts, daily: total.daily,
    breakdownStatus: breakdown.status, projects: breakdown.projects, organizationLimit, projectLimits: Object.fromEntries(projectLimits) };
}
