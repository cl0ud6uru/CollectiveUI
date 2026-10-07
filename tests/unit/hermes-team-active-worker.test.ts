import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {AgentRun,AiApp} from '@/db/schema';
import type {Principal} from '@/lib/auth/groups';
import type {ActiveTeamCandidateRun} from '@/lib/hermes-team/candidate-startup';
const h=vi.hoisted(()=>({rows:[] as unknown[],start:vi.fn(),authority:vi.fn(),finish:vi.fn(),sequence:[] as string[],tables:[] as unknown[],writerLost:false,retained:false}));
vi.mock('@/db',()=>({db:{select:()=>({from:(table:unknown)=>{h.tables.push(table);return {where:async()=>h.rows};}}),transaction:async(work:(tx:unknown)=>unknown)=>work({})}}));
vi.mock('@/lib/hermes-team/candidate-context',()=>({candidateRun:h.authority}));
vi.mock('@/lib/hermes-team/learning',()=>({teamUsesNativeLearning:async()=>h.retained}));
vi.mock('@/lib/hermes-team/candidate-startup',()=>({startTeamCandidateRun:h.start}));
vi.mock('@/lib/runs/events',()=>({RunEventWriter:class{get leaseLost(){return h.writerLost;}async close(){h.sequence.push('writer-closed');}}}));
vi.mock('@/lib/runs/state',()=>({finalizeRunTx:h.finish}));
import {prepareTeamWorkerTarget,executeTeamLearningSegment} from '@/lib/runs/team-candidate';
import {resolveModel} from '@/lib/llm/resolve';
import {bots} from '@/db/schema';
import {RunAbort,type RunHandle} from '@/lib/runs/types';
const run={id:'learning-run',userId:'alice',botId:'bot',appId:'historical-company-app',conversationId:'conversation',messageId:'learning-message',executionMode:'worker',segment:0,legacy:false} as AgentRun;
const principal={user:{id:'alice'}} as Principal;
const snapshot={version:1 as const,messagesSnapshot:[{role:'user',content:'Private learning fixture'}],reviewMemory:true,reviewSkills:true,focus:null,explicit:false,memoryEnabled:true,userProfileEnabled:true};
const target=()=>({baseUrl:'http://hermes.local',profile:'a'.repeat(32),apiKey:'opaque-fixture',local:true,fetch:vi.fn()});
function candidate():ActiveTeamCandidateRun{return {contextId:'context',model:'server-verified-model',target:target(),learningSnapshot:snapshot,
  authorize:vi.fn(async()=>{}),retire:vi.fn(async()=>{h.sequence.push('native-stopped');return {confirmed:true,runtimeWide:true as const};})};}
beforeEach(()=>{vi.clearAllMocks();h.rows=[{id:'bot',name:'Team',avatar:null,hermesTeam:true}];h.tables=[];h.sequence=[];h.writerLost=false;h.retained=false;
  h.authority.mockResolvedValue({bot:h.rows[0]});h.start.mockResolvedValue(candidate());h.finish.mockImplementation(async()=>{h.sequence.push('terminal-committed');return {...run,status:'succeeded'};});});

