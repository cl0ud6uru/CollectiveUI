import { randomUUID } from 'node:crypto';
import { and,eq,inArray,sql } from 'drizzle-orm';
import { db,type DbOrTx,type Tx } from '@/db';
import { agentRuns,bots,hermesTeamCandidateContexts,hermesTeamCandidateRequests,hermesTeamChats,hermesTeamLearningHandoffs,hermesTeamProfiles } from '@/db/schema';
import { encrypt,decrypt } from '@/lib/crypto';
import { loadPrincipal } from '@/lib/auth/groups';
import { HttpError } from '@/lib/authz';
import { enqueueRun } from '@/lib/jobs';
import { insertRunTx } from '@/lib/runs/state';
import { lockUserRuns } from '@/lib/runs/lock';
import { authorizeTeam } from './store';
import { candidateHash,candidateObjectHash,candidateRun,lockCandidateContext,sameCandidateHash,validateCandidateContext } from './candidate-context';
import { candidateWireMetadata } from './candidate-wire-metadata';
import { evaluateTeamModelAccess,VERIFIED_TEAM_MODEL_ROUTES,type VerifiedTeamModelRoute } from './model-policy';
import { NativeTeamLearningHandoffSchema,validateNativeTeamLearningSnapshot,TEAM_LEARNING_LIFETIME_MS,type NativeTeamLearningSnapshot } from './learning-types';
import { canonicalTeamToolInput } from './tool-policy';
import { readCandidateJson } from './native-request';
import { HERMES_COMMIT } from '@/local-hermes/config';

class NativeLearningAttentionError extends HttpError { constructor(message:string){super(409,message);} }
export type NativeLearningHandoff=typeof hermesTeamLearningHandoffs.$inferSelect;
const aad=(row:Pick<NativeLearningHandoff,'id'|'actorId'|'sourceContextId'>)=>`hermes_team_learning_handoffs.payload_enc|${row.id}|${row.actorId}|${row.sourceContextId}`;
async function lockHandoff(tx:Tx,row:NativeLearningHandoff){
  await tx.select({id:bots.id}).from(bots).where(eq(bots.id,row.botId)).for('update');
  await tx.select({id:hermesTeamProfiles.id}).from(hermesTeamProfiles).where(eq(hermesTeamProfiles.id,row.profileId)).for('update');
  await tx.select({id:hermesTeamLearningHandoffs.id}).from(hermesTeamLearningHandoffs).where(eq(hermesTeamLearningHandoffs.id,row.id)).for('update');
}

/** One immutable final snapshot, authenticated by a separate capability while the source worker is still open. */
export async function captureTeamNativeLearning(request:Request,contextId:string,raw:unknown,routes:readonly VerifiedTeamModelRoute[]=VERIFIED_TEAM_MODEL_ROUTES){
  const token=/^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization')??'')?.[1];
  if(!token)throw new HttpError(401,'A native learning handoff grant is required.');
  const payload=NativeTeamLearningHandoffSchema.parse(raw),snapshot=validateNativeTeamLearningSnapshot(payload.snapshot);
  const canonical=canonicalTeamToolInput(snapshot),snapshotHash=candidateHash(canonical);
  return db.transaction(async tx=>{
    const [source]=await tx.select().from(hermesTeamCandidateContexts).where(eq(hermesTeamCandidateContexts.id,contextId));
    if(!source || !source.learningTokenHash || !sameCandidateHash(source.learningTokenHash,candidateHash(token)))throw new HttpError(403,'Invalid native learning handoff.');
    await lockCandidateContext(tx,source);
    const [current]=await tx.select().from(hermesTeamCandidateContexts).where(eq(hermesTeamCandidateContexts.id,contextId));
    // OPEN-run and full model/binding checks apply here. No new captures after the source turn becomes terminal.
    const checked=await validateCandidateContext(current,routes,tx,'learning');
    if(checked.run.learning)throw new HttpError(403,'A learning child cannot schedule another review.');
    const [prior]=await tx.select().from(hermesTeamLearningHandoffs).where(eq(hermesTeamLearningHandoffs.sourceContextId,contextId));
    if(prior){
      if(prior.reviewId!==payload.reviewId || prior.snapshotHash!==snapshotHash || ['cancelled','needs_attention'].includes(prior.state))throw new HttpError(409,'The native final review was already captured.');
      return {receiptId:prior.id,captured:true};
    }
    const id=randomUUID();
    await tx.insert(hermesTeamLearningHandoffs).values({id,sourceContextId:contextId,reviewId:payload.reviewId,actorId:current.actorId,botId:current.botId,
      profileId:current.profileId,sessionVersion:current.sessionVersion,definitionVersion:current.definitionVersion,teamRevision:current.teamRevision,
      mode:current.mode,bindingHash:current.bindingHash,routeHash:candidateObjectHash(current.modelRoute),snapshotHash,snapshotBytes:Buffer.byteLength(canonical,'utf8'),
      payloadEnc:encrypt(canonical,aad({id,actorId:current.actorId,sourceContextId:contextId})),expiresAt:new Date(Date.now()+TEAM_LEARNING_LIFETIME_MS)});
    return {receiptId:id,captured:true};
  });
}

