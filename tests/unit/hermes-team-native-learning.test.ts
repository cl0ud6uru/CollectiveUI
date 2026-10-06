import { readFileSync,readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { and,eq } from 'drizzle-orm';
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { Principal } from '@/lib/auth/groups';
const fixture=vi.hoisted(()=>({client:null as PGlite|null,control:vi.fn(),fetch:vi.fn(),enqueue:vi.fn()}));
vi.mock('@/lib/docker-hermes/client',()=>({dockerControl:fixture.control,dockerFetch:()=>fixture.fetch}));
vi.mock('@/lib/jobs',()=>({enqueueRun:fixture.enqueue}));
vi.mock('@/db',async()=>{const {PGlite}=await import('@electric-sql/pglite');const {drizzle}=await import('drizzle-orm/pglite');const schema=await import('@/db/schema');fixture.client=new PGlite();return {db:drizzle(fixture.client,{schema}),schema};});
import { db,schema } from '@/db';
import { loadPrincipal } from '@/lib/auth/groups';
import { configureTeam,reserveTeamProfile } from '@/lib/hermes-team/store';
import { openTeamConversation } from '@/lib/hermes-team/conversations';
import { candidateWireMetadata } from '@/lib/hermes-team/candidate-wire-metadata';
import * as candidateContextServices from '@/lib/hermes-team/candidate-context';
import { issueTeamCandidateContext,loadCandidateContext } from '@/lib/hermes-team/candidate-context';
import { captureTeamNativeLearning,scheduleTeamNativeLearning,claimTeamNativeLearning,recoverTeamNativeLearning,finishTeamNativeLearning,nativeLearningHandoffHttp } from '@/lib/hermes-team/candidate-learning';
import { startTeamCandidateRun,retireStoredTeamCandidateRun } from '@/lib/hermes-team/candidate-startup';
import { validateNativeModelRequest } from '@/lib/hermes-team/native-request';
import { queueTeamAccessReconciliation } from '@/lib/hermes-team/revocation';
import { TEAM_MODEL_PURPOSES,VERIFIED_TEAM_MODEL_ROUTES,type VerifiedTeamModelRoute } from '@/lib/hermes-team/model-policy';
import { validateNativeTeamLearningSnapshot } from '@/lib/hermes-team/learning-types';
import { HERMES_COMMIT } from '@/local-hermes/config';
import { sealAppSecret } from '@/lib/llm/secrets';
import { encrypt } from '@/lib/crypto';
import { LOCAL_ORIGIN } from '@/lib/local-hermes/client';
let admin:Principal,alice:Principal,bob:Principal;
const route:VerifiedTeamModelRoute={id:'app:provider',adapterId:'collective-openai-chat-v1',model:'synthetic-model',billing:'admin',integration:'admin_inference_gateway',credentialHandling:'server_gateway',
 evidence:{id:'synthetic-only',hermesRevision:HERMES_COMMIT,adapterId:'collective-openai-chat-v1',model:'synthetic-model',integration:'admin_inference_gateway',purposes:TEAM_MODEL_PURPOSES,verifiedAt:1,expiresAt:4102444800000}};
const routes=[route];
const snapshot={version:1 as const,messagesSnapshot:[{role:'user',content:'Private synthetic procedure'},{role:'assistant',content:'A useful procedure'}],reviewMemory:true,reviewSkills:true,focus:null,explicit:false,memoryEnabled:true,userProfileEnabled:true};
const request=(token:string,body:unknown)=>new Request('https://app.test.invalid/api/hermes-team/native/test/learning',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(body)});
beforeAll(async()=>{await fixture.client!.waitReady;for(const file of readdirSync('src/db/migrations').filter(f=>f.endsWith('.sql')).sort())await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`,'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;','').replace(/\bvector\b/g,'real[]'));},45000);
beforeEach(async()=>{
 vi.restoreAllMocks();
 vi.stubEnv('HERMES_TEAM_BOTS_ENABLED','1');vi.stubEnv('HERMES_TEAM_CANDIDATE_RUNTIME_ENABLED','1');vi.stubEnv('HERMES_TEAM_GATEWAY_ORIGIN','https://app.test.invalid');vi.stubEnv('ENCRYPTION_KEY','synthetic-learning-fixture-encryption-only');
 fixture.enqueue.mockReset();fixture.enqueue.mockResolvedValue(undefined);fixture.control.mockReset();fixture.control.mockImplementation(async(_actor,path)=>path==='/team/authorize'?{grantId:'current-server-grant'}:path==='/team/retire-candidate'?{confirmed:true,runtimeWide:true}:{stopped:true,interruption:'none'});
 fixture.fetch.mockReset();fixture.fetch.mockImplementation(async(url)=>{if(String(url).endsWith('/team/ensure'))return Response.json((await db.select().from(schema.hermesTeamProfiles))[0].binding);return String(url).endsWith('/team/start-candidate')?Response.json({started:true}):Response.json({prepared:true});});
 await fixture.client!.exec('TRUNCATE users,ai_apps,groups,mcp_servers CASCADE');
 await db.insert(schema.users).values([{id:'admin',upn:'admin@test.invalid',name:'Admin',isAdmin:true,authSource:'local',identityRealm:'local'},{id:'alice',upn:'alice@test.invalid',name:'Alice',authSource:'local',identityRealm:'local'},{id:'bob',upn:'bob@test.invalid',name:'Bob',authSource:'local',identityRealm:'local'}]);
 admin=(await loadPrincipal('admin'))!;alice=(await loadPrincipal('alice'))!;bob=(await loadPrincipal('bob'))!;
 await db.insert(schema.aiApps).values({id:'provider',name:'Synthetic provider',provider:'openai-compatible',baseUrl:'https://provider.test.invalid/v1',model:route.model,apiKeyEnc:sealAppSecret('provider','synthetic-company-secret')});route.transportHash=(await candidateWireMetadata(admin,route)).hash;
 await db.insert(schema.bots).values({id:'team',ownerId:'admin',name:'Team',visibility:'groups'});await db.insert(schema.botUserAccess).values([{botId:'team',userId:'alice'},{botId:'team',userId:'bob'}]);
 await configureTeam(admin,'team',{enabled:true,expectedVersion:0,maintainerIds:['admin'],modelPolicy:{mode:'admin_provided',adminRouteId:route.id}});
});
afterAll(async()=>{await fixture.client!.close();vi.unstubAllEnvs();});
async function foreground(p=alice,id='parent'){
 const chat=await openTeamConversation(p,'team','member');const profile=await reserveTeamProfile(p,'team','member');
 await db.update(schema.hermesTeamProfiles).set({state:'ready',binding:{bindingId:'a'.repeat(32),ownerId:profile.ownerKey,botId:'team',teamBotId:'team',appId:'team',runtimeId:'synthetic-runtime',profile:`cui-team-${'b'.repeat(32)}`,identity:'synthetic-native-identity',purpose:'team-member',name:'Team',modelPolicy:'admin_provided'}}).where(eq(schema.hermesTeamProfiles.id,profile.id));
 await db.insert(schema.agentRuns).values({id,userId:p.user.id,botId:'team',conversationId:chat.conversationId,messageId:`${id}-message`,appId:'provider',status:'running',holder:'foreground-worker',segment:0});
 const grant=await issueTeamCandidateContext(p,id,'default',routes,{holder:'foreground-worker',segment:0});return {grant,chat,profile};
}
async function capture(grant:Awaited<ReturnType<typeof issueTeamCandidateContext>>){const input={reviewId:randomUUID(),snapshot};const result=await captureTeamNativeLearning(request(grant.learningToken!,input),grant.contextId,input,routes);return {input,result};}
async function settle(contextId:string){await db.update(schema.agentRuns).set({status:'succeeded',holder:null}).where(eq(schema.agentRuns.id,'parent'));await db.update(schema.hermesTeamCandidateContexts).set({revokedAt:new Date(),retirementState:'confirmed',nativeStoppedAt:new Date()}).where(eq(schema.hermesTeamCandidateContexts.id,contextId));}

describe('Actual durable native learning handoff and trusted active startup',()=>{
 it('keeps verified catalogs empty, default flag closed and makes no native or provider call',async()=>{const {chat}=await foreground();expect(VERIFIED_TEAM_MODEL_ROUTES).toEqual([]);await expect(startTeamCandidateRun(alice,'team','parent',{holder:'foreground-worker',segment:0})).rejects.toMatchObject({status:409});expect(fixture.fetch).not.toHaveBeenCalled();expect(fixture.control).not.toHaveBeenCalled();expect(chat.conversationId).toBeTruthy();});
 it('captures encrypted private history once, rejects model token/cross-owner replay and UUID budget spam',async()=>{
  const {grant}=await foreground();const {input,result}=await capture(grant);
  expect(await captureTeamNativeLearning(request(grant.learningToken!,input),grant.contextId,input,routes)).toEqual(result);
  await expect(captureTeamNativeLearning(request(grant.modelTokens.learning,input),grant.contextId,input,routes)).rejects.toMatchObject({status:403});
  await expect(captureTeamNativeLearning(request(grant.learningToken!,{...input,reviewId:randomUUID()}),grant.contextId,{...input,reviewId:randomUUID()},routes)).rejects.toMatchObject({status:409});
  await expect(captureTeamNativeLearning(request(grant.learningToken!,{...input,snapshot:{...snapshot,focus:'changed'}}),grant.contextId,{...input,snapshot:{...snapshot,focus:'changed'}},routes)).rejects.toMatchObject({status:409});
  const second=await foreground(bob,'bob-parent');await expect(captureTeamNativeLearning(request(second.grant.learningToken!,input),grant.contextId,input,routes)).rejects.toMatchObject({status:403});
  const rows=await db.select().from(schema.hermesTeamLearningHandoffs);expect(rows).toHaveLength(1);expect(JSON.stringify(rows)).not.toContain('Private synthetic procedure');expect(rows[0].childRunId).toBeNull();
  const response=await nativeLearningHandoffHttp(request(grant.learningToken!,input),grant.contextId,{routes});expect(response.status).toBe(200);expect(await response.text()).not.toContain('messagesSnapshot');
 });
 it('waits for parent completion AND confirmed stop, then recovers a lost enqueue without a second child',async()=>{
  const {grant}=await foreground();await capture(grant);expect(await recoverTeamNativeLearning({routes})).toBe(0);expect((await db.select().from(schema.hermesTeamLearningHandoffs))[0].state).toBe('pending');
  await db.update(schema.agentRuns).set({status:'succeeded',holder:null}).where(eq(schema.agentRuns.id,'parent'));
  await expect(scheduleTeamNativeLearning(grant.contextId,{routes})).rejects.toMatchObject({status:409});expect(fixture.enqueue).not.toHaveBeenCalled();
  await settle(grant.contextId);fixture.enqueue.mockRejectedValueOnce(new Error('synthetic lost queue ack'));
  await expect(scheduleTeamNativeLearning(grant.contextId,{routes})).rejects.toThrow('synthetic lost queue ack');
  const first=(await db.select().from(schema.hermesTeamLearningHandoffs))[0];expect(first.state).toBe('queued');expect(first.childRunId).toBeTruthy();
  expect(await recoverTeamNativeLearning({routes})).toBe(1);expect((await db.select().from(schema.agentRuns)).filter(r=>r.background)).toHaveLength(1);
  expect(fixture.enqueue.mock.calls.map(c=>c[0].id)).toEqual([first.childRunId,first.childRunId]);
 });
 it.each(['interrupted','failed','cancelled'] as const)('reconciles a persisted %s child after worker claim but before learning claim without replay',async(status)=>{
  const {grant}=await foreground();await capture(grant);await settle(grant.contextId);const childId=(await scheduleTeamNativeLearning(grant.contextId,{routes}))!;
  await db.update(schema.agentRuns).set({status:'running',holder:'crashed-worker'}).where(eq(schema.agentRuns.id,childId));
  expect((await db.select().from(schema.hermesTeamLearningHandoffs))[0].state).toBe('queued');expect(await recoverTeamNativeLearning({routes})).toBe(0);
  await db.update(schema.agentRuns).set({status,holder:null}).where(eq(schema.agentRuns.id,childId));
  if(status==='interrupted')vi.spyOn(Date,'now').mockReturnValue(Date.now()+16*60*1000);
  expect(await recoverTeamNativeLearning({routes})).toBe(0);expect((await db.select().from(schema.hermesTeamLearningHandoffs))[0].state).toBe(status==='cancelled'?'cancelled':'needs_attention');
  expect(await recoverTeamNativeLearning({routes})).toBe(0);expect(fixture.enqueue).toHaveBeenCalledOnce();expect((await db.select().from(schema.agentRuns)).filter(r=>r.background)).toHaveLength(1);
 });
 it('uses a fresh separately attributed child grant, denies terminal tokens and all child company/delegate routes',async()=>{
  const {grant}=await foreground();await capture(grant);await settle(grant.contextId);const childId=(await scheduleTeamNativeLearning(grant.contextId,{routes}))!;
  await expect(loadCandidateContext(grant.contextId,`Bearer ${grant.modelTokens.learning}`,'learning',routes)).rejects.toMatchObject({status:403});
  await db.update(schema.agentRuns).set({status:'running',holder:'learning-worker'}).where(eq(schema.agentRuns.id,childId));
  const claim=await claimTeamNativeLearning(childId,'learning-worker',0,routes);expect(claim!.snapshot).toEqual(snapshot);
  const child=await issueTeamCandidateContext(alice,childId,'default',routes,{holder:'learning-worker',segment:0});expect(child.contextId).not.toBe(grant.contextId);expect(child.learningToken).toBeNull();expect(child.runPurpose).toBe('learning');
  for(const purpose of ['reply','subagent','tool'] as const)await expect(loadCandidateContext(child.contextId,`Bearer ${purpose==='tool'?child.toolToken:child.modelTokens[purpose]}`,purpose,routes)).rejects.toMatchObject({status:403});
  expect((await loadCandidateContext(child.contextId,`Bearer ${child.modelTokens.learning}`,'learning',routes)).run.run.background).toBe(true);
  expect((await loadCandidateContext(child.contextId,`Bearer ${child.modelTokens.utility}`,'utility',routes)).context.runId).toBe(childId);
  await expect(claimTeamNativeLearning(childId,'learning-worker',0,routes)).rejects.toMatchObject({status:409});expect(await recoverTeamNativeLearning({routes})).toBe(0);
  await db.update(schema.agentRuns).set({status:'succeeded',holder:null}).where(eq(schema.agentRuns.id,childId));await finishTeamNativeLearning(childId,true);expect((await db.select().from(schema.hermesTeamLearningHandoffs))[0].state).toBe('complete');
 });
 it.each(['legacy','transplanted'] as const)('retains attention for a stored %s snapshot and never starts a second child',async(kind)=>{
  const {grant}=await foreground();await capture(grant);await settle(grant.contextId);const childId=(await scheduleTeamNativeLearning(grant.contextId,{routes}))!;
  await db.update(schema.agentRuns).set({status:'running',holder:'learning-worker'}).where(eq(schema.agentRuns.id,childId));
  const ciphertext=encrypt(JSON.stringify(snapshot),kind==='transplanted'?'other-actor/source':undefined);
  const payloadEnc=kind==='legacy'?ciphertext.split('.').slice(2).join('.'):ciphertext;
  // A corrupted stored row is injected only in this disposable in-memory database.
  await fixture.client!.exec('ALTER TABLE hermes_team_learning_handoffs DISABLE TRIGGER hermes_team_learning_identity_guard');
  try{await db.update(schema.hermesTeamLearningHandoffs).set({payloadEnc}).where(eq(schema.hermesTeamLearningHandoffs.sourceContextId,grant.contextId));}
  finally{await fixture.client!.exec('ALTER TABLE hermes_team_learning_handoffs ENABLE TRIGGER hermes_team_learning_identity_guard');}
  await expect(claimTeamNativeLearning(childId,'learning-worker',0,routes)).rejects.toMatchObject({status:409});expect((await db.select().from(schema.hermesTeamLearningHandoffs))[0].state).toBe('needs_attention');expect(await recoverTeamNativeLearning({routes})).toBe(0);
 });
 it('revokes captured unqueued work and queued children atomically without canceling another member',async()=>{
  const {grant}=await foreground();await capture(grant);await settle(grant.contextId);const childId=(await scheduleTeamNativeLearning(grant.contextId,{routes}))!;
  const other=await foreground(bob,'bob-parent');await capture(other.grant);
  await db.transaction(async tx=>{await tx.delete(schema.botUserAccess).where(and(eq(schema.botUserAccess.botId,'team'),eq(schema.botUserAccess.userId,'alice')));await queueTeamAccessReconciliation(tx,'team','admin',{reason:'audience_changed'});});
  const rows=await db.select().from(schema.hermesTeamLearningHandoffs);expect(rows.find(r=>r.actorId==='alice')!.state).toBe('cancelled');expect(rows.find(r=>r.actorId==='bob')!.state).toBe('pending');expect((await db.select().from(schema.agentRuns)).find(r=>r.id===childId)!.cancelRequestedAt).not.toBeNull();
  await db.insert(schema.botUserAccess).values({botId:'team',userId:'alice'});expect(await scheduleTeamNativeLearning(grant.contextId,{routes})).toBeNull();
 });
 it.each(['session','revision','binding','route','expiry'] as const)('rejects fresh learning after %s changes and never resurrects the source capability',async(change)=>{
  const {grant,profile}=await foreground();await capture(grant);await settle(grant.contextId);
  if(change==='session')await db.update(schema.users).set({sessionVersion:1}).where(eq(schema.users.id,'alice'));
  if(change==='revision')await db.update(schema.hermesTeamProfiles).set({installedRevision:1}).where(eq(schema.hermesTeamProfiles.id,profile.id));
  if(change==='binding')await db.update(schema.hermesTeamProfiles).set({binding:{different:'binding'}}).where(eq(schema.hermesTeamProfiles.id,profile.id));
  if(change==='route')route.transportHash='0'.repeat(64);
  if(change==='expiry')vi.spyOn(Date,'now').mockReturnValue(Date.now()+16*60*1000);
  await expect(scheduleTeamNativeLearning(grant.contextId,{routes})).rejects.toMatchObject({status:change==='route'?409:403});expect(fixture.enqueue).not.toHaveBeenCalled();
 });
 it('trusted active startup pins server identity/lease and retirement closes tokens before exact broker cleanup',async()=>{
  const {chat,profile}=await foreground();await db.delete(schema.hermesTeamCandidateContexts);const active=await startTeamCandidateRun(alice,'team','parent',{holder:'foreground-worker',segment:0,routes});
  const start=fixture.fetch.mock.calls.find(c=>String(c[0]).endsWith('/team/start-candidate'));expect(JSON.parse(start![1].body)).toMatchObject({teamBotId:'team',mode:'member',bindingId:'a'.repeat(32),runId:'parent',contextId:active.contextId,conversationId:chat.conversationId});
  const prepared=JSON.parse(fixture.fetch.mock.calls.find(c=>String(c[0]).endsWith('/team/prepare-candidate'))![1].body);expect(prepared.runPurpose).toBe('chat');expect(prepared.learningToken).toMatch(/^[a-f0-9]{64}$/);
  fixture.control.mockImplementation(async(_actor,path,scope)=>{if(path==='/team/retire-candidate'){const [c]=await db.select().from(schema.hermesTeamCandidateContexts).where(eq(schema.hermesTeamCandidateContexts.id,scope.contextId));expect(c.revokedAt).not.toBeNull();return {confirmed:true,runtimeWide:true};}return {grantId:'renewed'};});
  await active.authorize();await db.update(schema.agentRuns).set({status:'succeeded',holder:null}).where(eq(schema.agentRuns.id,'parent'));expect(await active.retire()).toEqual({confirmed:true,runtimeWide:true});expect(await retireStoredTeamCandidateRun('parent')).toEqual({confirmed:true,runtimeWide:true});
  expect(fixture.control.mock.calls.filter(c=>c[1]==='/team/retire-candidate')).toHaveLength(1);expect((await db.select().from(schema.hermesTeamCandidateContexts))[0].retirementState).toBe('confirmed');expect(profile.id).toBeTruthy();
 });
 it('derives every native startup binding from the issued grant after a pre-issuance profile swap',async()=>{
  const {profile}=await foreground();await db.delete(schema.hermesTeamCandidateContexts);const original=candidateContextServices.issueTeamCandidateContext;
  vi.spyOn(candidateContextServices,'issueTeamCandidateContext').mockImplementation(async(...args)=>{
   const [stored]=await db.select().from(schema.hermesTeamProfiles).where(eq(schema.hermesTeamProfiles.id,profile.id));
   await db.update(schema.hermesTeamProfiles).set({binding:{...(stored.binding as object),bindingId:'c'.repeat(32)}}).where(eq(schema.hermesTeamProfiles.id,profile.id));return original(...args);
  });
  const active=await startTeamCandidateRun(alice,'team','parent',{holder:'foreground-worker',segment:0,routes});
  expect(active.target.profile).toBe('c'.repeat(32));
  for(const call of fixture.fetch.mock.calls.filter(c=>String(c[0]).endsWith('/team/prepare-candidate')||String(c[0]).endsWith('/team/start-candidate')))expect(JSON.parse(call[1].body).bindingId).toBe('c'.repeat(32));
  expect((await db.select().from(schema.hermesTeamCandidateContexts))[0].bindingHash).toBe(candidateContextServices.candidateObjectHash((await db.select().from(schema.hermesTeamProfiles))[0].binding));await active.retire();
 });
 it('classifies a succeeded but never-claimed learning assignment as attention, never complete',async()=>{
  const {grant}=await foreground();await capture(grant);await settle(grant.contextId);const childId=(await scheduleTeamNativeLearning(grant.contextId,{routes}))!;
  await db.update(schema.agentRuns).set({status:'succeeded'}).where(eq(schema.agentRuns.id,childId));await finishTeamNativeLearning(childId,true);expect((await db.select().from(schema.hermesTeamLearningHandoffs))[0].state).toBe('needs_attention');
 });
 it('detects stale worker after prepare, revokes the attempted grant and never starts native work',async()=>{
  await foreground();await db.delete(schema.hermesTeamCandidateContexts);fixture.fetch.mockImplementation(async(url)=>{if(String(url).endsWith('/team/ensure'))return Response.json((await db.select().from(schema.hermesTeamProfiles))[0].binding);if(String(url).endsWith('/team/prepare-candidate'))await db.update(schema.agentRuns).set({holder:'other-worker'}).where(eq(schema.agentRuns.id,'parent'));return Response.json({prepared:true});});
  await expect(startTeamCandidateRun(alice,'team','parent',{holder:'foreground-worker',segment:0,routes})).rejects.toMatchObject({status:403});expect(fixture.fetch.mock.calls.some(c=>String(c[0]).endsWith('/team/start-candidate'))).toBe(false);expect((await db.select().from(schema.hermesTeamCandidateContexts))[0].revokedAt).not.toBeNull();
 });
 it('renews the exact active grant during streaming and aborts on a changed worker lease',async()=>{
  await foreground();await db.delete(schema.hermesTeamCandidateContexts);const active=await startTeamCandidateRun(alice,'team','parent',{holder:'foreground-worker',segment:0,routes});
  vi.useFakeTimers({toFake:['setInterval','clearInterval']});
  try{
   fixture.fetch.mockImplementation(async(url)=>String(url).endsWith('/team/renew-candidate')?Response.json({renewed:true}):new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('synthetic stream'));}})));
   const response=await active.target.fetch!(`${LOCAL_ORIGIN}/p/${'a'.repeat(32)}/v1/responses`,{method:'POST'});const reader=response.body!.getReader();expect((await reader.read()).done).toBe(false);
   const call=fixture.fetch.mock.calls.find(c=>String(c[0]).includes('/v1/responses'));const headers=new Headers(call![1].headers);expect(headers.get('x-collective-team-bot')).toBe('team');expect(headers.get('x-collective-team-mode')).toBe('member');
   await vi.advanceTimersByTimeAsync(15000);expect(fixture.fetch.mock.calls.some(c=>String(c[0]).endsWith('/team/renew-candidate'))).toBe(true);
   await db.update(schema.agentRuns).set({holder:'changed-worker'}).where(eq(schema.agentRuns.id,'parent'));
   await vi.advanceTimersByTimeAsync(15000);expect(fixture.control.mock.calls.some(c=>c[1]==='/team/retire-candidate')).toBe(true);
   await expect(reader.read()).rejects.toMatchObject({status:403});expect((await db.select().from(schema.hermesTeamCandidateContexts))[0].revokedAt).not.toBeNull();
  }finally{vi.useRealTimers();}
 });
 it('preserves unresolved retired dispatch fences across new runs rather than resetting usage budgets',async()=>{
  const {grant,chat}=await foreground();await db.insert(schema.hermesTeamCandidateRequests).values({id:randomUUID(),contextId:grant.contextId,requestId:randomUUID(),kind:'model',purpose:'reply',inputHash:'a'.repeat(64),outputReserved:256,inputReservedBytes:1,state:'needs_attention'});await settle(grant.contextId);
  await db.insert(schema.agentRuns).values({id:'next',userId:'alice',botId:'team',conversationId:chat.conversationId,messageId:'next-message',appId:'provider'});await expect(issueTeamCandidateContext(alice,'next','default',routes)).rejects.toMatchObject({status:409});
 });
 it('accepts only the actual pinned disabled title reasoning shape and bounds omitted max_tokens',()=>{
  const body={model:route.model,messages:[{role:'user',content:'Title this session'}],response_format:{type:'json_schema',json_schema:{name:'session_title',strict:true,schema:{type:'object',properties:{title:{type:'string'}},required:['title'],additionalProperties:false}}},reasoning:{enabled:false}};
  expect(validateNativeModelRequest(body,'chat_completions',route.model)).toEqual({...body,reasoning:undefined,max_tokens:256});
  for(const reasoning of [{enabled:true},{enabled:false,max_tokens:1000000},{effort:'high'}])expect(()=>validateNativeModelRequest({...body,reasoning},'chat_completions',route.model)).toThrow();
  expect(()=>validateNativeTeamLearningSnapshot({...snapshot,provider:'openai'})).toThrow();expect(()=>validateNativeTeamLearningSnapshot({...snapshot,messagesSnapshot:[{role:'user',content:'x'.repeat(64000)}]})).toThrow();
 });
});
