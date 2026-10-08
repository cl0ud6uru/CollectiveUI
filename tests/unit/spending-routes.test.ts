import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({admin:vi.fn(),principal:vi.fn(),list:vi.fn(),refresh:vi.fn(),allowance:vi.fn()}));
vi.mock('@/db',()=>({db:{}}));
vi.mock('@/lib/session',()=>({requireAdmin:mocks.admin,requirePrincipal:mocks.principal,errorResponse:(error:Error & {status?:number})=>Response.json({error:error.message},{status:error.status??500})}));
vi.mock('@/lib/billing/store',()=>({listBillingAccounts:mocks.list,refreshBillingAccount:mocks.refresh}));
vi.mock('@/lib/codex-allowance/bridge',()=>({readCodexAllowance:mocks.allowance}));
import { GET } from '@/app/api/admin/spending/route';
import { POST } from '@/app/api/admin/spending/refresh/route';
import { GET as personalGet, POST as personalPost } from '@/app/api/me/codex-allowance/route';
afterEach(()=>{vi.resetAllMocks();vi.unstubAllEnvs();});
describe('spending and quota route boundaries',()=>{
 it.each([401,403])('denies cached billing reads and refresh with %s before storage access',async status=>{
  mocks.admin.mockRejectedValue(Object.assign(new Error('Denied'),{status}));expect((await GET()).status).toBe(status);expect((await POST(new Request('https://portal.invalid/api/admin/spending/refresh',{method:'POST',body:'{}'}))).status).toBe(status);expect(mocks.list).not.toHaveBeenCalled();expect(mocks.refresh).not.toHaveBeenCalled();
 });
 it('returns only private no-store billing responses and rejects cross-origin refresh',async()=>{
  const p={user:{id:'admin'},isAdmin:true};mocks.admin.mockResolvedValue(p);mocks.list.mockResolvedValue([]);
  expect((await GET()).headers.get('cache-control')).toBe('private, no-store');vi.stubEnv('AUTH_URL','https://portal.invalid');
  expect((await POST(new Request('https://portal.invalid/api/admin/spending/refresh',{method:'POST',headers:{origin:'https://evil.invalid'},body:'{"id":"one"}'}))).status).toBe(403);expect(mocks.refresh).not.toHaveBeenCalled();
 });
 it('derives personal allowance owner from session and ignores caller-supplied identity',async()=>{
  const p={user:{id:'owner'},isAdmin:false};mocks.principal.mockResolvedValue(p);mocks.allowance.mockResolvedValue({state:'disabled',windows:[]});
  const read=await personalGet();expect(read.headers.get('cache-control')).toBe('private, no-store');expect(mocks.allowance).toHaveBeenCalledWith(p);
  vi.stubEnv('AUTH_URL','https://portal.invalid');await personalPost(new Request('https://portal.invalid/api/me/codex-allowance?owner=other',{method:'POST',headers:{origin:'https://portal.invalid'},body:'{"owner":"other"}'}));expect(mocks.allowance).toHaveBeenLastCalledWith(p,true);
 });
});