/** Recheck a retained assignment without reviving the old source model capability. */
async function learningAuthority(row:NativeLearningHandoff,routes:readonly VerifiedTeamModelRoute[],q:DbOrTx){
  if(row.expiresAt.getTime()<=Date.now() || !['pending','queued','running'].includes(row.state))throw new HttpError(403,'The native learning assignment expired or was closed.');
  const principal=await loadPrincipal(row.actorId,q);
  if(!principal || principal.user.sessionVersion!==row.sessionVersion)throw new HttpError(403,'The source session changed.');
  const auth=await authorizeTeam(principal,row.botId,row.mode,q);
  const [source]=await q.select().from(hermesTeamCandidateContexts).where(eq(hermesTeamCandidateContexts.id,row.sourceContextId));
  const [profile]=await q.select().from(hermesTeamProfiles).where(eq(hermesTeamProfiles.id,row.profileId));
  const [parent]=source?await q.select().from(agentRuns).where(eq(agentRuns.id,source.runId)):[];
  const [chat]=parent?await q.select().from(hermesTeamChats).where(eq(hermesTeamChats.conversationId,parent.conversationId)):[];
  if(!source || !profile || !parent || !chat || parent.userId!==row.actorId || parent.botId!==row.botId || parent.status!=='succeeded' || parent.cancelRequestedAt
    || chat.profileId!==row.profileId || chat.mode!==row.mode
    || profile.state!=='ready' || profile.botId!==row.botId || profile.mode!==row.mode || (row.mode==='member' && profile.userId!==row.actorId)
    || auth.definition.version!==row.definitionVersion || profile.installedRevision!==row.teamRevision || candidateObjectHash(profile.binding)!==row.bindingHash
    || source.actorId!==row.actorId || source.profileId!==row.profileId || source.sessionVersion!==row.sessionVersion
    || source.definitionVersion!==row.definitionVersion || source.teamRevision!==row.teamRevision || source.mode!==row.mode || source.bindingHash!==row.bindingHash
    || candidateObjectHash(source.modelRoute)!==row.routeHash)throw new HttpError(403,'The native source or profile no longer matches this review.');
  if(source.retirementState!=='confirmed' || !source.nativeStoppedAt || !source.revokedAt)throw new HttpError(409,'Confirm native writer shutdown before learning.');
  const route=routes.find(route=>candidateObjectHash(route)===row.routeHash);
  if(!route)throw new NativeLearningAttentionError('The source learning route is no longer verified.');
  let transport:Awaited<ReturnType<typeof candidateWireMetadata>>;
  try{transport=await candidateWireMetadata(auth.principal,route,q);}catch{throw new NativeLearningAttentionError('The source learning transport is unavailable.');}
  if(!route.transportHash || route.transportHash!==transport.hash || (route.billing==='personal' && (!source.personalBindingHash || source.personalBindingHash!==transport.personalBindingHash)))throw new NativeLearningAttentionError('The learning transport changed.');
  const {loadTeamPersonalAccess}=await import('./personal-access');
  const decision=evaluateTeamModelAccess({userId:row.actorId,botId:row.botId,runId:row.childRunId??`learning:${row.id}`,purpose:'learning',choice:route.billing==='personal'?'personal':'default'},
    {userId:row.actorId,botId:row.botId,userEnabled:!auth.principal.user.disabled,botEnabled:auth.bot.enabled&&auth.definition.enabled,audienceAllowed:true,
      policyVersion:auth.definition.version,hermesRevision:HERMES_COMMIT,policy:auth.definition.modelPolicy,
      personalConnection:route.billing==='personal'?await loadTeamPersonalAccess(auth.principal,route.integration,q):null},routes);
  if(decision.status!=='ready' || decision.attribution.routeId!==route.id)throw new HttpError(403,'The learning model policy changed.');
  const unresolved=await q.select({id:hermesTeamCandidateRequests.id}).from(hermesTeamCandidateRequests)
    .where(and(eq(hermesTeamCandidateRequests.contextId,source.id),inArray(hermesTeamCandidateRequests.state,['reserved','running','needs_attention'])));
  if(unresolved.length)throw new NativeLearningAttentionError('Reconcile source model/tool work before learning.');
  return {principal,source,parent,profile,route};
}

