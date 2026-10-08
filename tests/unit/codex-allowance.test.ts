import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only',()=>({}));
vi.mock('@/db',()=>({db:{}}));
import { normalizeQuota } from '@/lib/codex-allowance/normalize';
import { quotaStale } from '@/lib/codex-allowance/contracts';
import { readCodexAllowance, registerCodexAllowanceRuntime } from '@/lib/codex-allowance/bridge';
import type { Principal } from '@/lib/auth/groups';
const owner={isAdmin:false,user:{id:'owner'}} as Principal;
const admin={isAdmin:true,user:{id:'admin'}} as Principal;
const now=new Date('2026-10-08T12:00:00Z');
const payload={rateLimits:{limitId:'codex',primary:{usedPercent:25,windowDurationMins:15,resetsAt:1791461700},secondary:null}};
const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const close of cleanup.splice(0))close();vi.unstubAllEnvs();vi.restoreAllMocks();});
function runtime(id='owned-runtime'){
 let notify:(method:string,params:unknown)=>void=()=>{};
 const request=vi.fn(async(method:string):Promise<unknown>=>method==='account/read'?{account:{type:'chatgpt'}}:payload);
 const authorize=vi.fn(async()=>true);
 const dispose=registerCodexAllowanceRuntime({ownerId:'owner',connectionId:id,label:'Owned Codex',authorize,request,subscribe:listener=>{notify=listener;return()=>{};}});cleanup.push(dispose);
 return{request,authorize,notify:(method:string,params:unknown)=>notify(method,params)};
}
describe('supported allowance contract',()=>{
 it('uses only returned windows, supports multi-bucket replies and does not infer fixed durations',()=>{
  const windows=normalizeQuota({rateLimits:payload.rateLimits,rateLimitsByLimitId:{custom:{limitId:'custom',primary:{usedPercent:12,windowDurationMins:37,resetsAt:null}},codex:{limitId:'codex',secondary:{usedPercent:99}}}},[],'account/rateLimits/read',now);
  expect(windows).toHaveLength(2);expect(windows[0].windowDurationMins.value).toBe(37);expect(windows[1].windowDurationMins.value).toBeNull();expect(windows[0].resetsAt.value).toBeNull();
 });
 it('merges sparse notifications per field without refreshing omitted facts, and honors explicit window removal',()=>{
  const windows=normalizeQuota(payload,[],'account/rateLimits/read',now);const later=new Date(now.getTime()+60000);
  const update=normalizeQuota({rateLimits:{limitId:'codex',primary:{usedPercent:31}}},windows,'account/rateLimits/updated',later);
  expect(update[0].usedPercent).toMatchObject({value:31,observedAt:later.toISOString(),source:'account/rateLimits/updated'});
  expect(update[0].windowDurationMins).toEqual(windows[0].windowDurationMins);expect(update[0].resetsAt).toEqual(windows[0].resetsAt);
  expect(normalizeQuota({rateLimits:{limitId:'codex',primary:null}},update,'account/rateLimits/updated',later)).toEqual([]);
 });
 it('replaces full snapshots, leaves no returned windows empty, and marks observations stale after resets',()=>{
  const windows=normalizeQuota(payload,[],'account/rateLimits/read',now);
  expect(normalizeQuota({rateLimits:null},windows,'account/rateLimits/read',now)).toEqual([]);
  expect(quotaStale(windows[0],now.getTime()+6*60000)).toBe(true);
  const reset={...windows[0],resetsAt:{...windows[0].resetsAt,value:now.getTime()/1000}};expect(quotaStale(reset,now.getTime())).toBe(true);
 });
 it('rejects malformed values and conflicting metered ids; never parses raw response headers as quota',()=>{
  for(const raw of [{'x-codex-primary-used-percent':25},{rateLimits:{primary:{usedPercent:-1}}},{rateLimitsByLimitId:{codex:{limitId:'different',primary:{usedPercent:10}}}},{rateLimits:{primary:{windowDurationMins:0}}}])expect(()=>normalizeQuota(raw,[],'account/rateLimits/read',now)).toThrow();
 });
});
describe('owner-bound disabled bridge',()=>{
 it('stays disabled without transport registration or any live credential path',async()=>{
  vi.stubEnv('CODEX_ALLOWANCE_BRIDGE_ENABLED','');expect((await readCodexAllowance(owner,true)).state).toBe('disabled');
  expect(()=>runtime()).toThrow('disabled');
 });
 it('cannot return another owner cache to an admin; authorizes cached reads too',async()=>{
  vi.stubEnv('CODEX_ALLOWANCE_BRIDGE_ENABLED','1');const r=runtime();
  expect((await readCodexAllowance(owner,true,now)).windows).toHaveLength(1);
  expect((await readCodexAllowance(admin)).state).toBe('unavailable');expect((await readCodexAllowance(admin)).windows).toEqual([]);
  r.authorize.mockResolvedValue(false);expect((await readCodexAllowance(owner)).windows).toEqual([]);
 });
 it('requires a ChatGPT authenticated account, not API or billing key auth',async()=>{
  vi.stubEnv('CODEX_ALLOWANCE_BRIDGE_ENABLED','1');const r=runtime();r.request.mockResolvedValue({account:{type:'apiKey'}});
  expect((await readCodexAllowance(owner,true,now)).state).toBe('needs_auth');expect(r.request).toHaveBeenCalledTimes(1);
 });
 it('preserves freshness on failure, clears account changes and ignores old connection notifications',async()=>{
  vi.stubEnv('CODEX_ALLOWANCE_BRIDGE_ENABLED','1');const r=runtime();const first=await readCodexAllowance(owner,true,now);
  r.request.mockRejectedValue(new Error('secret-transport-token'));const failed=await readCodexAllowance(owner,true,new Date(now.getTime()+31000));expect(failed.state).toBe('error');expect(failed.windows).toEqual(first.windows);expect(JSON.stringify(failed)).not.toContain('secret-transport-token');
  const current=runtime('replacement');r.notify('account/rateLimits/updated',payload);expect((await readCodexAllowance(owner)).windows).toEqual([]);
  await readCodexAllowance(owner,true,new Date(now.getTime()+62000));current.notify('account/updated',{authMode:null});expect((await readCodexAllowance(owner)).windows).toEqual([]);
 });
 it('does not overwrite a newer notification with a late full read',async()=>{
  vi.stubEnv('CODEX_ALLOWANCE_BRIDGE_ENABLED','1');const r=runtime();await readCodexAllowance(owner,true,now);
  r.request.mockImplementation(async method=>{if(method==='account/read')return{account:{type:'chatgpt'}};r.notify('account/rateLimits/updated',{rateLimits:{limitId:'codex',primary:{usedPercent:42}}});return payload;});
  const view=await readCodexAllowance(owner,true,new Date(now.getTime()+31000));expect(view.windows[0].usedPercent.value).toBe(42);expect(view.windows[0].usedPercent.source).toBe('account/rateLimits/updated');
 });
 it('buffers initial-read notifications in order and retains omitted full-read fields',async()=>{
  vi.stubEnv('CODEX_ALLOWANCE_BRIDGE_ENABLED','1');const r=runtime();
  r.request.mockImplementation(async method=>{if(method==='account/read')return{account:{type:'chatgpt'}};
   r.notify('account/rateLimits/updated',{rateLimits:{limitId:'codex',primary:{usedPercent:42}}});
   r.notify('account/rateLimits/updated',{rateLimits:{limitId:'codex',primary:{usedPercent:43}}});return payload;});
  const view=await readCodexAllowance(owner,true,now);expect(view.windows[0].usedPercent).toMatchObject({value:43,source:'account/rateLimits/updated'});
  expect(view.windows[0].windowDurationMins).toEqual({value:15,source:'account/rateLimits/read',observedAt:now.toISOString()});
  expect(view.windows[0].resetsAt.value).toBe(payload.rateLimits.primary.resetsAt);expect(view.lastReadAt).toBe(now.toISOString());
 });
 it('keeps first-read notifications private when the account gate or full read fails',async()=>{
  vi.stubEnv('CODEX_ALLOWANCE_BRIDGE_ENABLED','1');const r=runtime();
  r.request.mockImplementation(async()=>{r.notify('account/rateLimits/updated',payload);return{account:{type:'apiKey'}};});
  expect((await readCodexAllowance(owner,true,now)).windows).toEqual([]);expect((await readCodexAllowance(owner)).windows).toEqual([]);
  r.request.mockImplementation(async method=>{if(method==='account/read')return{account:{type:'chatgpt'}};r.notify('account/rateLimits/updated',payload);throw new Error('failed full read');});
  expect((await readCodexAllowance(owner,true,new Date(now.getTime()+31000))).windows).toEqual([]);expect((await readCodexAllowance(owner)).windows).toEqual([]);
 });
 it('does not repopulate old account quota when final authorization emits an account change',async()=>{
  vi.stubEnv('CODEX_ALLOWANCE_BRIDGE_ENABLED','1');const r=runtime();
  r.authorize.mockResolvedValueOnce(true).mockImplementationOnce(async()=>{r.notify('account/updated',{authMode:null});return true;});
  expect((await readCodexAllowance(owner,true,now)).state).toBe('unavailable');
  const cached=await readCodexAllowance(owner);expect(cached.state).toBe('needs_auth');expect(cached.windows).toEqual([]);expect(cached.lastReadAt).toBeNull();
 });
 it('does not mutate a retired cache when final authorization replaces the runtime',async()=>{
  vi.stubEnv('CODEX_ALLOWANCE_BRIDGE_ENABLED','1');const r=runtime();
  r.authorize.mockResolvedValueOnce(true).mockImplementationOnce(async()=>{runtime('new-connection');return true;});
  expect((await readCodexAllowance(owner,true,now)).windows).toEqual([]);expect((await readCodexAllowance(owner)).windows).toEqual([]);
 });
 it('fences account changes and connection retirement while a full read is in flight',async()=>{
  vi.stubEnv('CODEX_ALLOWANCE_BRIDGE_ENABLED','1');const r=runtime();r.request.mockImplementation(async method=>{if(method==='account/read')return{account:{type:'chatgpt'}};r.notify('account/updated',{authMode:null});return payload;});
  expect((await readCodexAllowance(owner,true,now)).windows).toEqual([]);
 });
});
