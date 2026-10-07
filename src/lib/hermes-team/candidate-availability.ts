import { and,eq,inArray,isNull } from 'drizzle-orm';
import { db,type DbOrTx } from '@/db';
import { agentRuns,bots,conversations,hermesTeamCandidateContexts,hermesTeamCandidateRequests,hermesTeamChats,hermesTeamProfiles } from '@/db/schema';
import type { Principal } from '@/lib/auth/groups';
import { dockerControl,dockerFetch } from '@/lib/docker-hermes/client';
import { LOCAL_ORIGIN } from '@/lib/local-hermes/client';
import { lockUserRuns } from '@/lib/runs/lock';
import { HttpError } from '@/lib/authz';
import { HERMES_COMMIT } from '@/local-hermes/config';
import { authorizeTeam } from './store';
import type { TeamModelPolicyMode } from './model-policy';
import { TEAM_MODEL_PURPOSES,VERIFIED_TEAM_MODEL_ROUTES,evaluateTeamModelAccess,type VerifiedTeamModelRoute } from './model-policy';
import { candidateWireMetadata } from './candidate-wire-metadata';
import { loadTeamPersonalAccess } from './personal-access';
import { CANDIDATE_MODEL_ADAPTERS } from './candidate-model-transport';
import type { TeamMode } from './types';
export type TeamNativeAvailability={available:false;reason:string;choice:'default'|'personal';needsAttention?:true}|{available:true;reason:string;choice:'default'|'personal';model:string;route:VerifiedTeamModelRoute;personalBindingHash?:string};

