import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import type { Principal } from '@/lib/auth/groups';
import { encrypt, decrypt } from '@/lib/crypto';
const state = vi.hoisted(() => ({ db: null as unknown as typeof import('@/db').db }));
vi.mock('@/db', () => ({ get db() { return state.db; } }));
vi.mock('server-only', () => ({}));
import { billingAad } from '@/lib/billing/secrets';
import { listBillingAccounts, refreshBillingAccount, saveBillingAccount } from '@/lib/billing/store';
const client = new PGlite();
const admin = { isAdmin: true, user: { id: 'admin' } } as Principal;
const member = { isAdmin: false, user: { id: 'member' } } as Principal;
const now = new Date('2026-10-08T12:00:00Z');
const mockProvider = async (input: string | URL | Request) => {
  const url = new URL(String(input));
  return Response.json(url.pathname.endsWith('costs') ? { data: [{ start_time: 1790812800, end_time: 1790899200, results: [{ object: 'organization.costs.result', amount: { value: 5, currency: 'usd' }, project_id: 'proj-one' }] }], has_more: false, next_page: null } : { object: url.pathname.includes('/projects/') ? 'project.spend_limit' : 'organization.spend_limit', threshold_amount: 10000, currency: 'USD', interval: 'month', enforcement: { status: 'enforcing' } });
};
beforeAll(async () => {
  await client.waitReady; state.db = drizzle(client) as unknown as typeof state.db;
  for (const file of readdirSync('src/db/migrations').filter(f => f.endsWith('.sql') && Number(f.slice(0,4)) <= 45).sort()) {
    await client.exec(readFileSync(`src/db/migrations/${file}`, 'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;', '').replace(/\bvector\b/g,'real[]'));
  }
  await client.exec("INSERT INTO users(id,upn,name,auth_source) VALUES ('admin','admin@fixture.invalid','Admin','ldap'); INSERT INTO usage_events(id,provider_kind,model,purpose,billing_source,cost_micros,search_tool_cost_estimate_micros,input_tokens) VALUES ('prior-plan','chatgpt','same-model','delegate','chatgpt_plan',123,321,77)");
  await client.exec(readFileSync('src/db/migrations/0046_provider_billing_accounts.sql','utf8'));
  await client.exec(readFileSync('src/db/migrations/0047_subscription_cost_isolation.sql','utf8'));
}, 45000);
afterAll(async () => { await client.close(); });
describe('billing storage and authorization on real SQL', () => {
  it('upgrades historical activity without reassigning or deleting subscription tokens; DB rejects dollar leakage', async () => {
    expect((await client.query('SELECT id, input_tokens, cost_micros, search_tool_cost_estimate_micros, billing_source FROM usage_events')).rows).toEqual([{id:'prior-plan',input_tokens:77,cost_micros:null,search_tool_cost_estimate_micros:null,billing_source:'chatgpt_plan'}]);
    await expect(client.exec("UPDATE usage_events SET cost_micros=12 WHERE id='prior-plan'")).rejects.toThrow();
  });
  it('denies every store read, configuration and refresh to non-admins before touching provider/cache', async () => {
    await expect(listBillingAccounts(member)).rejects.toMatchObject({status:403});
    await expect(saveBillingAccount(member,{name:'Denied',organization:'org',enabled:true,showHealthBar:true,adminKey:'sk-admin-fixture'})).rejects.toMatchObject({status:403});
    const fetcher=vi.fn(); await expect(refreshBillingAccount(member,'anything',now,fetcher)).rejects.toMatchObject({status:403}); expect(fetcher).not.toHaveBeenCalled();
  });
  it('separates accounts, pins organization attribution, encrypts keys and never returns secrets', async () => {
    const one=await saveBillingAccount(admin,{name:'One',organization:'org-one',enabled:false,showHealthBar:false,adminKey:'sk-admin-fixture-one'});
    const two=await saveBillingAccount(admin,{name:'Two',organization:'org-two',enabled:false,showHealthBar:false,adminKey:'sk-admin-fixture-two'});
    const rows=await client.query<{id:string;organization:string;admin_key_enc:string}>('SELECT * FROM provider_billing_accounts');
    expect(rows.rows[0].admin_key_enc).not.toContain('sk-admin-fixture');
    expect(decrypt(rows.rows[0].admin_key_enc,billingAad(one.id,'org-one'))).toBe('sk-admin-fixture-one');
    expect(()=>decrypt(rows.rows[0].admin_key_enc,billingAad(two.id,'org-two'))).toThrow();
    expect(()=>decrypt(encrypt('fixture','provider_connections.secret_enc|other'),billingAad(one.id,'org-one'))).toThrow();
    expect(JSON.stringify(await listBillingAccounts(admin))).not.toMatch(/adminKey|admin_key|sk-admin|v2\./);
    await expect(saveBillingAccount(admin,{id:one.id,name:'One',organization:'org-two',enabled:false,showHealthBar:false})).rejects.toMatchObject({status:400});
    const fetcher=vi.fn();await expect(refreshBillingAccount(admin,one.id,now,fetcher)).rejects.toMatchObject({status:409});expect(fetcher).not.toHaveBeenCalled();
  });
  it('retains last successful freshness on failed refresh and fences concurrent disable/rotation', async () => {
    const one=(await listBillingAccounts(admin)).find(a=>a.organization==='org-one')!;
    await saveBillingAccount(admin,{id:one.id,name:one.name,organization:one.organization,enabled:true,showHealthBar:false});
    const first=await refreshBillingAccount(admin,one.id,now,mockProvider as typeof fetch); const snapshot=first.find(a=>a.id===one.id)!.snapshot;
    expect(snapshot?.organization).toBe('org-one');
    await expect(refreshBillingAccount(admin,one.id,now,mockProvider as typeof fetch)).rejects.toMatchObject({status:429});
    const failed=await refreshBillingAccount(admin,one.id,new Date(now.getTime()+61000),(async()=>Response.json({error:'sk-admin-fixture-secret'}, {status:403})) as typeof fetch);
    expect(failed.find(a=>a.id===one.id)?.snapshot).toEqual(snapshot);expect(failed.find(a=>a.id===one.id)?.lastError).toContain('permission denied');expect(JSON.stringify(failed)).not.toContain('sk-admin-fixture-secret');
    let changed=false;
    await refreshBillingAccount(admin,one.id,new Date(now.getTime()+122000),(async input=>{
      if(!changed){changed=true;await saveBillingAccount(admin,{id:one.id,name:one.name,organization:one.organization,enabled:false,showHealthBar:false,adminKey:'sk-admin-fixture-new'});}
      return mockProvider(input);
    }) as typeof fetch);
    const final=(await listBillingAccounts(admin)).find(a=>a.id===one.id)!;expect(final.enabled).toBe(false);expect(final.snapshot).toBeNull();
  });
});
