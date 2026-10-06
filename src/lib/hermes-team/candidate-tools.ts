import { randomUUID } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { db, type DbOrTx } from '@/db';
import { hermesTeamCandidateApprovals, hermesTeamCandidateContexts, hermesTeamCandidateRequests, agentRuns, mcpServers } from '@/db/schema';
import { HttpError } from '@/lib/authz';
import type { Principal } from '@/lib/auth/groups';
import { connectMcp, redactMcpValue } from '@/lib/mcp/client';
import { mcpInputValidator } from '@/lib/mcp/input';
import { snapshotHash } from '@/lib/mcp/snapshot';
import { capResult, type McpCallResult } from '@/lib/mcp/hygiene';
import { HERMES_COMMIT } from '@/local-hermes/config';
import { getSetting } from '@/lib/settings';
import { modelToolName } from '@/lib/agent/tools/mcp';
import { candidateHash, candidateObjectHash, loadCandidateContext, lockCandidateContext, validateCandidateContext } from './candidate-context';
import { nativeRequestId, type CandidateResponse } from './candidate-model';
import { candidateResourceAdapterId } from './candidate-resource-adapter';
import { VERIFIED_TEAM_MODEL_ROUTES, type VerifiedTeamModelRoute } from './model-policy';
import { authorizeTeamTool, canonicalTeamToolInput, createTeamConnectorService, TeamToolPolicyError, VERIFIED_TEAM_TOOL_ADAPTERS,
  type TeamToolApproval, type TeamToolAuthority, type VerifiedTeamToolAdapter } from './tool-policy';

export const candidateToolName=(id:string)=>`team_${candidateHash(id).slice(0,32)}`;
type Dependencies={ routes?:readonly VerifiedTeamModelRoute[]; adapters?:readonly VerifiedTeamToolAdapter[]; connect?:typeof connectMcp };
type Scope={ contextId:string; authorization:string|null; routes:readonly VerifiedTeamModelRoute[]; adapters:readonly VerifiedTeamToolAdapter[] };

export async function assertCandidateMcpEnabled(q:DbOrTx=db) {
  if((await getSetting('tools',q)).disabledTools.includes('mcp'))throw new HttpError(403,'MCP tools are disabled.');
}

async function resolvedToolAuthority(current:Awaited<ReturnType<typeof loadCandidateContext>>,capabilityId:string,q:DbOrTx=db) {
  const capability=current.run.definition.toolPolicy.capabilities.find(c=>c.capabilityId===capabilityId);
  // No personal MCP connection schema exists today. Never turn this into a company connection.
  if(capability?.connectionMode==='member_connection')throw new HttpError(409,'Native member MCP connections are not supported by this build.');
  const [server]=capability?.connectionId ? await q.select().from(mcpServers).where(eq(mcpServers.id,capability.connectionId)) : [];
  const settings=await getSetting('tools',q);
  const disabled=settings.disabledTools.includes('mcp') || !!server && settings.disabledTools.includes(`mcp:${server.id}`);
  const enforcedNames=['mcp',...(capability?.action ? [capability.action,candidateToolName(capability.capabilityId)] : []),
    ...(server && capability?.action ? [`mcp:${server.id}`,modelToolName(server,capability.action,new Set())] : [])];
  // Ordinary MCP names append numeric suffixes after collisions, truncating the base
  // again to retain the 64-character limit. Honor any possible persisted alias;
  // a native capability must not escape an admin rule by using its hashed name.
  const legacyBase=server && capability?.action ? modelToolName(server,capability.action,new Set()) : null;
  const legacyEnforced=!!legacyBase && settings.enforcedApproval.some(name=>{
    const suffix=/_([0-9]+)$/.exec(name)?.[1];
    return !!suffix && Number.isSafeInteger(Number(suffix)) && Number(suffix)>=2
      && name===`${legacyBase.slice(0,64-suffix.length-1)}_${suffix}`;
  });
  const requireApproval=server?.toolPolicy[capability?.action??'']?.requireApproval===true || legacyEnforced || enforcedNames.some(name=>settings.enforcedApproval.includes(name));
  const policy={...current.run.definition.toolPolicy,capabilities:current.run.definition.toolPolicy.capabilities.map(c=>c.capabilityId===capabilityId ? {...c,requireApproval:c.requireApproval || requireApproval} : c)};
  const usable=!disabled && server?.status==='enabled' && server.trust==='trusted' && !server.toolsDrift && !!server.toolsSnapshot?.length
    && server.toolsHash===snapshotHash(server.toolsSnapshot);
  const authority:TeamToolAuthority={userId:current.context.actorId,botId:current.context.botId,userEnabled:true,botEnabled:true,audienceAllowed:true,
    policyVersion:current.run.definition.version,hermesRevision:HERMES_COMMIT,policy,
    connection:usable ? {id:server.id,version:server.policyRevision,mode:'approved_team_connection',status:'active',expiresAt:current.context.expiresAt.getTime(),approvedForBotId:current.context.botId}:null};
  const def=server?.toolsSnapshot?.find(t=>t.name===capability?.action);
  if(capability?.connectionMode!=='disabled' && (!def || capability?.adapterId!==candidateResourceAdapterId(def) || server?.toolPolicy[def.name]?.enabled===false))authority.connection=null;
  return {...current,capability,server,authority};
}