/** Readiness is exact server policy proof, not a successful login or a browser-selected provider. */
export async function teamNativeAvailability(p:Principal,botId:string,mode:TeamMode,options:{conversationId?:string;routes?:readonly VerifiedTeamModelRoute[];q?:DbOrTx;preparedProfile?:typeof hermesTeamProfiles.$inferSelect}={}):Promise<TeamNativeAvailability>{
 const q=options.q??db,auth=await authorizeTeam(p,botId,mode,q);let choice:'default'|'personal'='default';
 const [stored]=await q.select().from(hermesTeamProfiles).where(and(eq(hermesTeamProfiles.botId,botId),eq(hermesTeamProfiles.mode,mode),mode==='member'?eq(hermesTeamProfiles.userId,p.user.id):isNull(hermesTeamProfiles.userId)));
 const profile=options.preparedProfile??stored;
 if(options.preparedProfile && (!stored || stored.id!==profile?.id))throw new HttpError(403,'Invalid native readiness profile.');
 if(options.conversationId){const [row]=await q.select({chat:hermesTeamChats,conversation:conversations}).from(hermesTeamChats).innerJoin(conversations,eq(conversations.id,hermesTeamChats.conversationId)).where(eq(hermesTeamChats.conversationId,options.conversationId));
  if(!row || row.conversation.userId!==p.user.id || row.conversation.botId!==botId || row.chat.profileId!==profile?.id || row.chat.mode!==mode)throw new HttpError(404,'Team conversation not found.');choice=row.chat.modelChoice;}
 const unavailable=(reason:string):Extract<TeamNativeAvailability,{available:false}>=>({available:false,reason,choice});
 const routes=options.routes??VERIFIED_TEAM_MODEL_ROUTES;
 if(process.env.HERMES_TEAM_CANDIDATE_RUNTIME_ENABLED!=='1' || !routes.length)return unavailable('Team model access is unavailable in this build. An administrator must verify a supported native model route.');
 if(!profile?.binding || ['updating','needs_attention','revoked'].includes(profile.state))return unavailable('Prepare or reconcile this private Team instance before model work.');
 const retained=await q.select().from(hermesTeamCandidateContexts).where(eq(hermesTeamCandidateContexts.profileId,profile.id));
 for(const context of retained){
  const requests=await q.select({state:hermesTeamCandidateRequests.state}).from(hermesTeamCandidateRequests).where(and(eq(hermesTeamCandidateRequests.contextId,context.id),inArray(hermesTeamCandidateRequests.state,['reserved','running','needs_attention'])));
  const [run]=requests.length || context.workerHolder?await q.select({status:agentRuns.status,cancelRequestedAt:agentRuns.cancelRequestedAt}).from(agentRuns).where(eq(agentRuns.id,context.runId)):[];
  const inactive=context.revokedAt || context.expiresAt.getTime()<=Date.now() || !run || run.cancelRequestedAt || !['queued','running','waiting','waiting_tasks'].includes(run.status);
  if((requests.length && inactive) || requests.some(row=>row.state==='needs_attention') || (context.workerHolder && (inactive || context.retirementState==='needs_attention') && (context.retirementState!=='confirmed' || !context.nativeStoppedAt)))return {...unavailable('Reconcile the retained native request or confirm writer shutdown before starting more work.'),needsAttention:true};
  if(requests.length)return unavailable('Finish or reconcile the current native request before starting more work.');
 }
 const personalRoute=routes.find(route=>route.id===auth.definition.modelPolicy.personalRouteId);
 const authority={userId:p.user.id,botId,userEnabled:!auth.principal.user.disabled,botEnabled:auth.bot.enabled&&auth.definition.enabled,audienceAllowed:true,
  policyVersion:auth.definition.version,hermesRevision:HERMES_COMMIT,policy:auth.definition.modelPolicy,
  personalConnection:personalRoute?await loadTeamPersonalAccess(auth.principal,personalRoute.integration,q):null};
 let selected:VerifiedTeamModelRoute|undefined;
 for(const purpose of TEAM_MODEL_PURPOSES){const result=evaluateTeamModelAccess({userId:p.user.id,botId,runId:'native-readiness',purpose,choice},authority,routes);
  if(result.status!=='ready')return unavailable(result.message);const route=routes.find(route=>route.id===result.attribution.routeId)!;
  if(selected && selected.id!==route.id)return unavailable('Native model purposes must use one verified policy route.');selected=route;}
 if(!selected || !(selected.adapterId in CANDIDATE_MODEL_ADAPTERS) || selected.integration==='hermes_native_codex')return unavailable('This personal/native transport does not have a supported bounded adapter.');
 if(auth.definition.modelPolicy.requireHardLimits && selected.limitContract==='local_only')return unavailable('The selected personal route cannot enforce the required hard token or cost ceiling.');
 try{const transport=await candidateWireMetadata(auth.principal,selected,q);if(!selected.transportHash || selected.transportHash!==transport.hash)return unavailable('The current server model transport has not been verified.');
  const grant=await dockerControl<{grantId:string}>(p.user.id,'/team/authorize',{teamBotId:botId,mode,modelPolicy:auth.definition.modelPolicy.mode});
  if(typeof grant.grantId!=='string')return unavailable('The native runtime did not provide a current actor grant.');
  const capabilities=await dockerFetch(p.user.id)(`${LOCAL_ORIGIN}/team/runtime-capabilities`,{method:'POST',headers:{'Content-Type':'application/json','x-collective-team-grant':grant.grantId},body:JSON.stringify({teamBotId:botId,mode}),signal:AbortSignal.timeout(5000)});
  if(!capabilities.ok)return unavailable('The native runtime capability needs operator verification.');
  const capability=await capabilities.json() as {available?:boolean;network?:string};
  if(capability.available!==true || !['internet','proxy'].includes(capability.network??''))return unavailable('This native runtime is disabled or its network policy cannot reach the server gateway.');
  const final=await authorizeTeam(p,botId,mode,q);if(final.definition.version!==auth.definition.version)return unavailable('The Team model policy changed during verification.');
  const freshTransport=await candidateWireMetadata(final.principal,selected,q);if(freshTransport.hash!==transport.hash || freshTransport.personalBindingHash!==transport.personalBindingHash)return unavailable('The model connection changed during verification.');
  return {available:true,reason:'Verified native model policy is available.',choice,model:selected.model,route:selected,personalBindingHash:transport.personalBindingHash};
 }catch{return unavailable('The model connection or its account-specific catalog needs verification.');}
}

