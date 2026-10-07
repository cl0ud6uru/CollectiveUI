import { readFileSync,readdirSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { Principal } from '@/lib/auth/groups';
const fixture=vi.hoisted(()=>({client:null as PGlite|null,control:vi.fn(),runtime:vi.fn()}));
vi.mock('@/lib/docker-hermes/client',()=>({dockerControl:fixture.control,dockerFetch:()=>fixture.runtime}));
vi.mock('@/db',async()=>{const {PGlite}=await import('@electric-sql/pglite');const {drizzle}=await import('drizzle-orm/pglite');const schema=await import('@/db/schema');fixture.client=new PGlite();return {db:drizzle(fixture.client,{schema}),schema};});
import { db,schema } from '@/db';
import { loadPrincipal } from '@/lib/auth/groups';
import { configureTeam,reserveTeamProfile } from '@/lib/hermes-team/store';
import { openTeamConversation,teamChatStatus } from '@/lib/hermes-team/conversations';
import { candidateWireMetadata } from '@/lib/hermes-team/candidate-wire-metadata';
import { issueTeamCandidateContext,loadCandidateContext } from '@/lib/hermes-team/candidate-context';
import { readCandidateResponse } from '@/lib/hermes-team/candidate-model';
import { candidateModelHttp } from '@/lib/hermes-team/candidate-http';
import { storeVerifiedOfficialPlanGrant,validateOfficialPlanRequest,officialPlanNativeResponse,openOfficialPlanSecret,OFFICIAL_PLAN_ADAPTER,OFFICIAL_PLAN_ORIGIN } from '@/lib/hermes-team/official-plan';
import { teamNativeAvailability,setTeamConversationModelChoice,teamConversationModelView } from '@/lib/hermes-team/candidate-availability';
import { TEAM_MODEL_PURPOSES,VERIFIED_TEAM_MODEL_ROUTES,type VerifiedTeamModelRoute } from '@/lib/hermes-team/model-policy';
import { HERMES_COMMIT } from '@/local-hermes/config';
let admin:Principal,alice:Principal,bob:Principal;
const route:VerifiedTeamModelRoute={id:'official-synthetic',adapterId:OFFICIAL_PLAN_ADAPTER,model:'synthetic-model',billing:'personal',integration:'openai_chatgpt_plan_usage',credentialHandling:'server_gateway',limitContract:'local_only',
 evidence:{id:'synthetic-only',hermesRevision:HERMES_COMMIT,adapterId:OFFICIAL_PLAN_ADAPTER,model:'synthetic-model',integration:'openai_chatgpt_plan_usage',purposes:TEAM_MODEL_PURPOSES,verifiedAt:1,expiresAt:4102444800000}};
const routes=[route];
const payload=(tools=false)=>({model:route.model,input:[{role:'user',content:'Synthetic useful procedure'}],...(tools?{tools:[{type:'function',name:'memory',description:'Private native memory',parameters:{type:'object',properties:{content:{type:'string'}}},strict:false}]}:{})});
const request=(token:string,body:unknown)=>new Request('https://app.test.invalid/api/hermes-team/native/test',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(body)});
const stream=(output:unknown[]=[],usage:unknown={input_tokens:2,output_tokens:3})=>new Response(`data: ${JSON.stringify({type:'response.completed',response:{id:'synthetic',status:'completed',output,usage}})}\n\n`,{headers:{'content-type':'text/event-stream'}});
async function ingest(p:Principal,suffix='initial',catalog=[route.model]){
 const access=`synthetic-${p.user.id}-official-${suffix}`;
 const services={verifyAccessToken:vi.fn().mockResolvedValue({issuer:'https://auth.openai.com',audience:OFFICIAL_PLAN_ORIGIN,subject:`official-${p.user.id}`,clientId:'issued-synthetic-client',scopes:['chatgpt.tokens.use.direct','resource.invoke'],issuedAt:Date.now()-1000,notBefore:Date.now()-1000,expiresAt:Date.now()+3500000}),
 fetch:vi.fn<typeof fetch>().mockImplementation(async(url,init)=>{expect(String(url)).toBe(`${OFFICIAL_PLAN_ORIGIN}/models`);expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${access}`);expect(init?.redirect).toBe('error');return Response.json({models:catalog.map(slug=>({slug,display_name:slug,visibility:'list'}))});})};
 expect(await storeVerifiedOfficialPlanGrant(p,{clientId:'issued-synthetic-client',hostId:`synthetic-host-${p.user.id}`,subject:`official-${p.user.id}`,access,refresh:`synthetic-refresh-${p.user.id}`},services)).toEqual({connected:true});return {services,access};
}
beforeAll(async()=>{await fixture.client!.waitReady;for(const file of readdirSync('src/db/migrations').filter(f=>f.endsWith('.sql')).sort())await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`,'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;','').replace(/\bvector\b/g,'real[]'));},45000);
beforeEach(async()=>{
 vi.restoreAllMocks();vi.stubEnv('HERMES_TEAM_BOTS_ENABLED','1');vi.stubEnv('HERMES_TEAM_CANDIDATE_RUNTIME_ENABLED','1');vi.stubEnv('ENCRYPTION_KEY','synthetic-official-fixture-encryption-only');fixture.control.mockReset();fixture.control.mockImplementation(async(_actor,path)=>path==='/team/revoke'?{stopped:true,interruption:'none'}:{grantId:'synthetic-current-grant'});fixture.runtime.mockReset();fixture.runtime.mockImplementation(async()=>Response.json({available:true,network:'internet'}));
 await fixture.client!.exec('TRUNCATE users,ai_apps,groups,mcp_servers CASCADE');
 await db.insert(schema.users).values([{id:'admin',upn:'admin@test.invalid',name:'Admin',isAdmin:true,authSource:'local',identityRealm:'local'},{id:'alice',upn:'alice@test.invalid',name:'Alice',authSource:'local',identityRealm:'local'},{id:'bob',upn:'bob@test.invalid',name:'Bob',authSource:'local',identityRealm:'local'}]);
 admin=(await loadPrincipal('admin'))!;alice=(await loadPrincipal('alice'))!;bob=(await loadPrincipal('bob'))!;
 await db.insert(schema.bots).values({id:'team',ownerId:'admin',name:'Team',visibility:'groups'});await db.insert(schema.botUserAccess).values([{botId:'team',userId:'alice'},{botId:'team',userId:'bob'}]);
 await configureTeam(admin,'team',{enabled:true,expectedVersion:0,maintainerIds:['admin'],modelPolicy:{mode:'personal_required',personalRouteId:route.id,adminRouteId:'app:never-company'}});
 await ingest(alice);await ingest(bob);route.transportHash=(await candidateWireMetadata(alice,route)).hash;
});
afterAll(async()=>{await fixture.client!.close();vi.unstubAllEnvs();});
async function run(p=alice,id='run'){
 const chat=await openTeamConversation(p,'team','member'),profile=await reserveTeamProfile(p,'team','member');
 await db.update(schema.hermesTeamProfiles).set({state:'ready',binding:{bindingId:'a'.repeat(32),ownerId:profile.ownerKey,botId:'team',teamBotId:'team',appId:'team',runtimeId:`synthetic-${p.user.id}-runtime`,profile:`cui-team-${'b'.repeat(32)}`,identity:`synthetic-${p.user.id}-identity`,purpose:'team-member',name:'Team',modelPolicy:'personal_required'}}).where(eq(schema.hermesTeamProfiles.id,profile.id));
 await db.insert(schema.agentRuns).values({id,userId:p.user.id,botId:'team',conversationId:chat.conversationId,messageId:`${id}-message`});return {chat,profile};
}

