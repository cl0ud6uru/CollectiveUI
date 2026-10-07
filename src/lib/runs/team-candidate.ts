import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { bots } from '@/db/schema';
import { HttpError } from '@/lib/authz';
import type { Principal } from '@/lib/auth/groups';
import { candidateRun } from '@/lib/hermes-team/candidate-context';
import { teamUsesNativeLearning } from '@/lib/hermes-team/learning';
import { startTeamCandidateRun,type ActiveTeamCandidateRun } from '@/lib/hermes-team/candidate-startup';
import { teamRuntimeApp } from '@/lib/agent/team-target';
import { RunEventWriter } from './events';
import { finalizeRunTx } from './state';
import { abortKindOf,RunAbort,type AgentRun } from './types';

/** Worker-only active route selection, rechecked independently of the earlier web admission. */
export async function prepareTeamWorkerTarget(p:Principal,run:AgentRun,holder:string){
  const [bot]=run.botId?await db.select().from(bots).where(eq(bots.id,run.botId)):[];
  if(!bot?.hermesTeam && !await teamUsesNativeLearning(run.conversationId))return null;
  if(!bot)throw new HttpError(403,'This retained Team bot is no longer available.');
  if(run.executionMode!=='worker' || run.segment!==0 || run.legacy)throw new HttpError(409,'This native Team run cannot resume an older or delegated turn.');
  const current=await candidateRun(p,run.id);
  const candidate=await startTeamCandidateRun(p,bot.id,run.id,{holder,segment:run.segment});
  // Historical appId is attribution metadata. Never open its credentials or company runtime configuration.
  const app=teamRuntimeApp(current.bot,candidate.model,run.appId??bot.id);
  return {bot:current.bot,app,candidate};
}

/** Child learning is native review, never another chat prompt or CollectiveUI memory extraction. */
export async function executeTeamLearningSegment(run:AgentRun,holder:string,candidate:ActiveTeamCandidateRun,ac:AbortController){
  if(!candidate.learningSnapshot)throw new HttpError(403,'This run has no native learning assignment.');
  const writer=new RunEventWriter({runId:run.id,segment:run.segment,holder,onLeaseLost:()=>ac.abort(new RunAbort('lease-lost')),onCancel:()=>ac.abort(new RunAbort('cancel'))});
  let error:string|null=null;
  try{
    ac.signal.throwIfAborted();await candidate.authorize();ac.signal.throwIfAborted();
    const root=`${candidate.target.baseUrl}/p/${candidate.target.profile}/v1`;
    const response=await candidate.target.fetch!(`${root}/learning`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:ac.signal});
    if(!response.ok)throw new Error('Native learning admission was refused');
    const admitted=await response.json() as {run_id?:unknown};
    if(typeof admitted.run_id!=='string' || !/^run_[a-z0-9]+$/.test(admitted.run_id))throw new Error('Invalid native learning receipt');
    for(;;){
      ac.signal.throwIfAborted();await candidate.authorize();
      const state=await candidate.target.fetch!(`${root}/runs/${admitted.run_id}`,{signal:ac.signal});
      if(!state.ok)throw new Error('Native learning state was unavailable');
      const result=await state.json() as {status?:unknown};
      if(result.status==='completed')break;
      if(result.status!=='running')throw new Error('Native learning did not complete');
      await new Promise<void>((resolve,reject)=>{const done=()=>{clearTimeout(timer);ac.signal.removeEventListener('abort',abort);};const abort=()=>{done();reject(ac.signal.reason);};const timer=setTimeout(()=>{done();resolve();},250);ac.signal.addEventListener('abort',abort,{once:true});if(ac.signal.aborted)abort();});
    }
  }catch{error='The native learning run did not confirm completion.';}
  finally{await writer.close();}
  const stopped=await candidate.retire();
  if(!stopped.confirmed)error='Native learning writer shutdown needs attention.';
  const abort=ac.signal.aborted?abortKindOf(ac.signal.reason):undefined;
  if(writer.leaseLost || abort==='lease-lost')return;
  const status=abort==='cancel'?'cancelled':abort?'interrupted':error?'failed':'succeeded';
  // No private review snapshot or synthetic assistant reply is added to the source conversation.
  await db.transaction(tx=>finalizeRunTx(tx,run.id,{status:['running'],holder},{status,error}));
}
