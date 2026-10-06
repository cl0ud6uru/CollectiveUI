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
class CandidateResponseError extends HttpError {
  constructor(readonly usage:{input:number|null;output:number|null}){super(503,'The native response could not be safely delivered.');}
}
/** Decode before checking known secrets. Arbitrary encoded/external secrets are not claimed to be detected. */
function safeNativeResponse(body:string,contentType:string,secrets:readonly string[]):string{
  const keys=secrets.filter(Boolean);let nodes=0;
  const bounded=(depth:number)=>{if(++nodes>100000 || depth>32)throw new Error('Bounded native response structure exceeded.');};
  // Native tools parse their arguments after the SDK decodes the outer response.
  // Check that recognized JSON layer as well; redacting its serialized text alone
  // would miss a credential represented by JSON escapes.
  const checkArguments=(text:string,depth:number)=>{
    if(Buffer.byteLength(text,'utf8')>CANDIDATE_MODEL_LIMITS.responseBytes)throw new Error('Bounded native arguments exceeded.');
    let decoded:unknown;try{decoded=JSON.parse(text);}catch{return;}
    const inspect=(value:unknown,level:number):void=>{
      bounded(level);
      if(typeof value==='string'){if(keys.some(secret=>value.includes(secret)))throw new Error('Unsafe native tool arguments.');return;}
      if(Array.isArray(value)){for(const item of value)inspect(item,level+1);return;}
      if(value && typeof value==='object')for(const [key,item] of Object.entries(value)){
        if(keys.some(secret=>key.includes(secret)))throw new Error('Unsafe native argument key.');
        if(key==='arguments' && typeof item==='string')checkArguments(item,level+1);
        inspect(item,level+1);
      }
    };
    inspect(decoded,depth);
  };
  const sanitize=(value:unknown,depth=0):unknown=>{
    bounded(depth);
    if(typeof value==='string'){let clean=value;for(const secret of keys)clean=clean.split(secret).join('[redacted]');return clean;}
    if(Array.isArray(value))return value.map(item=>sanitize(item,depth+1));
    if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>{
      if(keys.some(secret=>key.includes(secret)))throw new Error('Unsafe native response key.');
      if(key==='arguments' && typeof item==='string')checkArguments(item,depth+1);
      return[key,sanitize(item,depth+1)];}));
    return value;
  };
  if(!/^text\/event-stream/i.test(contentType))return JSON.stringify(sanitize(JSON.parse(body)));
  const streams=new Map<string,string>(),argumentStreams=new Set<string>();
  const append=(id:string,text:unknown,argumentsJson=false)=>{if(typeof text!=='string')return;const complete=(streams.get(id)??'')+text;streams.set(id,complete);
    if(argumentsJson)argumentStreams.add(id);
    if(keys.some(secret=>complete.includes(secret)))throw new Error('Unsafe native streamed response.');};
  const safe=body.split(/\r?\n\r?\n/).map(block=>{
    const lines=block.split(/\r?\n/);const data=lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
    if(!data || data.trim()==='[DONE]')return block;
    const value=JSON.parse(data);
    for(const choice of value.choices??[]){append(`content:${choice.index}`,choice.delta?.content);append(`refusal:${choice.index}`,choice.delta?.refusal);
      for(const call of choice.delta?.tool_calls??[])append(`args:${choice.index}:${call.index}`,call.function?.arguments,true);
      append(`legacy-args:${choice.index}`,choice.delta?.function_call?.arguments,true);}
    if(typeof value.delta==='string')append(`responses:${value.type}:${value.item_id??value.output_index??''}:${value.content_index??''}`,value.delta,value.type==='response.function_call_arguments.delta');
    return [...lines.filter(line=>!line.startsWith('data:')),`data: ${JSON.stringify(sanitize(value))}`].join('\n');
  }).join('\n\n');
  for(const id of argumentStreams)checkArguments(streams.get(id)!,0);
  return safe;
}
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
  const raw = {status:200,contentType,body:Buffer.concat(chunks).toString('utf8')};
  try{return {...raw,body:safeNativeResponse(raw.body,contentType,secrets)};}
  catch{throw new CandidateResponseError(nativeProviderUsage(raw));}
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
  const usageValues=(id:string)=>({id,userId:initial.context.actorId,conversationId:initial.run.run.conversationId,runId:initial.context.runId,botId:initial.context.botId,
    appId:initial.context.modelRoute.billing==='admin'?initial.context.modelRoute.id.slice(4):null,
    providerKind:initial.transport.providerKind,
    model:initial.context.modelRoute.model,purpose:purpose==='reply'?'chat' as const:purpose==='subagent'?'delegate' as const:purpose==='learning'?'memory' as const:'draft' as const,
    billingSource:initial.context.modelRoute.billing==='admin'?'org' as const:'chatgpt_plan' as const,credentialId:initial.context.personalConnectionId});
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
        await tx.update(hermesTeamCandidateRequests).set({state:'running',updatedAt:new Date()}).where(eq(hermesTeamCandidateRequests.id,id));
        // Commit the unknown usage attribution with the dispatch claim, before any provider I/O can start.
        await tx.insert(usageEvents).values(usageValues(id)).onConflictDoNothing();return null;
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
        const usage=nativeProviderUsage(result);
        await db.transaction(async tx=>{
          await tx.update(usageEvents).set({inputTokens:usage.input,outputTokens:usage.output}).where(eq(usageEvents.id,id));
        });
        if(usage.input===null || usage.output===null)throw new HttpError(409,'The provider did not confirm this request’s usage.');
        // Historical accounting survives revocation; delivery and cached replay still require fresh access.
        await current();
        await db.update(hermesTeamCandidateRequests).set({state:'complete',response:result,updatedAt:new Date()}).where(eq(hermesTeamCandidateRequests.id,id));
        return result;
      }catch(error){
        if(error instanceof CandidateResponseError)await db.update(usageEvents).set({inputTokens:error.usage.input,outputTokens:error.usage.output}).where(eq(usageEvents.id,id));
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
  if(/^text\/event-stream/i.test(response.contentType))for(const line of response.body.split('\n')){if(line.startsWith('data:'))inspect(line.slice(5).trim());}
  else inspect(response.body);
  return {input:number(usage?.input_tokens??usage?.prompt_tokens),output:number(usage?.output_tokens??usage?.completion_tokens)};
}