async function toolAuthority(scope:Scope,capabilityId:string,q:DbOrTx=db) {
  return resolvedToolAuthority(await loadCandidateContext(scope.contextId,scope.authorization,'tool',scope.routes,q),capabilityId,q);
}

export async function listCandidateTools(contextId:string,authorization:string|null,dependencies:Dependencies={}) {
  const scope:Scope={contextId,authorization,routes:dependencies.routes??VERIFIED_TEAM_MODEL_ROUTES,adapters:dependencies.adapters??VERIFIED_TEAM_TOOL_ADAPTERS};
  const current=await loadCandidateContext(contextId,authorization,'tool',scope.routes);
  const tools=[];
  for(const capability of current.run.definition.toolPolicy.capabilities){
    if(capability.connectionMode==='disabled')continue;
    const adapter=scope.adapters.find(a=>a.id===capability.adapterId && a.capabilityId===capability.capabilityId && a.action===capability.action && a.effect===capability.effect);
    const evidence=adapter?.evidence;
    if(!adapter || !evidence || evidence.hermesRevision!==HERMES_COMMIT || evidence.adapterId!==adapter.id || evidence.capabilityId!==adapter.capabilityId
      || evidence.action!==adapter.action || evidence.effect!==adapter.effect || evidence.verifiedAt>Date.now() || evidence.expiresAt<=Date.now())continue;
    const resolved=await toolAuthority(scope,capability.capabilityId);
    if(!resolved.authority.connection || resolved.server?.toolPolicy[capability.action!]?.enabled===false)continue;
    const tool=resolved.server?.toolsSnapshot?.find(t=>t.name===capability.action);
    if(tool)tools.push({...tool,name:candidateToolName(capability.capabilityId)});
  }
  return tools;
}

