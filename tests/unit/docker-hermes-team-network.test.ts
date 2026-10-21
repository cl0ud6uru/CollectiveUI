import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const f=vi.hoisted(()=>({client:null as PGlite|null,principal:null as unknown,control:vi.fn(),fail:false}));
vi.mock('@/lib/session',()=>({requireAdmin:async()=>f.principal}));
vi.mock('@/lib/docker-hermes/client',()=>({dockerControl:f.control}));
vi.mock('@/db',async()=>{
  const {PGlite}=await import('@electric-sql/pglite'),{drizzle}=await import('drizzle-orm/pglite'),schema=await import('@/db/schema');
  f.client=new PGlite();return {db:drizzle(f.client,{schema}),schema};
});
import { db,schema } from '@/db';
import { loadPrincipal } from '@/lib/auth/groups';
import { POST } from '@/app/api/admin/hermes/network/route';
import { requestDockerNetwork } from '@/lib/docker-hermes/network';
const owner='team-admin:team',origin='https://portal.fixture.invalid';
const input=()=>({mode:'internet',revision:0,requestId:randomUUID(),confirmRestart:true});
const request=(target=owner,value=input(),requestOrigin=origin)=>new Request(`${origin}/api/admin/hermes/network`,{
  method:'POST',headers:{Origin:requestOrigin,'Content-Type':'application/json'},body:JSON.stringify({owner:target,request:value}),
});
beforeAll(async()=>{
  await f.client!.waitReady;
  for(const file of readdirSync('src/db/migrations').filter(file=>file.endsWith('.sql')).sort())
    await f.client!.exec(readFileSync(`src/db/migrations/${file}`,'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;','').replace(/\bvector\b/g,'real[]'));
},45000);
beforeEach(async()=>{
  vi.stubEnv('AUTH_URL',origin);vi.stubEnv('HERMES_TEAM_BOTS_ENABLED','1');f.fail=false;
  f.control.mockReset();f.control.mockImplementation(async(_actor,action,data)=>{
    if(action==='/control/network'){
      if(data && f.fail)throw new Error('Synthetic uncertain network dispatch');
      return {mode:'none',revision:0,actual:'absent',changing:!!data};
    }
    return action==='/team/authorize'?{grantId:randomUUID(),expiresAt:Date.now()+60000}:{renewed:true};
  });
  await f.client!.exec('TRUNCATE users,ai_apps,settings CASCADE');
  await db.insert(schema.users).values([
    {id:'maintainer',name:'Maintainer',upn:'maintainer@fixture.invalid',authSource:'local',identityRealm:'local',isAdmin:true},
    {id:'other-admin',name:'Other admin',upn:'other@fixture.invalid',authSource:'local',identityRealm:'local',isAdmin:true},
    {id:'member',name:'Member',upn:'member@fixture.invalid',authSource:'local',identityRealm:'local'},
  ]);
  f.principal=(await loadPrincipal('maintainer'))!;
  await db.insert(schema.bots).values({id:'team',ownerId:'maintainer',name:'Team',visibility:'org',hermesTeam:true});
  await db.insert(schema.hermesTeamDefinitions).values({botId:'team',enabled:true,modelPolicy:{mode:'personal_required'},updatedBy:'maintainer'});
  await db.insert(schema.hermesTeamMaintainers).values({botId:'team',userId:'maintainer'});
});
afterAll(async()=>{await f.client?.close();vi.unstubAllEnvs();});
it('changes reserved Team admin network policy through the Admin route without a personal enrollment',async()=>{
  const value=input(),response=await POST(request(owner,value));expect(response.status).toBe(202);
  expect(f.control).toHaveBeenNthCalledWith(1,owner,'/control/network',undefined,5000);
  expect(f.control).toHaveBeenNthCalledWith(2,'maintainer','/team/authorize',{teamBotId:'team',mode:'admin',modelPolicy:'personal_required'},3000);
  expect(f.control).toHaveBeenNthCalledWith(3,owner,'/control/network',{actor:'maintainer',request:value},5000);
  expect(f.control.mock.calls.some(([,action])=>action==='/control/lease')).toBe(false);
  const rows=await db.select().from(schema.auditLog);expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({actorId:'maintainer',target:owner,details:{requestId:value.requestId,status:'accepted'}});
});
it('denies a nonmaintainer Admin, an ordinary member, a stale session and a disabled Team before broker I/O',async()=>{
  for(const id of ['other-admin','member']){f.principal=(await loadPrincipal(id))!;expect((await POST(request())).status).toBe(403);}
  f.principal=(await loadPrincipal('maintainer'))!;
  await db.update(schema.users).set({sessionVersion:1}).where(eq(schema.users.id,'maintainer'));
  expect((await POST(request())).status).toBe(403);
  f.principal=(await loadPrincipal('maintainer'))!;
  await db.update(schema.hermesTeamDefinitions).set({enabled:false}).where(eq(schema.hermesTeamDefinitions.botId,'team'));
  expect((await POST(request())).status).toBe(403);
  await db.update(schema.hermesTeamDefinitions).set({enabled:true}).where(eq(schema.hermesTeamDefinitions.botId,'team'));
  await db.update(schema.users).set({disabled:true}).where(eq(schema.users.id,'maintainer'));
  expect((await POST(request())).status).toBe(403);
  expect(f.control).not.toHaveBeenCalled();expect(await db.select().from(schema.auditLog)).toEqual([]);
});
it('rechecks maintainer authority after the audit intent commits and before issuing a grant',async()=>{
  const original=db.transaction.bind(db);
  const transaction=vi.spyOn(db,'transaction').mockImplementationOnce(async(...args:Parameters<typeof db.transaction>)=>{
    const result=await original(...args);
    await db.delete(schema.hermesTeamMaintainers).where(eq(schema.hermesTeamMaintainers.userId,'maintainer'));
    return result;
  });
  try {
    expect((await POST(request())).status).toBe(403);
    expect(f.control.mock.calls.map(([,action])=>action)).toEqual(['/control/network']);
    expect((await db.select().from(schema.auditLog))[0].details).toMatchObject({status:'requested'});
  }finally{transaction.mockRestore();}
});
it('retains one audit request after uncertain Team dispatch and retries the same immutable request',async()=>{
  const value=input();f.fail=true;expect((await POST(request(owner,value))).status).toBe(503);
  expect((await db.select().from(schema.auditLog))[0].details).toMatchObject({status:'requested',requestId:value.requestId});
  f.fail=false;expect((await POST(request(owner,value))).status).toBe(202);
  expect(await db.select().from(schema.auditLog)).toHaveLength(1);
  expect((await POST(request(owner,{...value,mode:'proxy'}))).status).toBe(409);
});
it('keeps personal enrollment checks and rejects foreign origins and malformed reserved IDs',async()=>{
  expect((await POST(request('member'))).status).toBe(409);
  expect(f.control).not.toHaveBeenCalled();
  expect((await POST(request(owner,input(),'https://foreign.fixture.invalid'))).status).toBe(403);
  expect((await POST(request('team-admin:'))).status).toBe(400);
  await db.insert(schema.dockerHermesEnrollments).values({userId:'member',enabled:true});
  expect((await POST(request('member'))).status).toBe(202);
  expect(f.control).toHaveBeenCalledWith('member','/control/lease',{canCreate:true},3000);
});
it('checks the current Team definition and revision before issuing any network grant',async()=>{
  f.control.mockResolvedValueOnce({mode:'none',revision:1});
  const p=(await loadPrincipal('maintainer'))!;
  await expect(requestDockerNetwork(p,owner,input())).rejects.toMatchObject({status:409});
  expect(f.control).toHaveBeenCalledTimes(1);
  f.control.mockClear();vi.stubEnv('HERMES_TEAM_BOTS_ENABLED','');
  expect((await POST(request())).status).toBe(404);expect(f.control).not.toHaveBeenCalled();
});
