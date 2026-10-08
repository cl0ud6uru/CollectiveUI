import { describe, expect, it, vi } from 'vitest';
import { readOpenAISpending, utcMonth } from '@/lib/billing/openai';
import { applicableRemaining, remaining, snapshotStale, type SpendingSnapshot } from '@/lib/billing/contracts';
const now = new Date('2026-10-08T12:00:00Z');
const bucket = { start_time: Date.parse('2026-10-01') / 1000, end_time: Date.parse('2026-10-02') / 1000, results: [{ object: 'organization.costs.result', amount: { value: 95, currency: 'usd' }, project_id: 'proj-one' }] };
const page = { data: [bucket], has_more: false, next_page: null };
const limit = { object: 'organization.spend_limit', threshold_amount: 10000, interval: 'month', currency: 'USD', enforcement: { status: 'enforcing' } };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const mockProvider = () => vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  expect(String(input).startsWith('https://api.openai.com/v1/organization/')).toBe(true);
  expect(init?.method).toBe('GET'); expect(init?.redirect).toBe('error'); expect(init?.cache).toBe('no-store');
  const url = new URL(String(input));
  return response(url.pathname.endsWith('costs') ? page : { ...limit, object: url.pathname.includes('/projects/') ? 'project.spend_limit' : 'organization.spend_limit' });
});
describe('provider-reported spending', () => {
  it('reads both total and grouped daily costs and converts cents with exact org attribution', async () => {
    const fetcher = mockProvider(); const snapshot = await readOpenAISpending('org-one', 'fixture-admin-key', ['proj-one'], now, fetcher as typeof fetch);
    expect(snapshot.amounts).toEqual([{ currency: 'USD', value: 95 }]); expect(snapshot.organizationLimit.amount).toBe(100);
    expect(snapshot.projectLimits['proj-one'].amount).toBe(100);
    expect(snapshot.projects).toEqual([{ id: 'proj-one', amounts: [{ currency: 'USD', value: 95 }] }]);
    expect(JSON.stringify(snapshot)).not.toContain('fixture-admin-key');
    for (const [, init] of fetcher.mock.calls) expect((init?.headers as Record<string,string>)['OpenAI-Organization']).toBe('org-one');
    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get('end_time')).toBe(String(now.getTime() / 1000));
  });
  it('keeps organization costs when project permission is absent; never interprets 404 as unset', async () => {
    const snapshot = await readOpenAISpending('org', 'fixture', ['proj'], now, (async input => {
      const url = new URL(String(input));
      if (url.searchParams.has('group_by[]')) return response({error:{message:'fixture-secret'}}, 403);
      if (url.pathname.includes('/projects/')) return response({},404);
      return response(url.pathname.endsWith('costs') ? page : limit);
    }) as typeof fetch);
    expect(snapshot.costsStatus).toBe('known'); expect(snapshot.breakdownStatus).toBe('permission_denied');
    expect(snapshot.projectLimits.proj.status).toBe('unavailable'); expect(JSON.stringify(snapshot)).not.toContain('fixture-secret');
  });
  it('rejects unknown amounts/currency and looping or overlapping pagination instead of understating totals', async () => {
    for (const invalid of [ { ...page, has_more: true, next_page: 'loop' }, { ...page, data: [{ ...bucket, results: [{object:'organization.costs.result'}] }] }, { ...page, data: [{...bucket, results:[{...bucket.results[0],amount:{value:2,currency:'?'}}]}] } ]) {
      const value = await readOpenAISpending('org', 'fixture', [], now, (async input => response(String(input).includes('/costs?') ? invalid : limit)) as typeof fetch);
      expect(value.costsStatus).toBe('unknown'); expect(value.amounts).toEqual([]);
    }
  });
  it('rejects provider payloads that echo a stored billing secret', async () => {
    const snapshot = await readOpenAISpending('org','sk-admin-fixture',[],now,(async input => response(String(input).includes('/costs?') ? {...page,data:[{...bucket,results:[{...bucket.results[0],project_id:'sk-admin-fixture'}]}]} : {...limit,enforcement:{status:'sk-admin-fixture'}})) as typeof fetch);
    expect(snapshot.costsStatus).toBe('unknown');expect(snapshot.organizationLimit.status).toBe('unknown');expect(JSON.stringify(snapshot)).not.toContain('sk-admin-fixture');
  });
  it('bounds pagination, parses all returned pages, retains sparse daily buckets', async () => {
    const snapshot = await readOpenAISpending('org', 'fixture', [], now, (async input => {
      const url = new URL(String(input)); if (!url.pathname.endsWith('costs')) return response(limit);
      return response(url.searchParams.has('page') ? {data:[{...bucket,start_time:bucket.start_time+2*86400,end_time:bucket.end_time+2*86400}],has_more:false,next_page:null} : {...page,has_more:true,next_page:'two'});
    }) as typeof fetch);
    expect(snapshot.amounts[0].value).toBe(190); expect(snapshot.daily).toHaveLength(2);
  });
  it('uses UTC month boundaries including leap years and year rollover', () => {
    expect(utcMonth(new Date('2027-01-01T00:00:00Z'))).toEqual({month:'2027-01',start:1798761600,through:1798761600});
    expect(new Date(utcMonth(new Date('2028-02-29T23:59:59Z')).start*1000).toISOString()).toBe('2028-02-01T00:00:00.000Z');
  });
  it('keeps unknown/unset limits and unsupported intervals unknown', async () => {
    for (const raw of [null, {...limit,interval:'week'}, {...limit,enforcement:{status:'future'}}]) {
      const snapshot = await readOpenAISpending('org','fixture',[],now,(async input=>response(String(input).includes('/costs?')?page:raw)) as typeof fetch);
      expect(snapshot.organizationLimit.status).toBe(raw===null?'unset':raw.interval==='week'?'unknown':'known');
    }
  });
});
describe('applicable allowance', () => {
  const snapshot = (): SpendingSnapshot => ({organization:'org',month:new Date().toISOString().slice(0,7),start:1,through:2,refreshedAt:new Date().toISOString(),costsStatus:'known',amounts:[{currency:'USD',value:95}],daily:[],breakdownStatus:'known',projects:[{id:'project',amounts:[{currency:'USD',value:2}]}],organizationLimit:{status:'known',amount:100,currency:'USD',enforcement:'enforcing'},projectLimits:{project:{status:'known',amount:50,currency:'USD',enforcement:'inactive'}}});
  it('caps project remaining by parent org; does not equate remaining with enforcement', () => {
    const value=snapshot(); expect(applicableRemaining(value,'project')).toEqual({currency:'USD',value:5});
    value.amounts[0].value=110; expect(applicableRemaining(value,'project')?.value).toBe(0);
  });
  it('does not invent allowance for missing parent, stale data, unknown project or mixed currency', () => {
    const value=snapshot(); value.organizationLimit.status='unset'; expect(applicableRemaining(value,'project')).toBeNull();
    value.organizationLimit.status='known'; value.refreshedAt='2020-01-01'; expect(snapshotStale(value)).toBe(true); expect(applicableRemaining(value,'project')).toBeNull();
    expect(remaining(value.organizationLimit,[{currency:'EUR',value:1}],true)).toBeNull();
  });
});