/** Parent completion + confirmed native shutdown are the admission boundary for the separate queue run. */
export async function scheduleTeamNativeLearning(contextId:string,dependencies:{routes?:readonly VerifiedTeamModelRoute[];enqueue?:typeof enqueueRun}={}){
  const routes=dependencies.routes??VERIFIED_TEAM_MODEL_ROUTES;
  const [receipt]=await db.select().from(hermesTeamLearningHandoffs).where(eq(hermesTeamLearningHandoffs.sourceContextId,contextId));
  if(!receipt || !['pending','queued'].includes(receipt.state))return null;
  const run=await db.transaction(async tx=>{
    await lockHandoff(tx,receipt);
    const [row]=await tx.select().from(hermesTeamLearningHandoffs).where(eq(hermesTeamLearningHandoffs.id,receipt.id));
    if(!row || !['pending','queued'].includes(row.state))return null;
    // Classify an already terminal child before TTL/route checks can hide uncertain execution as expiry.
    if(row.childRunId){const [child]=await tx.select().from(agentRuns).where(eq(agentRuns.id,row.childRunId));
      if(!child || child.cancelRequestedAt || ['succeeded','failed','cancelled','interrupted'].includes(child.status)){
        await tx.update(hermesTeamLearningHandoffs).set({state:child?.status==='cancelled' || child?.cancelRequestedAt?'cancelled':'needs_attention',updatedAt:new Date()}).where(eq(hermesTeamLearningHandoffs.id,row.id));return null;
      }
    }
    const [source]=await tx.select().from(hermesTeamCandidateContexts).where(eq(hermesTeamCandidateContexts.id,row.sourceContextId));
    const [parent]=source?await tx.select().from(agentRuns).where(eq(agentRuns.id,source.runId)):[];
    if(parent && ['queued','running','waiting','waiting_tasks'].includes(parent.status) && !parent.cancelRequestedAt && row.expiresAt.getTime()>Date.now())return null;
    const authority=await learningAuthority(row,routes,tx);
    await lockUserRuns(tx,row.actorId);
    if(row.childRunId){
      const [child]=await tx.select().from(agentRuns).where(eq(agentRuns.id,row.childRunId));
      if(child?.status==='queued' && !child.cancelRequestedAt)return child;
      if(!child || child.cancelRequestedAt || ['succeeded','failed','cancelled','interrupted'].includes(child.status))await tx.update(hermesTeamLearningHandoffs).set({state:child?.status==='cancelled' || child?.cancelRequestedAt?'cancelled':'needs_attention',updatedAt:new Date()}).where(eq(hermesTeamLearningHandoffs.id,row.id));
      return null; // A live worker may be between claimRun and the immutable learning claim.
    }
    const child=await insertRunTx(tx,{id:`team-learning-${row.id}`,userId:row.actorId,conversationId:authority.parent.conversationId,botId:row.botId,
      appId:authority.parent.appId,messageId:`team-learning-message-${row.id}`,parentMessageId:authority.parent.messageId,background:true,executionMode:'worker'});
    await tx.update(hermesTeamLearningHandoffs).set({childRunId:child.id,state:'queued',updatedAt:new Date()}).where(eq(hermesTeamLearningHandoffs.id,row.id));
    return child;
  });
  if(run)await (dependencies.enqueue??enqueueRun)(run);
  return run?.id??null;
}

