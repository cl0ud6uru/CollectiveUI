import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { hermesTeamCandidateRequests,usageEvents } from '@/db/schema';
import { HttpError } from '@/lib/authz';
import { createTeamModelGateway, VERIFIED_TEAM_MODEL_ROUTES, type TeamModelPurpose, type VerifiedTeamModelRoute } from './model-policy';
import { recordTeamRunAdmission } from './run-policy';
import { candidateObjectHash, loadCandidateContext, lockCandidateContext } from './candidate-context';
import { CANDIDATE_MODEL_LIMITS, validateNativeModelRequest, type TeamNativeModelProtocol } from './native-request';
import { loadCandidateModelWire } from './candidate-model-transport';

export type CandidateResponse = { status:number; contentType:string; body:string };
export function nativeRequestId(request: Request,payload?:unknown) {
  const id = request.headers.get('x-collective-request-id');
  // The trusted process shim emits a UUID through its HTTPX hook for each SDK request.
  // Unwrapped clients conservatively replay identical payloads within this run/purpose.
  if(!id && payload!==undefined)return `body:${candidateObjectHash(payload)}`;
  if (!id || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) throw new HttpError(400,'A stable native request UUID is required.');
  return id.toLowerCase();
}
export async function readCandidateResponse(response: Response, secrets: readonly string[]): Promise<CandidateResponse> {
  if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status === 401 || response.status === 403 ? 409 : 503,'The fixed model connection needs attention.'); }
  const contentType = response.headers.get('content-type') ?? 'application/json';
  if (!/^(application\/json|text\/event-stream)(;|$)/i.test(contentType)) { await response.body?.cancel(); throw new HttpError(503,'Unsupported model response.'); }
  const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  if (reader) try {
    for (;;) { const {done,value}=await reader.read(); if(done)break; bytes+=value.length;
      if(bytes>CANDIDATE_MODEL_LIMITS.responseBytes){ await reader.cancel();throw new HttpError(503,'The model response exceeds the supported bound.'); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  let body = Buffer.concat(chunks).toString('utf8');
  for (const secret of secrets.filter(Boolean)) body=body.split(secret).join('[redacted]');
  return {status:200,contentType,body};
}

/** Concrete production factory caller. Tests substitute the verified inventory and HTTP fetch, never credentials. */
export async function executeCandidateModel(request: Request, contextId: string, purpose: TeamModelPurpose, protocol: TeamNativeModelProtocol, raw: unknown,
  dependencies: { routes?:readonly VerifiedTeamModelRoute[]; fetch?:typeof fetch } = {}): Promise<CandidateResponse> {
  const routes=dependencies.routes ?? VERIFIED_TEAM_MODEL_ROUTES;
  const authorization=request.headers.get('authorization');
  const initial=await loadCandidateContext(contextId,authorization,purpose,routes);
  // Pinned Codex rewrites strip max_output_tokens. Until a bounded native contract is
  // proven, reject before reservations, credential decryption or any provider request.
  if (initial.context.modelRoute.integration === 'hermes_native_codex' || initial.context.modelRoute.integration === 'openai_chatgpt_plan_usage')
    throw new HttpError(409, 'Personal native model transport cannot enforce the candidate output bound.');
  const body=validateNativeModelRequest(raw,protocol,initial.context.modelRoute.model);
  const requestId=nativeRequestId(request,{purpose,protocol,body});
  const inputHash=candidateObjectHash({purpose,protocol,body});
  const inputBytes=Buffer.byteLength(JSON.stringify(body),'utf8');
  let receiptId: string | undefined;
  const current=()=>loadCandidateContext(contextId,authorization,purpose,routes);
  const gateway=createTeamModelGateway<Record<string,unknown>,CandidateResponse>({ routes,now:Date.now,
    currentUserId:async()=>(await current()).context.actorId,
    loadAuthority:async()=> (await current()).authority,
    reserveUsage:async attribution=>db.transaction(async tx=>{
      await lockCandidateContext(tx,initial.context);
      const fresh=await loadCandidateContext(contextId,authorization,purpose,routes,tx);
      const existing=await tx.select().from(hermesTeamCandidateRequests).where(and(eq(hermesTeamCandidateRequests.contextId,contextId),eq(hermesTeamCandidateRequests.kind,'model'),eq(hermesTeamCandidateRequests.requestId,requestId))).for('update');
      const prior=existing[0];
      if(prior && (prior.inputHash!==inputHash || prior.purpose!==purpose))throw new HttpError(409,'The native request UUID was reused with different content.');
      if(prior && prior.state!=='complete')throw new HttpError(409,'This model request is unresolved. Retry only after reconciliation.');
      if(prior){receiptId=prior.id;return{id:prior.id,attribution};}
      const all=await tx.select().from(hermesTeamCandidateRequests).where(and(eq(hermesTeamCandidateRequests.contextId,contextId),eq(hermesTeamCandidateRequests.kind,'model')));
      if(all.some(row=>row.state!=='complete'))throw new HttpError(409,'Reconcile the previous native request before dispatching another model call.');
      const output=Number(body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens);
      if(all.length>=CANDIDATE_MODEL_LIMITS.requests || all.reduce((n,r)=>n+r.outputReserved,0)+output>CANDIDATE_MODEL_LIMITS.outputTokens
        || all.reduce((n,r)=>n+r.inputReservedBytes,0)+inputBytes>CANDIDATE_MODEL_LIMITS.inputBytes)throw new HttpError(409,'This native run exhausted its bounded model allowance.');
      const id=randomUUID();
      await tx.insert(hermesTeamCandidateRequests).values({id,contextId,requestId,kind:'model',purpose,inputHash,inputReservedBytes:inputBytes,outputReserved:output});
      await recordTeamRunAdmission(fresh.principal,fresh.context.runId,purpose,routes,{ gatewayGrantId:contextId,usageReceiptId:`${contextId}:${purpose}`,
        choice:fresh.context.modelRoute.billing==='personal'?'personal':'default' },tx);
      receiptId=id;return{id,attribution};
    }),
    // Preserve an explicit receipt even when access disappeared before dispatch. No caller can reset the allowance.
    releaseUsage:async id=>{await db.update(hermesTeamCandidateRequests).set({state:'needs_attention',updatedAt:new Date()}).where(eq(hermesTeamCandidateRequests.id,id));},
    dispatch:async(_input,_attribution,id)=>{
      const prior=await db.transaction(async tx=>{
        await lockCandidateContext(tx,initial.context);await loadCandidateContext(contextId,authorization,purpose,routes,tx);
        const [row]=await tx.select().from(hermesTeamCandidateRequests).where(eq(hermesTeamCandidateRequests.id,id)).for('update');
        if(row?.state==='complete' && row.response)return row.response;
        if(!row || row.state!=='reserved')throw new HttpError(409,'The native request was already started.');
        await tx.update(hermesTeamCandidateRequests).set({state:'running',updatedAt:new Date()}).where(eq(hermesTeamCandidateRequests.id,id));return null;
      });
      if(prior)return prior;
      const abort=new AbortController(); let watch:ReturnType<typeof setTimeout>|undefined;let finished=false;
      const callerAbort=()=>abort.abort();request.signal.addEventListener('abort',callerAbort,{once:true});
      if(request.signal.aborted)abort.abort();
      const check=async()=>{if(finished)return;try{await current();if(!finished)watch=setTimeout(()=>void check(),250);}catch{abort.abort();}};
      const timeout=setTimeout(()=>abort.abort(),45000);
      try{
        // Claim is committed before I/O. Hold the bot lock while checking and starting the one external request.
        const started=await db.transaction(async tx=>{
          await lockCandidateContext(tx,initial.context);
          const fresh=await loadCandidateContext(contextId,authorization,purpose,routes,tx);
          if(abort.signal.aborted)throw new HttpError(409,'The native requester cancelled.');
          const wire=await loadCandidateModelWire(fresh.context,protocol,tx,dependencies.fetch);
          return { response:wire.send(body,abort.signal),secrets:wire.secrets };
        });
        watch=setTimeout(()=>void check(),250);
        const result=await readCandidateResponse(await started.response,started.secrets);
        await db.transaction(async tx=>{
          const usage=nativeProviderUsage(result);
          await tx.insert(usageEvents).values({id,userId:initial.context.actorId,conversationId:initial.run.run.conversationId,runId:initial.context.runId,botId:initial.context.botId,
            appId:initial.context.modelRoute.billing==='admin'?initial.context.modelRoute.id.slice(4):null,providerKind:initial.context.modelRoute.billing==='admin'?'openai-compatible':'chatgpt',
            model:initial.context.modelRoute.model,purpose:purpose==='reply'?'chat':purpose==='subagent'?'delegate':purpose==='learning'?'memory':'draft',
            billingSource:initial.context.modelRoute.billing==='admin'?'org':'chatgpt_plan',credentialId:initial.context.personalConnectionId,inputTokens:usage.input,outputTokens:usage.output}).onConflictDoNothing();
        });
        // Historical accounting survives revocation; delivery and cached replay still require fresh access.
        await current();
        await db.update(hermesTeamCandidateRequests).set({state:'complete',response:result,updatedAt:new Date()}).where(eq(hermesTeamCandidateRequests.id,id));
        return result;
      }catch{
        await db.update(hermesTeamCandidateRequests).set({state:'needs_attention',updatedAt:new Date()}).where(eq(hermesTeamCandidateRequests.id,id));
        throw new HttpError(409,'The native model request needs attention; it will not retry or use another provider.');
      }finally{finished=true;clearTimeout(timeout);clearTimeout(watch);request.signal.removeEventListener('abort',callerAbort);abort.abort();}
    },
  });
  try{return await gateway.execute({botId:initial.context.botId,runId:initial.context.runId,purpose,choice:initial.context.modelRoute.billing==='personal'?'personal':'default'},body);}
  catch(error){if(receiptId)await db.update(hermesTeamCandidateRequests).set({updatedAt:new Date()}).where(eq(hermesTeamCandidateRequests.id,receiptId));throw error;}
}

/** Confirmed provider counters only. Missing counters remain unknown; reservations are not a cash estimate. */
export function nativeProviderUsage(response:CandidateResponse):{input:number|null;output:number|null}{
  let usage:Record<string,unknown>|undefined;
  const number=(value:unknown)=>typeof value==='number' && Number.isSafeInteger(value) && value>=0 && value<=2147483647?value:null;
  const inspect=(text:string)=>{try{const value=JSON.parse(text);if(value?.usage)usage=value.usage;else if(value?.response?.usage)usage=value.response.usage;}catch{}};
  if(response.contentType.startsWith('text/event-stream'))for(const line of response.body.split('\n')){if(line.startsWith('data:'))inspect(line.slice(5).trim());}
  else inspect(response.body);
  return {input:number(usage?.input_tokens??usage?.prompt_tokens),output:number(usage?.output_tokens??usage?.completion_tokens)};
}