describe('Distinct official personal Responses candidate',()=>{
 it('keeps production inventory closed and has no official OAuth/codex credential reuse',async()=>{expect(VERIFIED_TEAM_MODEL_ROUTES).toEqual([]);const {chat}=await run();expect(await db.select().from(schema.userCredentials)).toEqual([]);await expect(issueTeamCandidateContext(alice,'run')).rejects.toMatchObject({status:409});expect(await teamNativeAvailability(alice,'team','member',{conversationId:chat.conversationId})).toMatchObject({available:false});expect((await teamChatStatus(alice,'team',chat.conversationId)).modelAccessAvailable).toBe(false);});
 it('admits two owners independently through one generic tested route and never exposes credential identity in chat status',async()=>{
  const a=await run(alice,'alice-run'),b=await run(bob,'bob-run');const aliceWire=await candidateWireMetadata(alice,route),bobWire=await candidateWireMetadata(bob,route);expect(aliceWire.hash).toBe(bobWire.hash);expect(aliceWire.personalBindingHash).not.toBe(bobWire.personalBindingHash);
  const ag=await issueTeamCandidateContext(alice,'alice-run','default',routes),bg=await issueTeamCandidateContext(bob,'bob-run','default',routes);const fetch=vi.fn<typeof globalThis.fetch>().mockImplementation(async(url,init)=>{expect(String(url)).toBe(`${OFFICIAL_PLAN_ORIGIN}/responses`);const body=JSON.parse(String(init?.body));expect(body).toMatchObject({store:false,stream:true});expect(body).not.toHaveProperty('max_output_tokens');expect(new Headers(init?.headers).get('authorization')).toMatch(/^Bearer synthetic-(alice|bob)-official-initial$/);return stream();});
  for(const [grant,user] of [[ag,'alice'],[bg,'bob']] as const)for(const purpose of TEAM_MODEL_PURPOSES){const response=await candidateModelHttp(request(grant.modelTokens[purpose],payload()),{contextId:grant.contextId,purpose,operation:['responses']},{routes,fetch});expect(response.status).toBe(200);expect((await loadCandidateContext(grant.contextId,`Bearer ${grant.modelTokens[purpose]}`,purpose,routes)).context.actorId).toBe(user);}
  expect(fetch).toHaveBeenCalledTimes(8);expect(await db.select().from(schema.usageEvents)).toHaveLength(8);expect((await db.select().from(schema.usageEvents)).every(r=>r.appId===null&&r.billingSource==='chatgpt_plan'&&r.providerKind==='chatgpt'&&r.costMicros===null)).toBe(true);
  const status=await teamChatStatus(alice,'team',a.chat.conversationId,{routes});expect(status.modelAccessAvailable).toBe(true);expect(JSON.stringify(status)).not.toMatch(/synthetic-host|issued-synthetic-client|official-alice|Bearer/);expect(b.chat.conversationId).not.toBe(a.chat.conversationId);
 });
 it('reports unresolved historical native dispatch and writer retirement as attention even with valid model/network proof',async()=>{
  const {chat}=await run(),grant=await issueTeamCandidateContext(alice,'run','default',routes);await db.insert(schema.hermesTeamCandidateRequests).values({contextId:grant.contextId,requestId:'synthetic-unresolved',kind:'model',purpose:'reply',inputHash:'a'.repeat(64),state:'needs_attention'});
  expect(await teamNativeAvailability(alice,'team','member',{conversationId:chat.conversationId,routes})).toMatchObject({available:false,needsAttention:true});expect(await teamChatStatus(alice,'team',chat.conversationId,{routes})).toMatchObject({state:'needs_attention',modelAccessAvailable:false});
  await db.delete(schema.hermesTeamCandidateRequests);await db.update(schema.hermesTeamCandidateContexts).set({workerHolder:'retained-worker',revokedAt:new Date(),retirementState:'needs_attention'}).where(eq(schema.hermesTeamCandidateContexts.id,grant.contextId));
  expect(await teamNativeAvailability(alice,'team','member',{conversationId:chat.conversationId,routes})).toMatchObject({available:false,needsAttention:true});await db.update(schema.agentRuns).set({status:'succeeded'}).where(eq(schema.agentRuns.id,'run'));await db.insert(schema.agentRuns).values({id:'new-run',userId:'alice',botId:'team',conversationId:chat.conversationId,messageId:'new-message'});await expect(issueTeamCandidateContext(alice,'new-run','default',routes)).rejects.toMatchObject({status:409});
 });
 it('normalizes flat native functions to a fixed documented namespace and converts supported tool output back to native',async()=>{
  await run();const grant=await issueTeamCandidateContext(alice,'run','default',routes),body={...payload(true),max_output_tokens:256};
  const fetch=vi.fn<typeof globalThis.fetch>().mockImplementation(async(_url,init)=>{expect(JSON.parse(String(init?.body)).tools).toEqual([{type:'namespace',name:'collective_native',description:'Approved local native functions',tools:body.tools}]);expect(JSON.parse(String(init?.body))).not.toHaveProperty('max_output_tokens');return stream([{type:'function_call',namespace:'collective_native',name:'memory',arguments:'{"content":"Private useful procedure"}',call_id:'synthetic-memory',id:'fc_synthetic'}]);});
  const result=await candidateModelHttp(request(grant.modelTokens.reply,body),{contextId:grant.contextId,purpose:'reply',operation:['responses']},{routes,fetch});expect(result.status).toBe(200);const text=await result.text();expect(text).toContain('Private useful procedure');expect(text).not.toContain('collective_native');expect(fetch).toHaveBeenCalledOnce();
 });
 it.each(['terminal','expired','retirement_attention'] as const)('fences an unconfirmed %s writer even when no revoke timestamp or request exists',async(kind)=>{
  const {chat}=await run(),grant=await issueTeamCandidateContext(alice,'run','default',routes);
  await db.update(schema.hermesTeamCandidateContexts).set({workerHolder:'retained-worker',retirementState:kind==='retirement_attention'?'needs_attention':'pending',...(kind==='expired'?{expiresAt:new Date(Date.now()-1000)}:{})}).where(eq(schema.hermesTeamCandidateContexts.id,grant.contextId));
  if(kind==='terminal')await db.update(schema.agentRuns).set({status:'succeeded'}).where(eq(schema.agentRuns.id,'run'));
  expect(await teamNativeAvailability(alice,'team','member',{conversationId:chat.conversationId,routes})).toMatchObject({available:false,needsAttention:true});
  await db.update(schema.agentRuns).set({status:'succeeded'}).where(eq(schema.agentRuns.id,'run'));
  await db.insert(schema.agentRuns).values({id:'successor',userId:'alice',botId:'team',conversationId:chat.conversationId,messageId:'successor-message'});
  await expect(issueTeamCandidateContext(alice,'successor','default',routes)).rejects.toMatchObject({status:409});
  expect(await db.select().from(schema.hermesTeamCandidateContexts)).toHaveLength(1);
 });
 it('routes the actual native auxiliary title Chat request through official Responses and converts its result',async()=>{
  await run();const grant=await issueTeamCandidateContext(alice,'run','default',routes);
  const body={model:route.model,messages:[{role:'system',content:'Generate a short session title'},{role:'user',content:'A useful procedure'}],reasoning:{enabled:false},response_format:{type:'json_schema',json_schema:{name:'session_title',strict:true,schema:{type:'object',properties:{title:{type:'string'}},required:['title'],additionalProperties:false}}}};
  const fetch=vi.fn<typeof globalThis.fetch>().mockImplementation(async(url,init)=>{expect(String(url)).toBe(`${OFFICIAL_PLAN_ORIGIN}/responses`);const wire=JSON.parse(String(init?.body));expect(wire.input[0].role).toBe('developer');expect(wire.text.format).toMatchObject({type:'json_schema',name:'session_title'});expect(wire).not.toHaveProperty('max_output_tokens');expect(wire).not.toHaveProperty('reasoning');return stream([{type:'message',role:'assistant',content:[{type:'output_text',text:'{"title":"Synthetic useful procedure"}'}]}]);});
  const result=await candidateModelHttp(request(grant.modelTokens.utility,body),{contextId:grant.contextId,purpose:'utility',operation:['chat','completions']},{routes,fetch});expect(result.status).toBe(200);expect(await result.json()).toMatchObject({object:'chat.completion',choices:[{message:{content:'{"title":"Synthetic useful procedure"}'}}],usage:{prompt_tokens:2,completion_tokens:3}});expect(fetch).toHaveBeenCalledOnce();
 });
 it('keeps a verified account unavailable when the retained broker is disabled or has network:none',async()=>{
  const {chat}=await run();fixture.runtime.mockImplementation(async()=>Response.json({available:false,network:'none'}));expect(await teamNativeAvailability(alice,'team','member',{conversationId:chat.conversationId,routes})).toMatchObject({available:false});
 });
 it.each(['token','catalog','expired-catalog','status'] as const)('pins retained owner proof across %s changes and makes zero fallback company calls',async(change)=>{
  await run();const grant=await issueTeamCandidateContext(alice,'run','default',routes),fetch=vi.fn<typeof globalThis.fetch>();
  if(change==='token')await ingest(alice,'rotated');if(change==='catalog')await ingest(alice,'rotated',['other-model']);if(change==='expired-catalog')vi.spyOn(Date,'now').mockReturnValue(Date.now()+6*60*1000);if(change==='status')await db.update(schema.officialPlanConnections).set({status:'revoked'}).where(eq(schema.officialPlanConnections.userId,'alice'));
  const response=await candidateModelHttp(request(grant.modelTokens.utility,payload()),{contextId:grant.contextId,purpose:'utility',operation:['responses']},{routes,fetch});expect(response.status).toBeGreaterThanOrEqual(400);expect(fetch).not.toHaveBeenCalled();expect(await db.select().from(schema.hermesTeamCandidateRequests)).toHaveLength(0);
 });
 it('requires an independently verified owner catalog and rejects claims/scope/client changes before catalog I/O',async()=>{
  const services={verifyAccessToken:vi.fn().mockResolvedValue({issuer:'https://auth.openai.com',audience:OFFICIAL_PLAN_ORIGIN,subject:'official-alice',clientId:'foreign-client',scopes:['openid'],issuedAt:Date.now(),notBefore:Date.now(),expiresAt:Date.now()+3600000}),fetch:vi.fn<typeof fetch>()};
  await expect(storeVerifiedOfficialPlanGrant(alice,{clientId:'issued-synthetic-client',hostId:'synthetic-host-alice',subject:'official-alice',access:'synthetic-invalid-proof'},services)).rejects.toMatchObject({status:409});expect(services.fetch).not.toHaveBeenCalled();
  const [a]=await db.select().from(schema.officialPlanConnections).where(eq(schema.officialPlanConnections.userId,'alice'));await expect(db.update(schema.officialPlanConnections).set({userId:'bob'}).where(eq(schema.officialPlanConnections.id,a.id))).rejects.toThrow();
  const [b]=await db.select().from(schema.officialPlanConnections).where(eq(schema.officialPlanConnections.userId,'bob'));expect(()=>openOfficialPlanSecret({...b,tokenBundleEnc:a.tokenBundleEnc})).toThrow();expect(()=>openOfficialPlanSecret({...a,tokenBundleEnc:'legacy-unbound'})).toThrow();
 });
 it('rejects required hard limits and unsupported selectors/hosted tools before reservations or credential transport',async()=>{
  await configureTeam(admin,'team',{enabled:true,expectedVersion:1,maintainerIds:['admin'],modelPolicy:{mode:'personal_required',personalRouteId:route.id,requireHardLimits:true}});await run();await expect(issueTeamCandidateContext(alice,'run','default',routes)).rejects.toMatchObject({status:409});expect(await db.select().from(schema.hermesTeamCandidateContexts)).toHaveLength(0);
  for(const body of [{...payload(),max_output_tokens:1000000},{...payload(),temperature:1},{...payload(),previous_response_id:'other'},{...payload(),tools:[{type:'mcp',server_url:'https://unsafe.test'}]},{...payload(),tool_choice:{type:'function',name:'memory'}},{...payload(),input:[{type:'message',role:'system',content:'unsafe'}]}])expect(()=>validateOfficialPlanRequest(body,route.model)).toThrow();
  expect(()=>validateOfficialPlanRequest(payload(),route.model,true)).toThrow();
 });
 it.each(['failed','incomplete','interrupted','unknown-tool','missing-counters','over-local-output'] as const)('retains attribution and fences fresh purpose/nonces after %s official output',async(kind)=>{
  await run();const grant=await issueTeamCandidateContext(alice,'run','default',routes);
  const fetch=vi.fn<typeof globalThis.fetch>().mockImplementation(async()=>kind==='interrupted'?new Response('data: {"type":"response.output_text.delta","delta":"unfinished"}\n\n',{headers:{'content-type':'text/event-stream'}}):kind==='failed'||kind==='incomplete'?new Response(`data: {"type":"response.${kind}","response":{"usage":{"input_tokens":2,"output_tokens":3}}}\n\n`,{headers:{'content-type':'text/event-stream'}}):kind==='unknown-tool'?stream([{type:'function_call',namespace:'foreign',name:'memory',arguments:'{}'}]):kind==='missing-counters'?stream([],null):stream([],{input_tokens:2,output_tokens:1000}));
  const response=await candidateModelHttp(request(grant.modelTokens.reply,payload()),{contextId:grant.contextId,purpose:'reply',operation:['responses']},{routes,fetch});expect(response.status).toBe(409);expect((await db.select().from(schema.hermesTeamCandidateRequests))[0].state).toBe('needs_attention');expect(await db.select().from(schema.usageEvents)).toHaveLength(1);
  const repeat=await candidateModelHttp(request(grant.modelTokens.learning,payload()),{contextId:grant.contextId,purpose:'learning',operation:['responses']},{routes,fetch});expect(repeat.status).toBe(409);expect(fetch).toHaveBeenCalledOnce();
 });
 it('persists private model choice with owner/policy/run fences and keeps default status unavailable',async()=>{
  const {chat}=await run();await db.update(schema.agentRuns).set({status:'succeeded'}).where(eq(schema.agentRuns.id,'run'));
  await expect(setTeamConversationModelChoice(bob,chat.conversationId,'personal',{expectedChoice:'default',expectedDefinitionVersion:1})).rejects.toMatchObject({status:404});expect(await setTeamConversationModelChoice(alice,chat.conversationId,'personal',{expectedChoice:'default',expectedDefinitionVersion:1})).toEqual({modelChoice:'personal'});
  expect(await teamNativeAvailability(alice,'team','member',{conversationId:chat.conversationId,routes})).toMatchObject({available:true,choice:'personal'});
  expect(await teamConversationModelView(alice,chat.conversationId)).toMatchObject({modelChoice:'personal',personalRequired:true,modelAccessAvailable:false,connectAvailable:false,personalConnection:{state:'unavailable'}});
  await expect(teamConversationModelView(bob,chat.conversationId)).rejects.toMatchObject({status:404});
  await expect(setTeamConversationModelChoice(alice,chat.conversationId,'default',{expectedChoice:'default',expectedDefinitionVersion:1})).rejects.toMatchObject({status:409});
  await expect(setTeamConversationModelChoice(alice,chat.conversationId,'default',{expectedChoice:'personal',expectedDefinitionVersion:2})).rejects.toMatchObject({status:409});
  await db.insert(schema.agentRuns).values({id:'next',userId:'alice',botId:'team',conversationId:chat.conversationId,messageId:'next-message'});await expect(setTeamConversationModelChoice(alice,chat.conversationId,'default',{expectedChoice:'personal',expectedDefinitionVersion:1})).rejects.toMatchObject({status:409});
 });
 it('keeps maintainer model preferences private across shared Admin profiles and refuses member/company policy escalation',async()=>{
  await db.insert(schema.users).values({id:'admin-two',upn:'admin-two@test.invalid',name:'Second maintainer',isAdmin:true,authSource:'local',identityRealm:'local'});const second=(await loadPrincipal('admin-two'))!;
  await configureTeam(admin,'team',{enabled:true,expectedVersion:1,maintainerIds:['admin','admin-two'],modelPolicy:{mode:'personal_required',personalRouteId:route.id}});
  const a=await openTeamConversation(admin,'team','admin'),b=await openTeamConversation(second,'team','admin');
  const chats=await db.select().from(schema.hermesTeamChats);expect(chats[0].profileId).toBe(chats[1].profileId);expect(a.conversationId).not.toBe(b.conversationId);
  await setTeamConversationModelChoice(admin,a.conversationId,'personal',{expectedChoice:'default',expectedDefinitionVersion:2});
  expect(await teamConversationModelView(second,b.conversationId)).toMatchObject({modelChoice:'default',personalRequired:true});await expect(teamConversationModelView(second,a.conversationId)).rejects.toMatchObject({status:404});
  const member=await openTeamConversation(alice,'team','member');await configureTeam(admin,'team',{enabled:true,expectedVersion:2,maintainerIds:['admin','admin-two'],modelPolicy:{mode:'admin_provided'}});
  await expect(setTeamConversationModelChoice(alice,member.conversationId,'personal',{expectedChoice:'default',expectedDefinitionVersion:3})).rejects.toMatchObject({status:403});
 });
 it('cancels a stalled synthetic response reader on the production deadline signal',async()=>{
  const abort=new AbortController(),cancel=vi.fn();const body=new ReadableStream<Uint8Array>({start(){},cancel});const response=readCandidateResponse(new Response(body,{headers:{'content-type':'text/event-stream'}}),[],abort.signal);abort.abort();await expect(response).rejects.toMatchObject({status:409});expect(cancel).toHaveBeenCalledOnce();
 });
 it('normalizes only bounded actual pinned Responses cache/reasoning hints and rejects hidden per-item overrides',()=>{
  const normalized=validateOfficialPlanRequest({...payload(),prompt_cache_key:'synthetic-cache-key',prompt_cache_retention:'24h',include:['reasoning.encrypted_content'],text:{verbosity:'low'}},route.model);expect(normalized).toMatchObject({prompt_cache_key:'synthetic-cache-key',include:['reasoning.encrypted_content'],text:{verbosity:'low'}});expect(normalized).not.toHaveProperty('prompt_cache_retention');
  for(const bad of [{...payload(),input:[{role:'user',content:'x',max_output_tokens:1000000}]},{...payload(),input:[{type:'function_call',name:'memory',call_id:'x',arguments:'{}',namespace:'other'}]},{...payload(),include:['web_search_call.action.sources']},{...payload(),prompt_cache_key:'x'.repeat(100)}])expect(()=>validateOfficialPlanRequest(bad,route.model)).toThrow();
 });
 it('rejects unknown namespaces/functions when converting official responses',()=>{const text=(namespace:string,name:string)=>`data: ${JSON.stringify({type:'response.output_item.done',item:{type:'function_call',namespace,name,arguments:'{}'}})}\n\n`;expect(()=>officialPlanNativeResponse(text('foreign','memory'),['memory'])).toThrow();expect(()=>officialPlanNativeResponse(text('collective_native','unknown'),['memory'])).toThrow();});
});
