import { and,eq,isNull } from 'drizzle-orm';
import { db } from '@/db';
import { hermesTeamCandidateContexts,hermesTeamProfiles } from '@/db/schema';
import { HttpError } from '@/lib/authz';
import type { Principal } from '@/lib/auth/groups';
import { dockerControl,dockerFetch } from '@/lib/docker-hermes/client';
import { LOCAL_ORIGIN } from '@/lib/local-hermes/client';
import { candidateObjectHash,candidateRun,issueTeamCandidateContext,validateCandidateContext } from './candidate-context';
import { TEAM_MODEL_PURPOSES,VERIFIED_TEAM_MODEL_ROUTES,type VerifiedTeamModelRoute } from './model-policy';
import type { HermesTarget } from '@/lib/llm/providers/hermes/client';
import { claimTeamNativeLearning,finishTeamNativeLearning,scheduleTeamNativeLearning } from './candidate-learning';
import type { NativeTeamLearningSnapshot } from './learning-types';

/** Concrete trusted startup caller. Browser responses never contain native bearer grants or profile identities. */
async function prepareCandidate(p:Principal,botId:string,runId:string,choice:'default'|'personal',routes:readonly VerifiedTeamModelRoute[],worker?:{holder:string;segment:number},learningSnapshot?:NativeTeamLearningSnapshot){
  const before=await candidateRun(p,runId);
  if(before.bot.id!==botId)throw new HttpError(404,'Team run not found.');
  const url=process.env.HERMES_TEAM_GATEWAY_ORIGIN;
  if(!url)throw new HttpError(409,'The server native model gateway is not configured.');
  const origin=new URL(url);
  if(origin.protocol!=='https:' || origin.username || origin.password || origin.pathname!=='/' || origin.search || origin.hash)throw new HttpError(409,'The native gateway requires a fixed HTTPS origin.');
  const issued=await issueTeamCandidateContext(p,runId,choice,routes,worker);
  try{
    const readIssued=async()=>{const [stored]=await db.select().from(hermesTeamCandidateContexts).where(eq(hermesTeamCandidateContexts.id,issued.contextId));if(!stored)throw new HttpError(403,'The prepared native context disappeared.');return validateCandidateContext(stored,routes,db,issued.runPurpose==='learning'?'learning':'reply');};
    const admitted=await readIssued();
    const current=admitted.run;
    if(current.bot.id!==botId)throw new HttpError(403,'The issued native context changed bots.');
    const grant=await dockerControl<{grantId:string}>(p.user.id,'/team/authorize',{teamBotId:botId,mode:current.chat.mode,modelPolicy:current.definition.modelPolicy.mode});
    const validatePrepared=async()=>{await readIssued();};
    await validatePrepared();
    const ensured=await dockerFetch(p.user.id)(`${LOCAL_ORIGIN}/team/ensure`,{method:'POST',headers:{'Content-Type':'application/json','x-collective-team-grant':grant.grantId},body:JSON.stringify({teamBotId:botId,mode:current.chat.mode,name:current.bot.name.slice(0,80)}),signal:AbortSignal.timeout(45000)});
    if(!ensured.ok || candidateObjectHash(await ensured.json())!==admitted.context.bindingHash)throw new HttpError(409,'Native restart must retain this exact Team binding.');
    await validatePrepared();
    const base=`${origin.origin}/api/hermes-team/native/${issued.contextId}`;
    const binding=current.profile.binding as {bindingId?:string};
    const body={teamBotId:botId,mode:current.chat.mode,bindingId:binding.bindingId,runId,contextId:issued.contextId,expiresAt:issued.expiresAt,
      model:issued.model,adapterId:issued.adapterId,modelBaseUrls:Object.fromEntries(TEAM_MODEL_PURPOSES.map(purpose=>[purpose,`${base}/model/${purpose}`])),
      modelTokens:issued.modelTokens,toolUrl:`${base}/mcp`,toolToken:issued.toolToken,runPurpose:issued.runPurpose,
      ...(issued.learningToken?{learningUrl:`${base}/learning`,learningToken:issued.learningToken}:{}),...(learningSnapshot?{learningSnapshot}:{})};
    const response=await dockerFetch(p.user.id)(`${LOCAL_ORIGIN}/team/prepare-candidate`,{method:'POST',headers:{'Content-Type':'application/json','x-collective-team-grant':grant.grantId},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw new HttpError(409,'The native broker could not prepare this candidate adapter.');
    // Repeat permission checks after IPC. The native chat gate remains closed even for a prepared candidate.
    await validatePrepared();
    return {issued,current,grant,bindingId:binding.bindingId!};
  }catch(error){
    await db.update(hermesTeamCandidateContexts).set({revokedAt:new Date()}).where(eq(hermesTeamCandidateContexts.id,issued.contextId));
    // The broker can prove no-start through a durable tombstone, or confirm an actual writer stop.
    // An unavailable/older broker keeps attention; a failed setup never invents shutdown evidence.
    await retireStoredTeamCandidateRun(runId).catch(()=>{});
    throw error;
  }
}

/** Browser-facing preparation never returns native tokens, profile IDs or a usable model connection. */
export async function prepareTeamCandidateRun(p:Principal,botId:string,runId:string,choice:'default'|'personal',routes:readonly VerifiedTeamModelRoute[]=VERIFIED_TEAM_MODEL_ROUTES){
  await prepareCandidate(p,botId,runId,choice,routes);return {prepared:true,modelAccessAvailable:false};
}

export type ActiveTeamCandidateRun={contextId:string;model:string;target:HermesTarget;learningSnapshot?:NativeTeamLearningSnapshot;
  authorize():Promise<void>;retire():Promise<{confirmed:boolean;runtimeWide:true}>};

/** Worker-only active caller. Empty catalogs and the disabled server flag stop before native/provider work. */
export async function startTeamCandidateRun(p:Principal,botId:string,runId:string,worker:{holder:string;segment:number;choice?:'default'|'personal';routes?:readonly VerifiedTeamModelRoute[]}):Promise<ActiveTeamCandidateRun>{
  const routes=worker.routes??VERIFIED_TEAM_MODEL_ROUTES;
  if(process.env.HERMES_TEAM_CANDIDATE_RUNTIME_ENABLED!=='1' || !routes.length)throw new HttpError(409,'Native Team startup still requires verified routes and explicit runtime enablement.');
  const current=await candidateRun(p,runId);
  if(current.run.status!=='running' || current.run.holder!==worker.holder || current.run.segment!==worker.segment)throw new HttpError(409,'The native worker lease changed.');
  const learning=await claimTeamNativeLearning(runId,worker.holder,worker.segment,routes);
  let prepared:Awaited<ReturnType<typeof prepareCandidate>>;
  try{prepared=await prepareCandidate(p,botId,runId,learning?.choice??current.chat.modelChoice,routes,worker,learning?.snapshot);}
  catch(error){if(learning)await finishTeamNativeLearning(runId,false);throw error;}
  const identity={teamBotId:botId,mode:prepared.current.chat.mode,bindingId:prepared.bindingId,runId,contextId:prepared.issued.contextId};
  const checked=async()=>{
    const [stored]=await db.select().from(hermesTeamCandidateContexts).where(eq(hermesTeamCandidateContexts.id,prepared.issued.contextId));
    if(!stored)throw new HttpError(403,'The native Team context is unavailable.');
    const result=await validateCandidateContext(stored,routes,db,prepared.issued.runPurpose==='learning'?'learning':'reply');
    if(result.run.run.status!=='running' || result.run.run.holder!==worker.holder || result.run.run.segment!==worker.segment)throw new HttpError(403,'The native worker lease changed.');
    return result;
  };
  const retire=async():Promise<{confirmed:boolean;runtimeWide:true}>=>{
    const [stored]=await db.select().from(hermesTeamCandidateContexts).where(eq(hermesTeamCandidateContexts.id,identity.contextId));
    if(stored?.retirementState==='confirmed' && stored.nativeStoppedAt)return {confirmed:true,runtimeWide:true};
    // Closing all provider tokens precedes broker I/O, including cleanup after the app run became terminal.
    await db.update(hermesTeamCandidateContexts).set({revokedAt:new Date(),retirementState:'pending'}).where(and(eq(hermesTeamCandidateContexts.id,identity.contextId),isNull(hermesTeamCandidateContexts.nativeStoppedAt)));
    try{
      const stopped=await dockerControl<{confirmed:boolean;runtimeWide:true}>(p.user.id,'/team/retire-candidate',identity,45000);
      if(stopped.confirmed!==true || stopped.runtimeWide!==true)throw new HttpError(409,'Native writer shutdown was not confirmed.');
      await db.update(hermesTeamCandidateContexts).set({retirementState:'confirmed',nativeStoppedAt:new Date()}).where(eq(hermesTeamCandidateContexts.id,identity.contextId));
      // App terminal settlement completes/schedules learning through settleTeamCandidateRun.
      return {confirmed:true,runtimeWide:true};
    }catch{
      const [settled]=await db.select().from(hermesTeamCandidateContexts).where(eq(hermesTeamCandidateContexts.id,identity.contextId));
      if(settled?.retirementState==='confirmed' && settled.nativeStoppedAt)return {confirmed:true,runtimeWide:true};
      await db.update(hermesTeamCandidateContexts).set({retirementState:'needs_attention'}).where(and(eq(hermesTeamCandidateContexts.id,identity.contextId),isNull(hermesTeamCandidateContexts.nativeStoppedAt)));
      if(learning)await finishTeamNativeLearning(runId,false);
      return {confirmed:false,runtimeWide:true};
    }
  };
  const target:HermesTarget={baseUrl:LOCAL_ORIGIN,profile:prepared.bindingId,apiKey:'server-team-context',local:true,fetch:async(input,init={})=>{
    const url=new URL(String(input));
    if(url.origin!==LOCAL_ORIGIN || !url.pathname.startsWith(`/p/${prepared.bindingId}/v1/`))throw new HttpError(403,'Invalid native Team request target.');
    const fresh=await checked();
    const grant=await dockerControl<{grantId:string}>(fresh.context.actorId,'/team/authorize',{teamBotId:botId,mode:fresh.context.mode,modelPolicy:fresh.run.definition.modelPolicy.mode});
    await checked();
    const headers=new Headers(init.headers);headers.set('x-collective-team-grant',grant.grantId);headers.set('x-collective-team-context',identity.contextId);headers.set('x-collective-team-run',runId);headers.set('x-collective-team-bot',botId);headers.set('x-collective-team-mode',fresh.context.mode);
    const abort=new AbortController();
    const signal=init.signal?AbortSignal.any([init.signal,abort.signal]):abort.signal;
    let renewing=false,closed=false;let abortBody:(()=>void)|undefined;
    const timer=setInterval(()=>{if(renewing || closed)return;renewing=true;void (async()=>{
      try{
        const live=await checked();
        const renewed=await dockerControl<{grantId:string}>(live.context.actorId,'/team/authorize',{teamBotId:botId,mode:live.context.mode,modelPolicy:live.run.definition.modelPolicy.mode});
        await checked();
        const response=await dockerFetch(live.context.actorId)(`${LOCAL_ORIGIN}/team/renew-candidate`,{method:'POST',headers:{'Content-Type':'application/json','x-collective-team-grant':renewed.grantId},body:JSON.stringify(identity),signal:AbortSignal.timeout(5000)});
        if(!response.ok)throw new HttpError(403,'Native runtime renewal was refused.');
        await checked();
      }catch{abort.abort(new HttpError(403,'The native runtime grant changed.'));await retire();}
      finally{renewing=false;}
    })();},15000);
    const stop=()=>{closed=true;clearInterval(timer);if(abortBody)signal.removeEventListener('abort',abortBody);};
    try{
      const response=await dockerFetch(fresh.context.actorId)(input,{...init,headers,signal});
      await checked();
      if(!response.body){stop();return response;}
      const reader=response.body.getReader();
      abortBody=()=>{void reader.cancel(signal.reason).catch(()=>{});};signal.addEventListener('abort',abortBody,{once:true});
      const body=new ReadableStream<Uint8Array>({
        async pull(controller){try{if(signal.aborted)throw signal.reason;const item=await reader.read();if(signal.aborted)throw signal.reason;if(item.done){stop();controller.close();}else controller.enqueue(item.value);}catch(error){stop();void reader.cancel().catch(()=>{});controller.error(error);}},
        async cancel(reason){stop();abort.abort(reason);await reader.cancel(reason);},
      });
      return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
    }catch(error){stop();throw error;}
  }};
  try{
    await checked();
    const response=await dockerFetch(p.user.id)(`${LOCAL_ORIGIN}/team/start-candidate`,{method:'POST',headers:{'Content-Type':'application/json','x-collective-team-grant':prepared.grant.grantId},
      body:JSON.stringify({...identity,conversationId:prepared.current.run.conversationId}),signal:AbortSignal.timeout(45000)});
    if(!response.ok)throw new HttpError(409,'The native Team runtime refused startup.');
    const started=await response.json() as {started?:boolean};
    if(started.started!==true)throw new HttpError(409,'The native Team runtime did not confirm startup.');
    await checked();
    return {contextId:identity.contextId,model:prepared.issued.model,target,learningSnapshot:learning?.snapshot,authorize:async()=>{await checked();},retire};
  }catch(error){await retire();throw error;}
}

/** Restart cleanup derives retained scopes from the DB; it never creates a new grant or revives model access. */
export async function retireStoredTeamCandidateRun(runId:string){
  const [context]=await db.select().from(hermesTeamCandidateContexts).where(eq(hermesTeamCandidateContexts.runId,runId));
  if(!context)return {confirmed:true,runtimeWide:true as const};
  if(context.retirementState==='confirmed' && context.nativeStoppedAt)return {confirmed:true,runtimeWide:true as const};
  // Cleanup is actor-retained and deliberately independent of current audience permission.
  const [profile]=await db.select().from(hermesTeamProfiles).where(eq(hermesTeamProfiles.id,context.profileId));
  const bindingId=(profile?.binding as {bindingId?:string}|null)?.bindingId;
  if(!bindingId)throw new HttpError(409,'Retained native cleanup binding is missing.');
  await db.update(hermesTeamCandidateContexts).set({revokedAt:new Date(),retirementState:'pending'}).where(and(eq(hermesTeamCandidateContexts.id,context.id),isNull(hermesTeamCandidateContexts.nativeStoppedAt)));
  try{
    const result=await dockerControl<{confirmed:boolean;runtimeWide:true}>(context.actorId,'/team/retire-candidate',{teamBotId:context.botId,mode:context.mode,bindingId,runId,contextId:context.id},45000);
    if(result.confirmed!==true || result.runtimeWide!==true)throw new HttpError(409,'Native retirement needs attention.');
    await db.update(hermesTeamCandidateContexts).set({retirementState:'confirmed',nativeStoppedAt:new Date()}).where(eq(hermesTeamCandidateContexts.id,context.id));
    return result;
  }catch(error){await db.update(hermesTeamCandidateContexts).set({retirementState:'needs_attention'}).where(and(eq(hermesTeamCandidateContexts.id,context.id),isNull(hermesTeamCandidateContexts.nativeStoppedAt)));throw error;}
}

/** Called by the worker after its terminal transition; never creates a visible synthetic chat message. */
export async function settleTeamCandidateRun(runId:string,successful:boolean,routes:readonly VerifiedTeamModelRoute[]=VERIFIED_TEAM_MODEL_ROUTES){
  const [context]=await db.select().from(hermesTeamCandidateContexts).where(eq(hermesTeamCandidateContexts.runId,runId));
  if(!context){await finishTeamNativeLearning(runId,false);return;}
  if(context.retirementState!=='confirmed' || !context.nativeStoppedAt){await finishTeamNativeLearning(runId,false);return;}
  await finishTeamNativeLearning(runId,successful);
  if(successful)await scheduleTeamNativeLearning(context.id,{routes}).catch(()=>{});
}
