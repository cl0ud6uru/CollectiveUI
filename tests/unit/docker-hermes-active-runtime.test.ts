import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {DockerBroker} from '@/docker-hermes/broker';
import {BrokerConfig,runtimeKey,type RuntimeDriver,type Profile} from '@/docker-hermes/docker';
import {teamCandidateConfig,teamLearningSnapshot,type TeamCandidateConfig,type TeamMode} from '@/docker-hermes/types';
import {stopOwnedGroup} from '@/local-hermes/process-group';
import type {LocalController} from '@/local-hermes/controller';
import {listenBroker} from '@/docker-hermes/main';
import {socketFetch,LOCAL_ORIGIN} from '@/lib/local-hermes/client';

/** Synthetic native wire only. Actual pinned-source gateway coverage lives in its independent lifecycle fixture. */
class Driver implements RuntimeDriver {
  profilesByOwner=new Map<string,Profile[]>();active=new Set<string>();children=new Map<string,Set<ChildProcessWithoutNullStreams>>();
  launches=0;stops=0;stopFailure=false;reopenGate?:()=>Promise<void>;
  constructor(readonly root:string){}
  async ensure(owner:string,stage:Parameters<RuntimeDriver['ensure']>[1]){stage('checking_image');this.active.add(owner);this.profilesByOwner.set(owner,this.profilesByOwner.get(owner)??[{name:'default',identity:'retained-default'}]);stage('checking_native');}
  async running(owner:string){return this.active.has(owner);}
  async stop(owner:string){this.stops++;if(this.stopFailure)throw new Error('unconfirmed');this.active.delete(owner);const children=this.children.get(owner);this.children.delete(owner);if(children)await Promise.all([...children].map(async c=>{if(c.pid)await stopOwnedGroup(c.pid);}));}
  async reopen(owner:string){await this.reopenGate?.();this.active.add(owner);}
  async profiles(owner:string){return this.profilesByOwner.get(owner)??[];}
  async create(owner:string,name:string){const rows=this.profilesByOwner.get(owner)!;let row=rows.find(p=>p.name===name);if(!row){await mkdir(path.join(this.root,runtimeKey(owner),name),{recursive:true});row={name,identity:`identity-${name}`};rows.push(row);}return row;}
  createTeam(owner:string,name:string){return this.create(owner,name);}
  async resources(){return {skills:[],memories:[]};}
  transport(owner:string,profile:string){return {spawn:()=>{this.launches++;const child=spawn('/usr/bin/python3',['-u','-m','tui_gateway.entry'],{cwd:path.resolve('tests/fixtures/hermes-native'),detached:true,env:{NODE_ENV:'test',PATH:'/usr/bin:/bin',HERMES_HOME:path.join(this.root,runtimeKey(owner),profile)},stdio:['pipe','pipe','pipe']});const children=this.children.get(owner)??new Set();children.add(child);this.children.set(owner,children);return child;},stop:()=>this.stop(owner)};}
  candidateTransport(owner:string,profile:string,_identity:string,config:TeamCandidateConfig){
    if(config.runPurpose!=='learning')return this.transport(owner,profile);
    return {spawn:()=>{this.launches++;const child=spawn('/usr/bin/python3',['-u',path.resolve('tests/fixtures/hermes-team-learning-wire.py')],{detached:true,env:{NODE_ENV:'test',PATH:'/usr/bin:/bin',HERMES_HOME:path.join(this.root,runtimeKey(owner),profile)},stdio:['pipe','pipe','pipe']});const children=this.children.get(owner)??new Set();children.add(child);this.children.set(owner,children);return child;},stop:()=>this.stop(owner)};
  }
}
let root:string,config:BrokerConfig,driver:Driver,broker:DockerBroker;
beforeEach(async()=>{root=await mkdtemp(path.join(tmpdir(),'team-active-'));await mkdir(path.join(root,'state'));await mkdir(path.join(root,'ipc'));config=BrokerConfig.parse({stateDir:path.join(root,'state'),socketPath:path.join(root,'ipc/b.sock'),bridgePath:path.resolve('src/docker-hermes/bridge.py'),namespace:'cui-active-test',image:`nousresearch/hermes-agent@sha256:${'a'.repeat(64)}`,network:'none',teamBotsEnabled:true,teamCandidateRuntimeEnabled:true});driver=new Driver(root);broker=new DockerBroker(config,driver);});
afterEach(async()=>{vi.restoreAllMocks();driver.stopFailure=false;driver.reopenGate=undefined;await broker.close();await rm(root,{recursive:true,force:true});});
const until=async(check:()=>boolean)=>{const end=Date.now()+8000;while(!check()){if(Date.now()>end)throw new Error('Timed out');await new Promise(r=>setTimeout(r,10));}};
async function prepare(actor='alice',mode:TeamMode='member',runId='app-run',contextId='context',purpose:'chat'|'learning'='chat'){
  const grant=broker.authorizeTeam(actor,{teamBotId:'bot',mode,modelPolicy:'personal_required'});
  const binding=await broker.ensureTeam(actor,{teamBotId:'bot',mode,name:'Team'},grant.grantId);
  const config:TeamCandidateConfig={teamBotId:'bot',mode,bindingId:binding.bindingId,runId,contextId,expiresAt:Date.now()+120000,model:'synthetic-model',adapterId:'collective-openai-chat-v1',modelBaseUrls:{reply:'https://fixture.invalid/reply',learning:'https://fixture.invalid/learning',utility:'https://fixture.invalid/utility',subagent:'https://fixture.invalid/subagent'},modelTokens:{reply:'a'.repeat(64),learning:'b'.repeat(64),utility:'c'.repeat(64),subagent:'d'.repeat(64)},toolUrl:'https://fixture.invalid/mcp',toolToken:'e'.repeat(64)};
  if(purpose==='chat'){config.learningUrl='https://fixture.invalid/handoff';config.learningToken='f'.repeat(64);}
  else {config.runPurpose='learning';config.learningSnapshot={version:1,messagesSnapshot:[{role:'user',content:'Synthetic private learning'}],reviewMemory:true,reviewSkills:true,focus:null,explicit:false,memoryEnabled:true,userProfileEnabled:true};}
  broker.prepareTeamCandidate(actor,config,grant.grantId);
  return {binding,grant,config,scope:{teamBotId:'bot',mode,bindingId:binding.bindingId,runId,contextId,conversationId:'conversation'}};
}
const access=(p:Awaited<ReturnType<typeof prepare>>,actor='alice')=>broker.forTeamRequest(actor,'bot',p.scope.mode,p.binding.bindingId,p.grant.grantId,{runId:p.scope.runId,contextId:p.scope.contextId});
const begin=(controller:LocalController,nativeBindingId:string,p:Awaited<ReturnType<typeof prepare>>,text='hello')=>controller.begin(nativeBindingId,{input:text,session_id:'portal-conversation-bot'},`portal-${p.scope.runId}`);
const terminal=async(controller:LocalController,id:string)=>until(()=>['completed','interrupted','cancelled','failed'].includes(controller.getRun(id).status));

