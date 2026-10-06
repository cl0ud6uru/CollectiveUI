import { readFileSync,readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { and,eq } from 'drizzle-orm';
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { Principal } from '@/lib/auth/groups';
const fixture=vi.hoisted(()=>({client:null as PGlite|null,revoke:vi.fn()}));
vi.mock('@/lib/docker-hermes/client',()=>({dockerControl:fixture.revoke,dockerFetch:vi.fn()}));
vi.mock('@/db',async()=>{const {PGlite}=await import('@electric-sql/pglite');const {drizzle}=await import('drizzle-orm/pglite');const schema=await import('@/db/schema');fixture.client=new PGlite();return {db:drizzle(fixture.client,{schema}),schema};});
import { db,schema } from '@/db';
import { loadPrincipal } from '@/lib/auth/groups';
import { configureTeam,reserveTeamProfile } from '@/lib/hermes-team/store';
import { openTeamConversation } from '@/lib/hermes-team/conversations';
import { candidateModelHttp,candidateMcpHttp } from '@/lib/hermes-team/candidate-http';
import { issueTeamCandidateContext,loadCandidateContext } from '@/lib/hermes-team/candidate-context';
import { executeCandidateModel,nativeRequestId,nativeProviderUsage } from '@/lib/hermes-team/candidate-model';
import { executeCandidateTool,answerCandidateApproval,candidateToolName } from '@/lib/hermes-team/candidate-tools';
import { loadTeamPersonalAccess } from '@/lib/hermes-team/personal-access';
import { candidateResourceAdapter,candidateResourceAdapterId } from '@/lib/hermes-team/candidate-resource-adapter';
import { readCandidateJson,validateNativeModelRequest } from '@/lib/hermes-team/native-request';
import { queueTeamAccessReconciliation } from '@/lib/hermes-team/revocation';
import { TEAM_MODEL_PURPOSES,VERIFIED_TEAM_MODEL_ROUTES,type VerifiedTeamModelRoute } from '@/lib/hermes-team/model-policy';
import { VERIFIED_TEAM_TOOL_ADAPTERS } from '@/lib/hermes-team/tool-policy';
import { HERMES_COMMIT } from '@/local-hermes/config';
import { sealAppSecret } from '@/lib/llm/secrets';
import { sealCredentialSecret } from '@/lib/llm/chatgpt/store';
import { snapshotHash } from '@/lib/mcp/snapshot';
let admin:Principal,alice:Principal,bob:Principal;
const route:VerifiedTeamModelRoute={id:'app:provider',adapterId:'collective-openai-chat-v1',model:'synthetic-model',billing:'admin',integration:'admin_inference_gateway',credentialHandling:'server_gateway',
  evidence:{id:'synthetic-only',hermesRevision:HERMES_COMMIT,adapterId:'collective-openai-chat-v1',model:'synthetic-model',integration:'admin_inference_gateway',purposes:TEAM_MODEL_PURPOSES,verifiedAt:1,expiresAt:4102444800000}};
const personal:VerifiedTeamModelRoute={...route,id:'personal-codex',adapterId:'collective-codex-responses-v1',billing:'personal',integration:'hermes_native_codex',
  evidence:{...route.evidence,adapterId:'collective-codex-responses-v1',integration:'hermes_native_codex'}};
const routes=[route,personal];
const modelBody=(text='hello')=>({model:route.model,messages:[{role:'user',content:text}]});
const request=(token:string,body:unknown,id?:string)=>new Request('https://app.test.invalid/api/hermes-team/native/test',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`,...(id?{'x-collective-request-id':id}:{})},body:JSON.stringify(body)});
const mockedFetch=()=>vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>{
  if(JSON.parse(String(init?.body)).stream)return new Response(`data: ${JSON.stringify({id:'synthetic',object:'chat.completion.chunk',model:route.model,created:1,choices:[{index:0,delta:{role:'assistant',content:'safe reply'},finish_reason:null}]})}\n\ndata: ${JSON.stringify({id:'synthetic',object:'chat.completion.chunk',model:route.model,created:1,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:7,completion_tokens:3}})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
  return new Response(JSON.stringify({id:'synthetic',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:'safe reply'},finish_reason:'stop'}],usage:{prompt_tokens:7,completion_tokens:3}}),{headers:{'Content-Type':'application/json'}});
});
beforeAll(async()=>{
  await fixture.client!.waitReady;
  const files=readdirSync('src/db/migrations').filter(f=>f.endsWith('.sql')).sort().map(f=>`src/db/migrations/${f}`);
  for(const file of files)await fixture.client!.exec(readFileSync(file,'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;','').replace(/\bvector\b/g,'real[]'));
},45000);
beforeEach(async()=>{
  vi.stubEnv('HERMES_TEAM_BOTS_ENABLED','1');vi.stubEnv('ENCRYPTION_KEY','synthetic-candidate-fixture-encryption-only');
  fixture.revoke.mockReset();fixture.revoke.mockResolvedValue({stopped:true,interruption:'none'});
  await fixture.client!.exec('TRUNCATE users,ai_apps,groups,mcp_servers CASCADE');
  await db.insert(schema.users).values([{id:'admin',upn:'admin@test.invalid',name:'Admin',isAdmin:true,authSource:'local',identityRealm:'local'},
    {id:'alice',upn:'alice@test.invalid',name:'Alice',authSource:'local',identityRealm:'local'},
    {id:'bob',upn:'bob@test.invalid',name:'Bob',authSource:'local',identityRealm:'local'}]);
  admin=(await loadPrincipal('admin'))!;alice=(await loadPrincipal('alice'))!;bob=(await loadPrincipal('bob'))!;
  await db.insert(schema.aiApps).values({id:'provider',name:'Synthetic provider',provider:'openai-compatible',baseUrl:'https://provider.test.invalid/v1',model:route.model,credentialMode:'org',apiKeyEnc:sealAppSecret('provider','synthetic-company-secret'),providerConfig:{}});
  await db.insert(schema.bots).values({id:'team',ownerId:'admin',appId:'provider',name:'Team',visibility:'groups'});
  await db.insert(schema.botUserAccess).values([{botId:'team',userId:'alice'},{botId:'team',userId:'bob'}]);
  await configureTeam(admin,'team',{enabled:true,expectedVersion:0,maintainerIds:['admin'],modelPolicy:{mode:'admin_provided',adminRouteId:route.id}});
});
afterAll(async()=>{await fixture.client!.close();vi.unstubAllEnvs();});
async function readyRun(p:Principal,id='run',mode:'member'|'admin'='member'){
  const chat=await openTeamConversation(p,'team',mode);const profile=await reserveTeamProfile(p,'team',mode);
  await db.update(schema.hermesTeamProfiles).set({state:'ready',binding:{bindingId:'a'.repeat(32),ownerId:profile.ownerKey,botId:'team',teamBotId:'team',appId:'team',runtimeId:'synthetic-runtime',profile:`cui-team-${'b'.repeat(32)}`,identity:'synthetic-native-identity',purpose:`team-${mode}`,name:'Team',modelPolicy:'admin_provided'}}).where(eq(schema.hermesTeamProfiles.id,profile.id));
  await db.insert(schema.agentRuns).values({id,userId:p.user.id,botId:'team',conversationId:chat.conversationId,messageId:`${id}-message`});return {chat,profile};
}
async function personalConnection(userId='alice',expiresAt=new Date(Date.now()+300000)){
  await db.insert(schema.userCredentials).values({id:`${userId}-connection`,userId,provider:'chatgpt',accountId:`${userId}-account`,secretEnc:sealCredentialSecret(`${userId}-connection`,{access:'synthetic-personal-access',refresh:'synthetic-never-refresh'}),expiresAt,status:'active'});
}
async function tools(effect:'read'|'write'='read',approval=false){
  const def={name:'documents.read',inputSchema:{type:'object' as const,properties:{resourceId:{type:'string'}},required:['resourceId'],additionalProperties:false}};
  const id=candidateResourceAdapterId(def);
  const adapter=candidateResourceAdapter('documents',def,effect,{id:'synthetic-tool-evidence',hermesRevision:HERMES_COMMIT,adapterId:id,capabilityId:'documents',action:def.name,effect,verifiedAt:1,expiresAt:4102444800000});
  await db.insert(schema.mcpServers).values({id:'company-docs',name:'Synthetic documents',url:'https://connector.test.invalid/mcp',status:'enabled',trust:'trusted',toolsSnapshot:[def],toolsHash:snapshotHash([def])});
  await configureTeam(admin,'team',{enabled:true,expectedVersion:1,maintainerIds:['admin'],modelPolicy:{mode:'admin_provided',adminRouteId:route.id},
    toolPolicy:{capabilities:[{capabilityId:'documents',connectionMode:'approved_team_connection',connectionId:'company-docs',adapterId:id,action:def.name,resourceIds:['document-a'],effect,requireApproval:approval||effect==='write'}]}});
  return [adapter];
}
describe('Concrete candidate native model handlers and durable admission',()=>{
  it('keeps production inventories empty and rejects startup without writing a grant or reading provider secrets',async()=>{
    expect(VERIFIED_TEAM_MODEL_ROUTES).toEqual([]);expect(VERIFIED_TEAM_TOOL_ADAPTERS).toEqual([]);
    await readyRun(alice);
    await expect(issueTeamCandidateContext(alice,'run')).rejects.toMatchObject({status:409});
    expect(await db.select().from(schema.hermesTeamCandidateContexts)).toHaveLength(0);
  });
  it('drives the production factory/HTTP callers for all four purposes and records confirmed usage exactly once',async()=>{
    await readyRun(alice);const grant=await issueTeamCandidateContext(alice,'run','default',routes);const fetch=mockedFetch();
    for(const purpose of TEAM_MODEL_PURPOSES){const response=await candidateModelHttp(request(grant.modelTokens[purpose],modelBody()),{contextId:grant.contextId,purpose,operation:['chat','completions']},{routes,fetch});expect(response.status).toBe(200);}
    expect(fetch).toHaveBeenCalledTimes(4);
    for(const [url,init] of fetch.mock.calls){expect(String(url)).toBe('https://provider.test.invalid/v1/chat/completions');expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-company-secret');expect(init?.redirect).toBe('error');}
    expect(await db.select().from(schema.hermesTeamCandidateRequests)).toHaveLength(4);
    const usages=await db.select().from(schema.usageEvents);expect(usages).toHaveLength(4);expect(usages.every(u=>u.userId==='alice'&&u.botId==='team'&&u.runId==='run'&&u.inputTokens===7&&u.outputTokens===3&&u.costMicros===null)).toBe(true);
    expect(Object.keys((await db.select().from(schema.hermesTeamRunAttribution))[0].admission!.purposes).sort()).toEqual([...TEAM_MODEL_PURPOSES].sort());
    const replay=await candidateModelHttp(request(grant.modelTokens.reply,modelBody()),{contextId:grant.contextId,purpose:'reply',operation:['chat','completions']},{routes,fetch});expect(replay.status).toBe(200);expect(fetch).toHaveBeenCalledTimes(4);expect(await db.select().from(schema.usageEvents)).toHaveLength(4);
    expect(JSON.stringify(await db.select().from(schema.hermesTeamCandidateContexts))).not.toContain('synthetic-company-secret');
    expect(JSON.stringify(await db.select().from(schema.hermesTeamCandidateContexts))).not.toContain(grant.modelTokens.reply);
  });
  it('fixed SDK headers allow different requests and safely replay identical payloads; tampered UUIDs fail',async()=>{
    await readyRun(alice);const grant=await issueTeamCandidateContext(alice,'run','default',routes);const fetch=mockedFetch();
    await executeCandidateModel(request(grant.modelTokens.reply,modelBody('one')),grant.contextId,'reply','chat_completions',modelBody('one'),{routes,fetch});
    await executeCandidateModel(request(grant.modelTokens.reply,modelBody('two')),grant.contextId,'reply','chat_completions',modelBody('two'),{routes,fetch});
    expect(fetch).toHaveBeenCalledTimes(2);
    const id=randomUUID();await executeCandidateModel(request(grant.modelTokens.reply,modelBody('three'),id),grant.contextId,'reply','chat_completions',modelBody('three'),{routes,fetch});
    await expect(executeCandidateModel(request(grant.modelTokens.reply,modelBody('changed'),id),grant.contextId,'reply','chat_completions',modelBody('changed'),{routes,fetch})).rejects.toMatchObject({status:409});
  });
  it('purpose tokens cannot cross routes, native input cannot select actor/route, and private replies redact server credentials',async()=>{
    await readyRun(alice);const grant=await issueTeamCandidateContext(alice,'run','default',routes);
    await expect(loadCandidateContext(grant.contextId,`Bearer ${grant.modelTokens.reply}`,'utility',routes)).rejects.toMatchObject({status:403});
    for(const body of [{...modelBody(),userId:'bob'},{...modelBody(),routeId:'other'},{...modelBody(),model:'other-model'},{...modelBody(),tools:[{type:'web_search'}]}])
      expect((await candidateModelHttp(request(grant.modelTokens.reply,body),{contextId:grant.contextId,purpose:'reply',operation:['chat','completions']},{routes,fetch:mockedFetch()})).status).toBeGreaterThanOrEqual(400);
    const fetch=vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content:'synthetic-company-secret'}}]}),{headers:{'content-type':'application/json'}}));
    const response=await executeCandidateModel(request(grant.modelTokens.reply,modelBody()),grant.contextId,'reply','chat_completions',modelBody(),{routes,fetch});expect(response.body).not.toContain('synthetic-company-secret');
  });
  it('blocks concurrent/restarted ambiguous dispatch and never repeats a request after a lost provider response',async()=>{
    await readyRun(alice);const grant=await issueTeamCandidateContext(alice,'run','default',routes);
    const fetch=vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('synthetic-company-secret network ambiguity'));
    await expect(executeCandidateModel(request(grant.modelTokens.reply,modelBody()),grant.contextId,'reply','chat_completions',modelBody(),{routes,fetch})).rejects.toMatchObject({status:409});
    await expect(executeCandidateModel(request(grant.modelTokens.reply,modelBody()),grant.contextId,'reply','chat_completions',modelBody(),{routes,fetch})).rejects.toMatchObject({status:409});expect(fetch).toHaveBeenCalledOnce();
    expect((await db.select().from(schema.hermesTeamCandidateRequests))[0].state).toBe('needs_attention');
  });
  it('revokes access during actual provider I/O, cancels delivery and fences cached replay and all helper purposes',async()=>{
    await readyRun(alice);const grant=await issueTeamCandidateContext(alice,'run','default',routes);
    const fetch=vi.fn<typeof globalThis.fetch>().mockImplementation(async()=>{
      await db.transaction(async tx=>{await tx.delete(schema.botUserAccess).where(and(eq(schema.botUserAccess.botId,'team'),eq(schema.botUserAccess.userId,'alice')));await queueTeamAccessReconciliation(tx,'team','admin',{reason:'audience_changed'});});
      return new Response('{}',{headers:{'content-type':'application/json'}});
    });
    await expect(executeCandidateModel(request(grant.modelTokens.reply,modelBody()),grant.contextId,'reply','chat_completions',modelBody(),{routes,fetch})).rejects.toMatchObject({status:409});
    for(const purpose of TEAM_MODEL_PURPOSES)await expect(loadCandidateContext(grant.contextId,`Bearer ${grant.modelTokens[purpose]}`,purpose,routes)).rejects.toMatchObject({status:403});
    expect(fetch).toHaveBeenCalledOnce();expect(await db.select().from(schema.usageEvents)).toHaveLength(1);
  });
  it('required personal metadata covers every purpose, expires without refresh or company fallback, and official plan usage stays unsupported',async()=>{
    await configureTeam(admin,'team',{enabled:true,expectedVersion:1,maintainerIds:['admin'],modelPolicy:{mode:'personal_required',personalRouteId:personal.id,adminRouteId:route.id}});
    await personalConnection();await readyRun(alice);const grant=await issueTeamCandidateContext(alice,'run','default',routes);
    expect(await loadTeamPersonalAccess(alice,'hermes_native_codex')).toMatchObject({id:'alice-connection',userId:'alice',status:'active'});
    expect(await loadTeamPersonalAccess(bob,'hermes_native_codex')).toBeNull();expect(await loadTeamPersonalAccess(alice,'openai_chatgpt_plan_usage')).toBeNull();
    await db.update(schema.userCredentials).set({expiresAt:new Date(0)}).where(eq(schema.userCredentials.id,'alice-connection'));
    const fetch=mockedFetch();for(const purpose of TEAM_MODEL_PURPOSES){const body={model:personal.model,input:[{role:'user',content:'hello'}]};expect((await candidateModelHttp(request(grant.modelTokens[purpose],body),{contextId:grant.contextId,purpose,operation:['responses']},{routes,fetch})).status).toBe(403);}
    expect(fetch).not.toHaveBeenCalled();expect(await db.select().from(schema.hermesTeamCandidateRequests)).toHaveLength(0);
  });
  it('terminal runs, expired evidence and changed sessions pause native background learning rather than borrowing another identity',async()=>{
    await readyRun(alice);const grant=await issueTeamCandidateContext(alice,'run','default',routes);
    await db.update(schema.agentRuns).set({status:'succeeded'}).where(eq(schema.agentRuns.id,'run'));
    await expect(loadCandidateContext(grant.contextId,`Bearer ${grant.modelTokens.learning}`,'learning',routes)).rejects.toMatchObject({status:403});
    await db.update(schema.agentRuns).set({status:'running'}).where(eq(schema.agentRuns.id,'run'));
    await db.update(schema.users).set({sessionVersion:1}).where(eq(schema.users.id,'alice'));
    await expect(loadCandidateContext(grant.contextId,`Bearer ${grant.modelTokens.learning}`,'learning',routes)).rejects.toMatchObject({status:403});
  });
  it('enforces per-run request/output reservations before a ninth native call',async()=>{
    await readyRun(alice);const grant=await issueTeamCandidateContext(alice,'run','default',routes);const fetch=mockedFetch();
    for(let n=0;n<8;n++)await executeCandidateModel(request(grant.modelTokens.reply,modelBody(`${n}`)),grant.contextId,'reply','chat_completions',modelBody(`${n}`),{routes,fetch});
    await expect(executeCandidateModel(request(grant.modelTokens.reply,modelBody('nine')),grant.contextId,'reply','chat_completions',modelBody('nine'),{routes,fetch})).rejects.toMatchObject({status:409});expect(fetch).toHaveBeenCalledTimes(8);
  });
});
describe('Concrete scoped native MCP bridge and approval continuation',()=>{
  it('exposes only the fixed verified resource tool and denies tampered scopes before connection setup',async()=>{
    const adapters=await tools();await readyRun(alice);const grant=await issueTeamCandidateContext(alice,'run','default',routes);
    const response=await candidateMcpHttp(request(grant.toolToken,{jsonrpc:'2.0',id:1,method:'tools/list'}),grant.contextId,{routes,adapters});expect((await response.json()).result.tools[0].name).toBe(candidateToolName('documents'));
    const connect=vi.fn();for(const input of [{resourceId:'private-other-user'},{resourceId:'document-a',resourceIds:['private-other-user']},{resourceId:'document-a',actorId:'admin'}])await expect(executeCandidateTool(request(grant.toolToken,input),grant.contextId,candidateToolName('documents'),input,undefined,{routes,adapters,connect})).rejects.toBeDefined();expect(connect).not.toHaveBeenCalled();
  });
  it('dispatches a read with derived identity and rechecks every MCP transport request, then replays without duplication',async()=>{
    const adapters=await tools();await readyRun(alice);const grant=await issueTeamCandidateContext(alice,'run','default',routes);const input={resourceId:'document-a'};
    const callTool=vi.fn().mockResolvedValue({content:[{type:'text',text:'synthetic document'}]});let authorize:(()=>Promise<unknown>)|undefined;
    const connect=vi.fn().mockImplementation(async(_server,caller)=>{authorize=caller.authorize;expect(caller.subject.id).toBe('alice');expect(caller.service.grant).toBe(grant.contextId);await caller.authorize();return {callTool,close:vi.fn().mockResolvedValue(undefined)};});
    await executeCandidateTool(request(grant.toolToken,input),grant.contextId,candidateToolName('documents'),input,undefined,{routes,adapters,connect});
    await executeCandidateTool(request(grant.toolToken,input),grant.contextId,candidateToolName('documents'),input,undefined,{routes,adapters,connect});expect(callTool).toHaveBeenCalledOnce();
    await db.delete(schema.botUserAccess).where(eq(schema.botUserAccess.userId,'alice'));await expect(authorize!()).rejects.toBeDefined();
  });
  it('persists exact write approval, prohibits another human, consumes it once and binds a retry to its request',async()=>{
    const adapters=await tools('write');await readyRun(alice);const grant=await issueTeamCandidateContext(alice,'run','default',routes);const input={resourceId:'document-a'},id=randomUUID();const connect=vi.fn().mockResolvedValue({callTool:vi.fn().mockResolvedValue({content:[{type:'text',text:'done'}]}),close:vi.fn().mockResolvedValue(undefined)});
    const pending=JSON.parse((await executeCandidateTool(request(grant.toolToken,input,id),grant.contextId,candidateToolName('documents'),input,undefined,{routes,adapters,connect})).body);const approvalId=pending._meta.collectiveApprovalId;
    expect(connect).not.toHaveBeenCalled();await expect(answerCandidateApproval(admin,approvalId,'approved',{routes,adapters})).rejects.toMatchObject({status:404});
    await answerCandidateApproval(alice,approvalId,'approved',{routes,adapters});
    await executeCandidateTool(request(grant.toolToken,input,id),grant.contextId,candidateToolName('documents'),input,approvalId,{routes,adapters,connect});
    await executeCandidateTool(request(grant.toolToken,input,id),grant.contextId,candidateToolName('documents'),input,approvalId,{routes,adapters,connect});expect(connect).toHaveBeenCalledOnce();
    expect((await db.select().from(schema.hermesTeamCandidateApprovals))[0].state).toBe('consumed');
    await expect(executeCandidateTool(request(grant.toolToken,input,randomUUID()),grant.contextId,candidateToolName('documents'),input,approvalId,{routes,adapters,connect})).rejects.toMatchObject({status:409});
  });
  it('scope revocation during initialize prevents the tool call and retains an ambiguous execution fence',async()=>{
    const adapters=await tools();await readyRun(alice);const grant=await issueTeamCandidateContext(alice,'run','default',routes);const input={resourceId:'document-a'};const callTool=vi.fn();
    const connect=vi.fn().mockImplementation(async()=>{await db.update(schema.mcpServers).set({status:'disabled'}).where(eq(schema.mcpServers.id,'company-docs'));return {callTool,close:vi.fn().mockResolvedValue(undefined)};});
    await expect(executeCandidateTool(request(grant.toolToken,input),grant.contextId,candidateToolName('documents'),input,undefined,{routes,adapters,connect})).rejects.toMatchObject({status:409});expect(callTool).not.toHaveBeenCalled();
  });
});
describe('Bounded native wire contract',()=>{
  it('bounds a stalled/aborted body, rejects hosted tools, and never counts unconfirmed counters as cash',async()=>{
    vi.useFakeTimers();try{const stalled=new Request('https://test.invalid',{method:'POST',headers:{'content-type':'application/json'},body:new ReadableStream({start(){}}),duplex:'half'} as RequestInit);
      const reading=readCandidateJson(stalled);const assertion=expect(reading).rejects.toMatchObject({status:408});await vi.advanceTimersByTimeAsync(8001);await assertion;}finally{vi.useRealTimers();}
    expect(()=>validateNativeModelRequest({...modelBody(),tools:[{type:'web_search'}]},'chat_completions',route.model)).toThrow();
    expect(nativeProviderUsage({status:200,contentType:'text/event-stream',body:'data: {"type":"response.completed","response":{"usage":{"input_tokens":9,"output_tokens":4}}}\n\n'})).toEqual({input:9,output:4});
    expect(nativeProviderUsage({status:200,contentType:'application/json',body:'{}'})).toEqual({input:null,output:null});
    expect(nativeRequestId(request('a'.repeat(64),{},undefined),modelBody('one'))).not.toBe(nativeRequestId(request('a'.repeat(64),{},undefined),modelBody('two')));
  });
  it.skipIf(!process.env.HERMES_SOURCE)('actual pinned native constructor hooks, streaming SDK and MCP clients call production handlers with trusted nonces',async()=>{
    const adapters=await tools();await readyRun(alice);const grant=await issueTeamCandidateContext(alice,'run','default',routes);const fetch=mockedFetch();
    const callTool=vi.fn().mockResolvedValue({content:[{type:'text',text:'synthetic document'}]});
    // The real native MCP client talks to this bridge; the server-side company endpoint is synthetic and never networked.
    const serverConnect=vi.fn().mockResolvedValue({callTool,close:vi.fn().mockResolvedValue(undefined)});
    const server=createServer((req,res)=>{void(async()=>{
      if(req.method!=='POST'){res.writeHead(405);res.end();return;}
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      const incoming=new Request(`http://127.0.0.1${req.url}`,{method:'POST',headers:new Headers(req.headers as Record<string,string>),body:Buffer.concat(chunks)});
      const model=/^\/model\/(reply|learning|utility|subagent)\/chat\/completions$/.exec(req.url??'');
      let response:Response;
      if(model)response=await candidateModelHttp(incoming,{contextId:grant.contextId,purpose:model[1],operation:['chat','completions']},{routes,fetch});
      else if(req.url==='/mcp'){
        // Exercise the exact production MCP handler and connector factory, substituting only its upstream connect function.
        response=await candidateMcpHttp(incoming,grant.contextId,{routes,adapters,connect:serverConnect});
      }else response=new Response(null,{status:404});
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
    })().catch(()=>{res.writeHead(500);res.end('synthetic fixture failed');});});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port=(server.address() as {port:number}).port;
    const config={model:route.model,modelBaseUrls:Object.fromEntries(TEAM_MODEL_PURPOSES.map(purpose=>[purpose,`http://127.0.0.1:${port}/model/${purpose}`])),modelTokens:grant.modelTokens,toolUrl:`http://127.0.0.1:${port}/mcp`,toolToken:grant.toolToken};
    try{
      const child=spawn(process.env.HERMES_TEAM_CANDIDATE_PYTHON??'python',['tests/fixtures/hermes-team-candidate-native.py'],{env:{...process.env,HERMES_DISABLE_LAZY_INSTALLS:'1'},stdio:['pipe','pipe','pipe']});
      let output='',error='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>error+=chunk);child.stdin.end(JSON.stringify(config));
      const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
      expect(code,error).toBe(0);expect(output).toContain('"externalCalls": 0');expect(output).toContain('"nativeConstructionHooks": 4');expect(fetch).toHaveBeenCalledTimes(8);expect(callTool).toHaveBeenCalledOnce();
      expect(await db.select().from(schema.hermesTeamCandidateRequests)).toHaveLength(9);
      expect((await db.select().from(schema.hermesTeamCandidateRequests).where(eq(schema.hermesTeamCandidateRequests.kind,'model'))).every(row=>!row.requestId.startsWith('body:'))).toBe(true);
    }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  },60000);
});