/** A pending approval is bound to the actor, exact input, connection version and native request UUID. */
export async function executeCandidateTool(request:Request,contextId:string,name:string,input:unknown,approvalId?:string,dependencies:Dependencies={}):Promise<CandidateResponse>{
  const scope:Scope={contextId,authorization:request.headers.get('authorization'),routes:dependencies.routes??VERIFIED_TEAM_MODEL_ROUTES,adapters:dependencies.adapters??VERIFIED_TEAM_TOOL_ADAPTERS};
  const requestId=nativeRequestId(request,{name,input});
  const current=await loadCandidateContext(contextId,scope.authorization,'tool',scope.routes);
  const capability=current.run.definition.toolPolicy.capabilities.find(c=>candidateToolName(c.capabilityId)===name);
  if(!capability)throw new HttpError(403,'Unknown native Team capability.');
  const toolRequest={botId:current.context.botId,runId:current.context.runId,capabilityId:capability.capabilityId,input,approvalId};
  const inputHash=candidateObjectHash({name,input});
  const json=(value:unknown):CandidateResponse=>({status:200,contentType:'application/json',body:JSON.stringify(value)});
  const loadApproval=async(id:string,q:DbOrTx=db):Promise<TeamToolApproval|null>=>{
    const [row]=await q.select().from(hermesTeamCandidateApprovals).where(and(eq(hermesTeamCandidateApprovals.id,id),eq(hermesTeamCandidateApprovals.contextId,contextId)));
    if(!row || row.requestId!==requestId)return null;
    return {...row.attribution,id:row.id,status:row.state==='consumed'?'approved':row.state,expiresAt:row.expiresAt.getTime()};
  };
  if(approvalId && !await loadApproval(approvalId))throw new HttpError(409,'The native approval does not match this request.');
  const service=createTeamConnectorService<CandidateResponse>({adapters:scope.adapters,now:Date.now,
    currentUserId:async()=>(await loadCandidateContext(contextId,scope.authorization,'tool',scope.routes)).context.actorId,
    loadAuthority:async()=> (await toolAuthority(scope,capability.capabilityId)).authority,
    loadApproval,
    dispatch:async(argumentsValue,attribution,approvedId)=>{
      const claimed=await db.transaction(async tx=>{
        await lockCandidateContext(tx,current.context);
        const resolved=await toolAuthority(scope,capability.capabilityId,tx);
        const fresh=authorizeTeamTool(current.context.actorId,toolRequest,resolved.authority,scope.adapters);
        if(canonicalTeamToolInput(fresh.attribution)!==canonicalTeamToolInput(attribution))throw new HttpError(409,'Native tool authority changed.');
        const [prior]=await tx.select().from(hermesTeamCandidateRequests).where(and(eq(hermesTeamCandidateRequests.contextId,contextId),eq(hermesTeamCandidateRequests.kind,'tool'),eq(hermesTeamCandidateRequests.requestId,requestId))).for('update');
        if(prior){if(prior.inputHash!==inputHash)throw new HttpError(409,'The native tool UUID changed content.');if(prior.state==='complete' && prior.response)return {response:prior.response,id:prior.id};throw new HttpError(409,'The native action is unresolved.');}
        const [approval]=approvedId ? await tx.select().from(hermesTeamCandidateApprovals).where(eq(hermesTeamCandidateApprovals.id,approvedId)).for('update') : [];
        if(attribution.requireApproval && (!approval || approval.contextId!==contextId || approval.requestId!==requestId || approval.state!=='approved'
          || approval.expiresAt.getTime()<=Date.now() || candidateObjectHash(approval.attribution)!==candidateObjectHash(attribution)))throw new HttpError(409,'The approval was consumed or changed.');
        if(approval)await tx.update(hermesTeamCandidateApprovals).set({state:'consumed',updatedAt:new Date()}).where(eq(hermesTeamCandidateApprovals.id,approval.id));
        const calls=await tx.select({id:hermesTeamCandidateRequests.id}).from(hermesTeamCandidateRequests).where(and(eq(hermesTeamCandidateRequests.contextId,contextId),eq(hermesTeamCandidateRequests.kind,'tool')));
        if(calls.length>=32)throw new HttpError(409,'This native run exhausted its tool allowance.');
        const id=randomUUID();await tx.insert(hermesTeamCandidateRequests).values({id,contextId,requestId,kind:'tool',inputHash,state:'running'});
        return {response:null,id};
      });
      if(claimed.response)return claimed.response;
      let client:Awaited<ReturnType<typeof connectMcp>>|undefined;
      const abort=new AbortController();let watch:ReturnType<typeof setTimeout>|undefined;let finished=false;
      const callerAbort=()=>abort.abort();request.signal.addEventListener('abort',callerAbort,{once:true});if(request.signal.aborted)abort.abort();
      const check=async()=>{if(finished)return;try{const fresh=await toolAuthority(scope,capability.capabilityId);const checked=authorizeTeamTool(current.context.actorId,toolRequest,fresh.authority,scope.adapters);
        if(candidateObjectHash(checked.attribution)!==candidateObjectHash(attribution))throw new HttpError(403,'Tool access changed.');
        if(!finished)watch=setTimeout(()=>void check(),250);}catch{abort.abort();}};
      try{
        // Connection setup itself can use team secrets, so authorize it again after the durable claim.
        const resolved=await toolAuthority(scope,capability.capabilityId);
        const beforeConnect=authorizeTeamTool(current.context.actorId,toolRequest,resolved.authority,scope.adapters);
        if(candidateObjectHash(beforeConnect.attribution)!==candidateObjectHash(attribution))throw new HttpError(403,'The connector permission changed before setup.');
        if(!resolved.server || resolved.server.toolPolicy[attribution.action]?.enabled===false)throw new HttpError(403,'The connector action was disabled.');
        const def=resolved.server.toolsSnapshot?.find(t=>t.name===attribution.action);if(!def)throw new HttpError(409,'The connector definition changed.');
        if(abort.signal.aborted)throw new HttpError(409,'The native requester cancelled.');
        mcpInputValidator(def.inputSchema,true)(argumentsValue);
        const p=resolved.principal;
        const authorize=async()=>{
          const fresh=await toolAuthority(scope,capability.capabilityId);const checked=authorizeTeamTool(current.context.actorId,toolRequest,fresh.authority,scope.adapters);
          if(candidateObjectHash(checked.attribution)!==candidateObjectHash(attribution))throw new HttpError(403,'Native connector permission changed.');
          const actor=fresh.principal;
          return {subject:{kind:'user' as const,id:actor.user.id,upn:actor.user.upn,email:actor.user.email,name:actor.user.name,groups:actor.groupIds},
            botId:attribution.botId,conversationId:fresh.run.run.conversationId,service:{id:`hermes-team:${attribution.botId}`,grant:contextId,revision:attribution.policyVersion,
              server:fresh.server!.id,tool:attribution.action,run:attribution.runId,call:requestId}};
        };
        client=await (dependencies.connect??connectMcp)(resolved.server,{subject:{kind:'user',id:p.user.id,upn:p.user.upn,email:p.user.email,name:p.user.name,groups:p.groupIds},authorize,
          botId:attribution.botId,conversationId:resolved.run.run.conversationId,service:{id:`hermes-team:${attribution.botId}`,grant:contextId,revision:attribution.policyVersion,
            server:resolved.server.id,tool:attribution.action,run:attribution.runId,call:requestId}});
        // Recheck the exact scope after initialize and immediately before tools/call.
        const checked=await toolAuthority(scope,capability.capabilityId);
        const fresh=authorizeTeamTool(p.user.id,toolRequest,checked.authority,scope.adapters);
        if(candidateObjectHash(fresh.attribution)!==candidateObjectHash(attribution))throw new HttpError(403,'The tool scope changed during connection setup.');
        watch=setTimeout(()=>void check(),250);
        const result=await client.callTool({name:attribution.action,arguments:argumentsValue as Record<string,unknown>,options:{signal:abort.signal,timeout:Math.min(45000,resolved.server.timeoutMs)}});
        const completed=await toolAuthority(scope,capability.capabilityId);
        if(candidateObjectHash(authorizeTeamTool(p.user.id,toolRequest,completed.authority,scope.adapters).attribution)!==candidateObjectHash(attribution))throw new HttpError(403,'The action authority changed.');
        const response=json(capResult(redactMcpValue(result as McpCallResult,resolved.server),Math.min(64000,resolved.server.resultBudgetKb*1024)));
        await db.update(hermesTeamCandidateRequests).set({state:'complete',response,updatedAt:new Date()}).where(eq(hermesTeamCandidateRequests.id,claimed.id));return response;
      }catch{
        await db.update(hermesTeamCandidateRequests).set({state:'needs_attention',updatedAt:new Date()}).where(eq(hermesTeamCandidateRequests.id,claimed.id));
        throw new HttpError(409,'The native connector action needs attention. It will not repeat automatically.');
      }finally{finished=true;clearTimeout(watch);request.signal.removeEventListener('abort',callerAbort);abort.abort();await client?.close().catch(()=>{});}
    },
  });
  try{return await service.execute(toolRequest);}
  catch(error){
    if(!(error instanceof TeamToolPolicyError) || error.reason!=='approval_needed')throw error;
    const pending=await db.transaction(async tx=>{
      await lockCandidateContext(tx,current.context);const resolved=await toolAuthority(scope,capability.capabilityId,tx);
      const checked=authorizeTeamTool(current.context.actorId,toolRequest,resolved.authority,scope.adapters);
      const [existing]=await tx.select().from(hermesTeamCandidateApprovals).where(and(eq(hermesTeamCandidateApprovals.contextId,contextId),eq(hermesTeamCandidateApprovals.requestId,requestId)));
      if(existing){if(existing.inputHash!==inputHash || candidateObjectHash(existing.attribution)!==candidateObjectHash(checked.attribution))throw new HttpError(409,'The pending action changed.');return existing;}
      const approvals=await tx.select({id:hermesTeamCandidateApprovals.id}).from(hermesTeamCandidateApprovals).where(eq(hermesTeamCandidateApprovals.contextId,contextId));
      if(approvals.length>=16)throw new HttpError(409,'This native run exhausted its approval allowance.');
      const [row]=await tx.insert(hermesTeamCandidateApprovals).values({contextId,inputHash,input:JSON.parse(canonicalTeamToolInput(input)),attribution:checked.attribution,requestId,expiresAt:current.context.expiresAt}).returning();return row;
    });
    return json({isError:true,content:[{type:'text',text:'This action requires the current person’s approval.'}],_meta:{collectiveApprovalId:pending.id}});
  }
}

