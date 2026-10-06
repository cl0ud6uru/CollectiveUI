import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, pool } from '@/db';
import { users, dockerHermesEnrollments, auditLog } from '@/db/schema';
import { loadPrincipal, type Principal } from '@/lib/auth/groups';
import { newId } from '@/lib/ids';
import { requestDockerNetwork } from '@/lib/docker-hermes/network';
const f=vi.hoisted(()=>({calls:[] as {owner:string;action:string;data:unknown}[],revision:0,fail:false,onStatus:null as null|(()=>Promise<void>)}));
vi.mock('@/lib/docker-hermes/client',()=>({dockerControl:async(owner:string,action:string,data?:unknown)=>{
 f.calls.push({owner,action,data});
 if(action==='/control/network' && data===undefined){await f.onStatus?.();return {mode:'none',revision:f.revision};}
 if(action==='/control/network'){if(f.fail)throw new Error('Uncertain dispatch');return {mode:'none',revision:f.revision,changing:true};}
 return {renewed:true};
}}));
const suite=process.env.DOCKER_HERMES_DB_TEST==='1'?describe:describe.skip;
suite('audited Admin network admission, real PostgreSQL and synthetic broker',()=>{
 const ids:string[]=[];let admin:Principal,alice:Principal;
 beforeAll(async()=>{if(new URL(process.env.DATABASE_URL!).pathname!=='/collective_docker_hermes_test')throw new Error('Named disposable database required');
  for(const name of ['network-admin','network-alice']){const id=newId();ids.push(id);await db.insert(users).values({id,upn:`${id}@example.invalid`,name,authSource:'ldap',isAdmin:name==='network-admin'});}
  [admin,alice]=await Promise.all(ids.map(async id=>(await loadPrincipal(id))!));
  await db.insert(dockerHermesEnrollments).values({userId:alice.user.id,enabled:true,cleanup:'none'});
 });
 beforeEach(()=>{f.calls=[];f.fail=false;f.onStatus=null;f.revision=0;});
 afterAll(async()=>{await db.delete(auditLog).where(inArray(auditLog.target,ids));await db.delete(users).where(inArray(users.id,ids));await pool.end();});
 const input=()=>({mode:'internet',revision:0,requestId:randomUUID(),confirmRestart:true});
 const audits=()=>db.select().from(auditLog).where(eq(auditLog.target,alice.user.id));
 it('ordinary users cannot dispatch or write a network audit intent',async()=>{await expect(requestDockerNetwork(alice,alice.user.id,input())).rejects.toThrow('Admin');expect(f.calls).toEqual([]);expect(await audits()).toEqual([]);});
 it('commits intent before acceptance, keeps one audit identity on retries and rejects changed request payloads',async()=>{
  const request=input();await requestDockerNetwork(admin,alice.user.id,request);const rows=await audits();expect(rows).toHaveLength(1);expect(rows[0].details).toMatchObject({requestId:request.requestId,status:'accepted'});
  await requestDockerNetwork(admin,alice.user.id,request);expect(await audits()).toHaveLength(1);
  expect(f.calls.filter(c=>c.action==='/control/network' && c.data!==undefined)).toHaveLength(2); // broker deduplicates the same durable request
  await expect(requestDockerNetwork(admin,alice.user.id,{...request,mode:'none'})).rejects.toThrow('different');
 });
 it('refuses stale revisions and freshly revoked enrollment before dispatch',async()=>{
  f.revision=1;await expect(requestDockerNetwork(admin,alice.user.id,input())).rejects.toThrow('changed');expect(f.calls.some(c=>c.data!==undefined)).toBe(false);
  f.calls=[];await db.update(dockerHermesEnrollments).set({enabled:false}).where(eq(dockerHermesEnrollments.userId,alice.user.id));
  await expect(requestDockerNetwork(admin,alice.user.id,input())).rejects.toThrow('Allow personal');expect(f.calls).toEqual([]);
  await db.update(dockerHermesEnrollments).set({enabled:true}).where(eq(dockerHermesEnrollments.userId,alice.user.id));
 });
 it('retains a requested audit after uncertain dispatch so the same request can be reconciled',async()=>{
  f.fail=true;const request=input();await expect(requestDockerNetwork(admin,alice.user.id,request)).rejects.toThrow('Uncertain');
  expect((await audits()).find(r=>(r.details as {requestId?:string})?.requestId===request.requestId)?.details).toMatchObject({status:'requested'});
  f.fail=false;await requestDockerNetwork(admin,alice.user.id,request);expect((await audits()).filter(r=>(r.details as {requestId?:string})?.requestId===request.requestId)).toHaveLength(1);
 });
 it('rechecks Admin privileges after audit commit and before any grant or network dispatch',async()=>{
  f.onStatus=async()=>{await db.update(users).set({isAdmin:false}).where(eq(users.id,admin.user.id));};
  await expect(requestDockerNetwork(admin,alice.user.id,input())).rejects.toThrow('Admin');expect(f.calls.map(c=>c.action)).toEqual(['/control/network']);
  await db.update(users).set({isAdmin:true}).where(eq(users.id,admin.user.id));
 });
});