describe('server-scoped active Team runtime',()=>{
  it('keeps both the new flag and absent prepared-context requests closed',async()=>{const p=await prepare();expect(BrokerConfig.parse({...config,teamCandidateRuntimeEnabled:undefined}).teamCandidateRuntimeEnabled).toBe(false);await mkdir(path.join(root,'disabled-state'));const disabled=new DockerBroker({...config,stateDir:path.join(root,'disabled-state'),teamCandidateRuntimeEnabled:false},driver);expect(()=>disabled.startTeamCandidate('alice',p.scope,p.grant.grantId)).toThrow('disabled');await expect(broker.forTeamRequest('alice','bot','member',p.binding.bindingId,p.grant.grantId)).rejects.toThrow('not verified');expect(driver.launches).toBe(0);});
  it('starts once, binds one app run/conversation and preserves native replay without plaintext grants',async()=>{const p=await prepare();const [first,second]=await Promise.all([broker.startTeamCandidate('alice',p.scope,p.grant.grantId),broker.startTeamCandidate('alice',p.scope,p.grant.grantId)]);expect(first).toEqual(second);expect(driver.launches).toBe(1);const {controller,nativeBindingId}=await access(p);expect(()=>controller.begin(nativeBindingId,{input:'wrong',session_id:'another-conversation'},'portal-app-run')).toThrow('another run');expect(()=>controller.begin(nativeBindingId,{input:'wrong',session_id:'portal-conversation-bot'},'another-receipt')).toThrow('another run');const id=begin(controller,nativeBindingId,p);await terminal(controller,id);expect(controller.getRun(id).status).toBe('completed');expect(begin(controller,nativeBindingId,p)).toBe(id);expect(()=>controller.getRun('run_unknown')).toThrow('another context');const text=await readFile(path.join(config.stateDir,runtimeKey('alice'),'runtime.json'),'utf8');expect(text).not.toContain(p.config.toolToken);expect(text).not.toContain(p.config.modelTokens.reply);expect(text).toContain(p.scope.contextId);});
  it('rejects cross-actor, mode, context, changed bootstrap and arbitrary path admission',async()=>{const p=await prepare();const bob=broker.authorizeTeam('bob',{teamBotId:'bot',mode:'member',modelPolicy:'personal_required'});expect(()=>broker.startTeamCandidate('bob',p.scope,bob.grantId)).toThrow();expect(()=>broker.startTeamCandidate('alice',{...p.scope,mode:'admin'},p.grant.grantId)).toThrow();expect(()=>broker.startTeamCandidate('alice',{...p.scope,contextId:'different'},p.grant.grantId)).toThrow('another run');expect(()=>broker.startTeamCandidate('alice',{...p.scope,profile:'/tmp/path'},p.grant.grantId)).toThrow();expect(()=>broker.prepareTeamCandidate('alice',{...p.config,model:'changed'},p.grant.grantId)).toThrow('Another');expect(driver.launches).toBe(0);});
  it('retires exactly once and a delayed old retirement cannot stop a newer run',async()=>{const p=await prepare();await broker.startTeamCandidate('alice',p.scope,p.grant.grantId);const {controller,nativeBindingId}=await access(p);const id=begin(controller,nativeBindingId,p);await terminal(controller,id);expect(await broker.retireTeamCandidate('alice',{teamBotId:p.scope.teamBotId,mode:p.scope.mode,bindingId:p.scope.bindingId,runId:p.scope.runId,contextId:p.scope.contextId})).toEqual({confirmed:true,runtimeWide:true});const next=await prepare('alice','member','next-run','next-context');await broker.startTeamCandidate('alice',next.scope,next.grant.grantId);const stops=driver.stops;await broker.retireTeamCandidate('alice',{teamBotId:p.scope.teamBotId,mode:p.scope.mode,bindingId:p.scope.bindingId,runId:p.scope.runId,contextId:p.scope.contextId});expect(driver.stops).toBe(stops);expect(driver.active.has('alice')).toBe(true);expect(await access(next)).toBeDefined();});
  it('does not restart an uncertain native context after broker restart',async()=>{const p=await prepare();await broker.startTeamCandidate('alice',p.scope,p.grant.grantId);await broker.close();broker=new DockerBroker(config,driver);const recovered=await prepare();expect(recovered.binding).toEqual(p.binding);expect(()=>broker.startTeamCandidate('alice',recovered.scope,recovered.grant.grantId)).toThrow('retained start receipt');expect(driver.launches).toBe(1);});
  it('stops the affected admin actor even while another maintainer has a fresh lease',async()=>{const p=await prepare('alice','admin');await broker.startTeamCandidate('alice',p.scope,p.grant.grantId);const {controller,nativeBindingId}=await access(p);begin(controller,nativeBindingId,p,'slow');const carol=broker.authorizeTeam('carol',{teamBotId:'bot',mode:'admin',modelPolicy:'personal_required'});expect(await broker.revokeTeam('carol',{teamBotId:'bot',mode:'admin'})).toEqual({stopped:false,interruption:'none'});expect(driver.active.has(p.binding.ownerId)).toBe(true);expect(await broker.revokeTeam('alice',{teamBotId:'bot',mode:'admin'})).toEqual({stopped:true,interruption:'runtime-wide'});expect(driver.active.has(p.binding.ownerId)).toBe(false);expect(()=>broker.teamBinding('carol','bot','admin',carol.grantId)).toThrow();});
  it('fences grant expiry before approvals and does not inherit a sibling admin lease',async()=>{const now=Date.now(),clock=vi.spyOn(Date,'now').mockReturnValue(now);const p=await prepare('alice','admin');await broker.startTeamCandidate('alice',p.scope,p.grant.grantId);const {controller,nativeBindingId}=await access(p);const id=begin(controller,nativeBindingId,p,'approve');await until(()=>controller.events(id,0).events.some(e=>e.event==='approval.request'));const event=controller.events(id,0).events.find(e=>e.event==='approval.request')!;clock.mockReturnValue(now+30000);broker.authorizeTeam('carol',{teamBotId:'bot',mode:'admin',modelPolicy:'personal_required'});clock.mockReturnValue(now+61000);expect(()=>controller.approve(id,{request_id:event.request_id,choice:'once'})).toThrow('authorization');await broker.expireLeases();expect(driver.active.has(p.binding.ownerId)).toBe(false);});
  it('renews only the retained actor scope without extending native context expiry',async()=>{
    const now=Date.now(),clock=vi.spyOn(Date,'now').mockReturnValue(now),p=await prepare();
    await broker.startTeamCandidate('alice',p.scope,p.grant.grantId);
    const scope={teamBotId:'bot',mode:'member' as const,bindingId:p.binding.bindingId,runId:p.scope.runId,contextId:p.scope.contextId};
    clock.mockReturnValue(now+61000);
    const fresh=broker.authorizeTeam('alice',{teamBotId:'bot',mode:'member',modelPolicy:'personal_required'});
    expect(broker.renewTeamCandidate('alice',scope,fresh.grantId)).toEqual({renewed:true,expiresAt:p.config.expiresAt});
    expect(()=>broker.renewTeamCandidate('alice',{...scope,runId:'other'},fresh.grantId)).toThrow('another context');
    await broker.expireLeases();expect(driver.active.has('alice')).toBe(true);
    clock.mockReturnValue(now+121000);
    const later=broker.authorizeTeam('alice',{teamBotId:'bot',mode:'member',modelPolicy:'personal_required'});
    expect(()=>broker.renewTeamCandidate('alice',scope,later.grantId)).toThrow('ended');
    await broker.expireLeases();expect(driver.active.has('alice')).toBe(false);
  });
  it('refuses an unfinished sibling before any runtime-wide interruption',async()=>{const p=await prepare();const sibling={holdForSettings:()=>{throw new Error('unfinished sibling');},stop:vi.fn()} as unknown as LocalController;(broker as unknown as {controllers:Map<string,LocalController>}).controllers.set(p.binding.bindingId,sibling);const stops=driver.stops;await expect(broker.startTeamCandidate('alice',p.scope,p.grant.grantId)).rejects.toThrow('unfinished sibling');expect(driver.stops).toBe(stops);expect(driver.active.has('alice')).toBe(true);(broker as unknown as {controllers:Map<string,LocalController>}).controllers.delete(p.binding.bindingId);});
  it('closes generation while startup is waiting, cleans up after the delayed reopen and never spawns',async()=>{const p=await prepare();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>{release=r;});const inside=new Promise<void>(r=>{entered=r;});driver.reopenGate=async()=>{entered();await gate;};const start=broker.startTeamCandidate('alice',p.scope,p.grant.grantId);const failed=expect(start).rejects.toThrow('interrupted');await inside;const stop=broker.stop('alice');release();await failed;await stop;expect(driver.launches).toBe(0);expect(driver.active.has('alice')).toBe(false);});
  it('admits a learning child only through its derived native session and records no chat prompt',async()=>{
    const p=await prepare('alice','member','learning-run','learning-context','learning');await broker.startTeamCandidate('alice',p.scope,p.grant.grantId);
    const {controller,nativeBindingId}=await access(p);
    expect(()=>begin(controller,nativeBindingId,p)).toThrow('ordinary chat');
    const id=controller.beginLearning(nativeBindingId);await terminal(controller,id);expect(controller.getRun(id).status).toBe('completed');
    expect(controller.beginLearning(nativeBindingId)).toBe(id);
    const wire=await readFile(path.join(root,runtimeKey('alice'),p.binding.profile,'learning-wire.jsonl'),'utf8');
    expect(wire.trim().split('\n')).toHaveLength(1);expect(JSON.parse(wire)).toEqual({session_id:'runtime-learning'});expect(wire).not.toContain('Synthetic private learning');
    const retained=await readFile(path.join(config.stateDir,runtimeKey('alice'),'runtime.json'),'utf8');expect(retained).not.toContain('Synthetic private learning');
  });
  it('rejects recursive, malformed and oversized learning snapshots before native startup',()=>{
    const snapshot={version:1,messagesSnapshot:[{role:'user',content:'synthetic'}],reviewMemory:true,reviewSkills:false,focus:null,explicit:false,memoryEnabled:true,userProfileEnabled:true};
    expect(teamLearningSnapshot.safeParse(snapshot).success).toBe(true);
    expect(teamLearningSnapshot.safeParse({...snapshot,messagesSnapshot:[{content:'x'.repeat(64000)}]}).success).toBe(false);
    expect(teamLearningSnapshot.safeParse({...snapshot,messagesSnapshot:[{items:Array(10001).fill(0)}]}).success).toBe(false);
    expect(teamLearningSnapshot.safeParse({...snapshot,profile:'/tmp/other'}).success).toBe(false);
    expect(teamCandidateConfig.safeParse({runPurpose:'learning',learningSnapshot:snapshot,learningUrl:'https://fixture.invalid/recursive'}).success).toBe(false);
  });
  it('routes only scoped startup/run calls through the protected Unix socket',async()=>{const listener=await listenBroker(broker);try{const p=await prepare();const fetch=socketFetch(config.socketPath),headers={'Content-Type':'application/json','x-collective-owner':'alice','x-collective-team-grant':p.grant.grantId};const start=await fetch(`${LOCAL_ORIGIN}/team/start-candidate`,{method:'POST',headers,body:JSON.stringify(p.scope)});expect(start.status).toBe(200);const scoped={...headers,'x-collective-team-bot':'bot','x-collective-team-mode':'member','x-collective-team-context':'context','x-collective-team-run':'app-run'};expect((await fetch(`${LOCAL_ORIGIN}/p/${p.binding.bindingId}/v1/capabilities`,{headers:scoped})).status).toBe(200);expect((await fetch(`${LOCAL_ORIGIN}/p/${p.binding.bindingId}/v1/capabilities`,{headers:{...scoped,'x-collective-team-context':'another'}})).status).toBe(409);expect((await fetch(`${LOCAL_ORIGIN}/p/${p.binding.bindingId}/v1/capabilities`,{headers:{...scoped,origin:'https://browser.invalid'}})).status).toBe(403);}finally{await listener.close();}});
});