describe('worker-only active Team routing',()=>{
  it('preserves personal dispatch and rejects delegated/legacy/resumed Team startup',async()=>{
    h.rows=[{hermesTeam:false}];expect(await prepareTeamWorkerTarget(principal,run,'worker')).toBeNull();expect(h.start).not.toHaveBeenCalled();
    h.rows=[{hermesTeam:true}];for(const change of [{legacy:true},{segment:1},{executionMode:'async_delegate'}])await expect(prepareTeamWorkerTarget(principal,{...run,...change} as AgentRun,'worker')).rejects.toMatchObject({status:409});expect(h.start).not.toHaveBeenCalled();
  });
  it('uses durable actor authority and discards the historical company app configuration',async()=>{
    const setup=await prepareTeamWorkerTarget(principal,run,'worker');expect(h.tables).toEqual([bots]);
    expect(h.authority).toHaveBeenCalledWith(principal,run.id);expect(h.start).toHaveBeenCalledWith(principal,'bot',run.id,{holder:'worker',segment:0});
    expect(setup!.app).toMatchObject({id:'historical-company-app',provider:'hermes',model:'server-verified-model',providerConfig:{},apiKeyEnc:null,providerConnectionId:null,embeddingModel:null});
  });
  it('never falls back to a company app when a retained Team definition flag changes',async()=>{
    h.rows=[{id:'bot',name:'Team',hermesTeam:false}];h.retained=true;h.authority.mockRejectedValueOnce(new Error('Team definition disabled'));
    await expect(prepareTeamWorkerTarget(principal,run,'worker')).rejects.toThrow('disabled');expect(h.start).not.toHaveBeenCalled();
  });
  it('routes the admitted model directly to native IPC and never opens a company provider',async()=>{
    const value=candidate();delete value.learningSnapshot;const app={id:'historical-company-app',provider:'hermes',model:'untrusted-old-model'} as AiApp;
    const handle={id:run.id,segment:0,legacy:false,resumeState:null,saveResumeState:vi.fn(),teamCandidate:value} as RunHandle;
    const model=await resolveModel(app,{purpose:'chat',botId:'bot',conversationId:'conversation',run:handle});
    expect(model.model.provider).toBe('hermes');expect(model.model.modelId).toBe('server-verified-model');expect(h.tables).toEqual([]);
    await expect(resolveModel({...app,provider:'openai'},{purpose:'chat',botId:'bot',conversationId:'conversation',run:handle})).rejects.toThrow('cannot dispatch');
    await expect(resolveModel(app,{purpose:'memory',botId:'bot',conversationId:'conversation',run:handle})).rejects.toThrow('cannot dispatch');
  });
  it('runs dedicated native learning, stops writers before success and adds no parent reply/history',async()=>{
    const value=candidate(),wire=vi.mocked(value.target.fetch!);wire.mockResolvedValueOnce(Response.json({run_id:'run_fixture'})).mockResolvedValueOnce(Response.json({status:'completed',output:'Private review content'}));
    await executeTeamLearningSegment(run,'worker',value,new AbortController());
    expect(wire.mock.calls[0][0]).toBe(`http://hermes.local/p/${'a'.repeat(32)}/v1/learning`);expect(wire.mock.calls[0][1]?.body).toBe('{}');
    expect(JSON.stringify(wire.mock.calls)).not.toContain('Private learning fixture');
    expect(h.sequence).toEqual(['writer-closed','native-stopped','terminal-committed']);
    expect(h.finish).toHaveBeenCalledWith({},run.id,{status:['running'],holder:'worker'},{status:'succeeded',error:null});
  });
  it('refuses success when native stop cannot be proven and never retries the child',async()=>{
    const value=candidate();vi.mocked(value.target.fetch!).mockResolvedValueOnce(Response.json({run_id:'run_fixture'})).mockResolvedValueOnce(Response.json({status:'completed'}));vi.mocked(value.retire).mockResolvedValue({confirmed:false,runtimeWide:true});
    await executeTeamLearningSegment(run,'worker',value,new AbortController());
    expect(h.finish.mock.calls[0][3]).toMatchObject({status:'failed',error:'Native learning writer shutdown needs attention.'});expect(value.target.fetch).toHaveBeenCalledTimes(2);
  });
  it('cancels without dispatching a later provider and drops terminal writes after a lost lease',async()=>{
    const value=candidate(),ac=new AbortController();ac.abort(new RunAbort('cancel'));vi.mocked(value.target.fetch!).mockImplementation(async()=>{throw ac.signal.reason;});
    await executeTeamLearningSegment(run,'worker',value,ac);expect(h.finish.mock.calls[0][3]).toMatchObject({status:'cancelled'});expect(value.retire).toHaveBeenCalledOnce();
    expect(value.target.fetch).not.toHaveBeenCalled();
    h.finish.mockClear();h.writerLost=true;await executeTeamLearningSegment(run,'worker',candidate(),ac);expect(h.finish).not.toHaveBeenCalled();
  });
});