/** Internal owner-only setting; changing modes never carries this private choice into another conversation. */
export async function setTeamConversationModelChoice(p:Principal,conversationId:string,choice:'default'|'personal',expected:{expectedChoice:'default'|'personal';expectedDefinitionVersion:number}){
 if(!expected || !['default','personal'].includes(expected.expectedChoice) || !Number.isSafeInteger(expected.expectedDefinitionVersion) || expected.expectedDefinitionVersion<1)throw new HttpError(400,'Expected model choice and policy version are required.');
 if(!['default','personal'].includes(choice))throw new HttpError(400,'Invalid Team model choice.');
 const [chat]=await db.select({chat:hermesTeamChats,conversation:conversations}).from(hermesTeamChats).innerJoin(conversations,eq(conversations.id,hermesTeamChats.conversationId)).where(eq(hermesTeamChats.conversationId,conversationId));
 if(!chat || chat.conversation.userId!==p.user.id || !chat.conversation.botId)throw new HttpError(404,'Team conversation not found.');
 return db.transaction(async tx=>{
  await tx.select({id:bots.id}).from(bots).where(eq(bots.id,chat.conversation.botId!)).for('update');
  const auth=await authorizeTeam(p,chat.conversation.botId!,chat.chat.mode,tx);
  const [current]=await tx.select({chat:hermesTeamChats,conversation:conversations}).from(hermesTeamChats).innerJoin(conversations,eq(conversations.id,hermesTeamChats.conversationId)).where(eq(hermesTeamChats.conversationId,conversationId));
  if(!current || current.conversation.userId!==p.user.id || current.chat.profileId!==chat.chat.profileId)throw new HttpError(404,'Team conversation changed.');
  if(current.chat.modelChoice!==expected.expectedChoice || auth.definition.version!==expected.expectedDefinitionVersion)throw new HttpError(409,'The model choice or Team policy changed. Reload before saving.');
  if(choice==='personal' && auth.definition.modelPolicy.mode==='admin_provided')throw new HttpError(403,'This Team bot does not allow personal model access.');
  await lockUserRuns(tx,p.user.id);
  const active=await tx.select({id:agentRuns.id}).from(agentRuns).innerJoin(hermesTeamChats,eq(hermesTeamChats.conversationId,agentRuns.conversationId)).where(and(eq(hermesTeamChats.profileId,chat.chat.profileId),inArray(agentRuns.status,['queued','running','waiting','waiting_tasks'])));
  if(active.length)throw new HttpError(409,'Finish active work before changing the model connection.');
  await tx.update(hermesTeamChats).set({modelChoice:choice}).where(eq(hermesTeamChats.conversationId,conversationId));return {modelChoice:choice};
 });
}

export type TeamConversationModelView={modelChoice:'default'|'personal';definitionVersion:number;modelPolicyMode:TeamModelPolicyMode;personalAllowed:boolean;personalRequired:boolean;modelAccessAvailable:boolean;modelAccessReason:string;personalConnection:{state:'unavailable'|'connected'|'connection_needed';message:string};connectAvailable:false;connectReason:string};
/** Owner-only view. Provider identity, catalog, account IDs and token metadata never become browser fields. */
export async function teamConversationModelView(p:Principal,conversationId:string,routes:readonly VerifiedTeamModelRoute[]=VERIFIED_TEAM_MODEL_ROUTES):Promise<TeamConversationModelView>{
 const {authorizeTeamConversation}=await import('./conversations');const current=await authorizeTeamConversation(p,conversationId);
 const availability=await teamNativeAvailability(p,current.profile.botId,current.chat.mode,{conversationId,routes});
 const route=routes.find(route=>route.id===current.definition.modelPolicy.personalRouteId);
 const personalAllowed=current.definition.modelPolicy.mode!=='admin_provided',personalRequired=current.definition.modelPolicy.mode==='personal_required';
 let state:TeamConversationModelView['personalConnection']['state']='unavailable';
 if(personalAllowed && route?.integration==='openai_chatgpt_plan_usage'){
  try{await candidateWireMetadata(current.principal,route);state='connected';}catch{state='connection_needed';}
 }
 const final=await authorizeTeamConversation(p,conversationId);
 if(final.chat.modelChoice!==current.chat.modelChoice || availability.choice!==current.chat.modelChoice || final.definition.version!==current.definition.version || final.profile.id!==current.profile.id || final.profile.installedRevision!==current.profile.installedRevision)throw new HttpError(409,'The private model choice or Team policy changed. Reload this connection view.');
 return {modelChoice:current.chat.modelChoice,definitionVersion:current.definition.version,modelPolicyMode:current.definition.modelPolicy.mode,personalAllowed,personalRequired,
  modelAccessAvailable:availability.available,modelAccessReason:availability.reason,personalConnection:{state,message:state==='connected'?'This private account has current verified model metadata.':state==='connection_needed'?'This private account needs a verified model connection.':'Personal model connection is unavailable in this build.'},
  connectAvailable:false,connectReason:'Official ChatGPT connection setup requires the supported authorization flow to be verified and enabled by an administrator.'};
}