/** Reuses the exact actor/profile/revision/route validation without recovering native bearer tokens. */
async function reviewedApproval(p:Principal,id:string,dependencies:Dependencies,q:DbOrTx=db){
  const [approval]=await q.select().from(hermesTeamCandidateApprovals).where(eq(hermesTeamCandidateApprovals.id,id));
  const [context]=approval ? await q.select().from(hermesTeamCandidateContexts).where(eq(hermesTeamCandidateContexts.id,approval.contextId)) : [];
  if(!approval || !context || context.actorId!==p.user.id || context.sessionVersion!==p.user.sessionVersion)throw new HttpError(404,'Native approval not found.');
    // Tokens are deliberately unrecoverable. Revalidate the persisted run rather than manufacturing a native token.
    const validated=await validateCandidateContext(context,dependencies.routes??VERIFIED_TEAM_MODEL_ROUTES,q);
    const {authority}=await resolvedToolAuthority(validated,approval.attribution.capabilityId,q);
    const checked=authorizeTeamTool(p.user.id,{botId:context.botId,runId:context.runId,capabilityId:approval.attribution.capabilityId,input:approval.input},authority,dependencies.adapters??VERIFIED_TEAM_TOOL_ADAPTERS);
    if(candidateObjectHash(checked.attribution)!==candidateObjectHash(approval.attribution))throw new HttpError(403,'The reviewed native action changed.');
  return {approval,context};
}