/** Executing worker consumes the durable assignment once; a crash never silently repeats native learning. */
export async function claimTeamNativeLearning(runId:string,holder:string,segment:number,routes:readonly VerifiedTeamModelRoute[]=VERIFIED_TEAM_MODEL_ROUTES){
  const [receipt]=await db.select().from(hermesTeamLearningHandoffs).where(eq(hermesTeamLearningHandoffs.childRunId,runId));
  if(!receipt)return null;
  const claimed=await db.transaction(async tx=>{
    await lockHandoff(tx,receipt);
    const [row]=await tx.select().from(hermesTeamLearningHandoffs).where(eq(hermesTeamLearningHandoffs.id,receipt.id));
    if(!row || row.state!=='queued')throw new HttpError(409,'This native learning assignment was already started.');
    const authority=await learningAuthority(row,routes,tx);
    const current=await candidateRun(authority.principal,runId,tx);
    if(current.run.status!=='running' || current.run.holder!==holder || current.run.segment!==segment)throw new HttpError(409,'The learning worker lease changed.');
    let snapshot:NativeTeamLearningSnapshot;
    try{
      if(!row.payloadEnc.startsWith('v2.'))throw new Error('Actor-bound encryption required.');
      snapshot=validateNativeTeamLearningSnapshot(JSON.parse(decrypt(row.payloadEnc,aad(row))));
      if(candidateObjectHash(snapshot)!==row.snapshotHash)throw new Error('Captured review changed.');
    }catch{await tx.update(hermesTeamLearningHandoffs).set({state:'needs_attention',updatedAt:new Date()}).where(eq(hermesTeamLearningHandoffs.id,row.id));return {invalidSnapshot:true as const};}
    await tx.update(hermesTeamLearningHandoffs).set({state:'running',updatedAt:new Date()}).where(eq(hermesTeamLearningHandoffs.id,row.id));
    return {snapshot,choice:authority.route.billing==='personal'?'personal' as const:'default' as const,receiptId:row.id};
  });
  if('invalidSnapshot' in claimed)throw new HttpError(409,'The captured native review needs attention.');
  return claimed;
}

export async function finishTeamNativeLearning(runId:string,successful:boolean){
  const [run]=await db.select().from(agentRuns).where(eq(agentRuns.id,runId));
  if(successful && run && ['queued','running','waiting','waiting_tasks'].includes(run.status) && !run.cancelRequestedAt)return;
  await db.update(hermesTeamLearningHandoffs).set({state:successful && run?.status==='succeeded' && !run.cancelRequestedAt?sql`case when ${hermesTeamLearningHandoffs.state} = 'running' then 'complete' else 'needs_attention' end`:run?.status==='cancelled' || run?.cancelRequestedAt?'cancelled':'needs_attention',updatedAt:new Date()})
    .where(and(eq(hermesTeamLearningHandoffs.childRunId,runId),inArray(hermesTeamLearningHandoffs.state,['queued','running'])));
}

/** Queue loss is recoverable only before execution; no running/attention receipt is automatically repeated. */
export async function recoverTeamNativeLearning(dependencies:{routes?:readonly VerifiedTeamModelRoute[];enqueue?:typeof enqueueRun}={}){
  const rows=await db.select().from(hermesTeamLearningHandoffs).where(inArray(hermesTeamLearningHandoffs.state,['pending','queued']));
  let queued=0;
  for(const row of rows)try{if(await scheduleTeamNativeLearning(row.sourceContextId,dependencies))queued++;}
  catch(error){if(error instanceof NativeLearningAttentionError || (error instanceof HttpError && error.status===403))await db.update(hermesTeamLearningHandoffs).set({state:error instanceof NativeLearningAttentionError?'needs_attention':'cancelled',updatedAt:new Date()}).where(and(eq(hermesTeamLearningHandoffs.id,row.id),inArray(hermesTeamLearningHandoffs.state,['pending','queued'])));}
  return queued;
}

export async function nativeLearningHandoffHttp(request:Request,contextId:string,dependencies:{routes?:readonly VerifiedTeamModelRoute[]}={}){
  try{return Response.json(await captureTeamNativeLearning(request,contextId,await readCandidateJson(request),dependencies.routes));}
  catch(error){return Response.json({error:'The native learning snapshot could not be captured.'},{status:error instanceof HttpError?error.status:400});}
}

export type TeamNativeLearningInput=NativeTeamLearningSnapshot;