export async function listCandidateApprovals(p:Principal,conversationId:string,dependencies:Dependencies={}){
  const rows=await db.select({id:hermesTeamCandidateApprovals.id}).from(hermesTeamCandidateApprovals)
    .innerJoin(hermesTeamCandidateContexts,eq(hermesTeamCandidateApprovals.contextId,hermesTeamCandidateContexts.id))
    .innerJoin(agentRuns,eq(hermesTeamCandidateContexts.runId,agentRuns.id))
    .where(and(eq(hermesTeamCandidateContexts.actorId,p.user.id),eq(agentRuns.conversationId,conversationId),
      eq(hermesTeamCandidateApprovals.state,'pending'),gt(hermesTeamCandidateApprovals.expiresAt,new Date()))).limit(16);
  const result=[];
  for(const row of rows){
    try{const {approval}=await reviewedApproval(p,row.id,dependencies);
      result.push({id:approval.id,action:approval.attribution.action,resourceIds:approval.attribution.resourceIds,input:approval.input,expiresAt:approval.expiresAt.toISOString()});
    }catch(error){if(!(error instanceof HttpError) && !(error instanceof TeamToolPolicyError))throw error;}
  }
  return result;
}

/** Held MCP call validates the same reviewed action during every wait interval. */
export async function checkCandidateApproval(contextId:string,authorization:string|null,id:string,dependencies:Dependencies={}){
  const current=await loadCandidateContext(contextId,authorization,'tool',dependencies.routes??VERIFIED_TEAM_MODEL_ROUTES);
  const checked=await reviewedApproval(current.principal,id,dependencies);
  if(checked.context.id!==contextId)throw new HttpError(403,'The native approval belongs to another context.');
  return checked.approval;
}

/** Ordinary session endpoint: an admin cannot approve a different member's native operation. */
export async function answerCandidateApproval(p:Principal,id:string,decision:'approved'|'rejected',dependencies:Dependencies={}){
  return db.transaction(async tx=>{
    const {context}=await reviewedApproval(p,id,dependencies,tx);
    await lockCandidateContext(tx,context);
    // Re-read after acquiring the same bot/context fence as every native dispatch.
    await reviewedApproval(p,id,dependencies,tx);
    const [locked]=await tx.select().from(hermesTeamCandidateApprovals).where(eq(hermesTeamCandidateApprovals.id,id)).for('update');
    if(locked.state!=='pending' || locked.expiresAt.getTime()<=Date.now())throw new HttpError(409,'This native approval already changed.');
    await tx.update(hermesTeamCandidateApprovals).set({state:decision,updatedAt:new Date()}).where(eq(hermesTeamCandidateApprovals.id,id));return {id,state:decision};
  });
}
