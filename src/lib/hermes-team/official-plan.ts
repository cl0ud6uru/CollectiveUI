import { createHash,randomUUID } from 'node:crypto';
import { and,eq,sql } from 'drizzle-orm';
import { z } from 'zod';
import { db,type DbOrTx } from '@/db';
import { officialPlanConnections,officialPlanAuthOperations,officialPlanAuthAttempts } from '@/db/schema';
import { encrypt,decrypt } from '@/lib/crypto';
import { loadPrincipal,type Principal } from '@/lib/auth/groups';
import { HttpError } from '@/lib/authz';
import { validateNativeModelRequest } from './native-request';
import { canonicalTeamToolInput } from './tool-policy';

export const OFFICIAL_PLAN_ORIGIN='https://api.openai.com/v1';
export const OFFICIAL_PLAN_ADAPTER='collective-official-plan-responses-v1';
export const OFFICIAL_PLAN_REQUIRED_SCOPES=['chatgpt.tokens.use.direct','resource.invoke'] as const;
export type OfficialPlanConnection=typeof officialPlanConnections.$inferSelect;
const bounded=z.string().min(1).max(256);
const identitySchema=z.object({clientId:bounded,hostId:bounded,subject:bounded}).strict();
const tokenSchema=z.object({version:z.literal(1),access:z.string().min(1).max(16000),refresh:z.string().min(1).max(16000).optional(),accessHash:z.string().regex(/^[a-f0-9]{64}$/),idToken:z.string().min(1).max(16000).optional(),earliestRefreshHint:z.union([z.string().max(256),z.number().finite(),z.null()]).optional()}).strict();
const hash=(value:unknown)=>createHash('sha256').update(canonicalTeamToolInput(value)).digest('hex');
export const officialPlanTokenAad=(row:Pick<OfficialPlanConnection,'id'|'userId'|'clientId'|'hostId'|'subject'>)=>`official_plan_connections.token_bundle_enc|${JSON.stringify([row.id,row.userId,row.clientId,row.hostId,row.subject])}`;

/** This boundary must be supplied by the verified server authorization-code exchange, never a browser claim decoder. */
export type VerifiedOfficialAccessClaims={issuer:'https://auth.openai.com';audience:typeof OFFICIAL_PLAN_ORIGIN;subject:string;clientId:string;scopes:string[];issuedAt:number;notBefore:number;expiresAt:number};
export type OfficialPlanIngestion={verifyAccessToken(token:string):Promise<VerifiedOfficialAccessClaims>;fetch:typeof fetch};

export type OfficialPlanGrantInput={clientId:string;hostId:string;subject:string;access:string;refresh?:string;idToken?:string;earliestRefreshHint?:string|number|null};
export type OfficialPlanSelection={id:string|null;revision?:number};

/** Verification/catalog work is separate from atomic owner-bound persistence. */
export async function prepareOfficialPlanGrant(input:OfficialPlanGrantInput,services:OfficialPlanIngestion){
  const identity=identitySchema.parse({clientId:input.clientId,hostId:input.hostId,subject:input.subject});
  const bundle=tokenSchema.parse({version:1,access:input.access,refresh:input.refresh,idToken:input.idToken,earliestRefreshHint:input.earliestRefreshHint,accessHash:hash(input.access)});
  if(Buffer.byteLength(JSON.stringify(bundle))>32000)throw new HttpError(409,'The official token bundle is too large.');
  const claims=await services.verifyAccessToken(bundle.access),now=Date.now();
  if(claims.issuer!=='https://auth.openai.com' || claims.audience!==OFFICIAL_PLAN_ORIGIN || claims.clientId!==identity.clientId || claims.subject!==identity.subject
    || !Number.isSafeInteger(claims.issuedAt) || !Number.isSafeInteger(claims.notBefore) || !Number.isSafeInteger(claims.expiresAt)
    || claims.issuedAt>now+60000 || claims.notBefore>now || claims.expiresAt<=now || claims.expiresAt>now+3600000+60000
    || OFFICIAL_PLAN_REQUIRED_SCOPES.some(scope=>!claims.scopes.includes(scope)))throw new HttpError(409,'Official plan token verification failed.');
  z.array(z.string().min(1).max(100)).max(30).parse(claims.scopes);
  // The account-specific catalog must come from exactly the same token, not a shared global model list.
  const response=await services.fetch(`${OFFICIAL_PLAN_ORIGIN}/models`,{headers:{Authorization:`Bearer ${bundle.access}`},redirect:'error',signal:AbortSignal.timeout(8000)});
  if(!response.ok || !response.headers.get('content-type')?.startsWith('application/json')){await response.body?.cancel();throw new HttpError(409,'Official model discovery failed.');}
  const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
  if(!reader)throw new HttpError(409,'Official model discovery returned no catalog.');
  let deadline:ReturnType<typeof setTimeout>|undefined;
  try{const timeout=new Promise<never>((_,reject)=>{deadline=setTimeout(()=>{reject(new HttpError(408,'Official model discovery timed out.'));void reader.cancel().catch(()=>{});},8000);});
    for(;;){const item=await Promise.race([reader.read(),timeout]);if(item.done)break;size+=item.value.length;if(size>64000){await reader.cancel();throw new HttpError(409,'Official model catalog is too large.');}chunks.push(item.value);}
  }finally{clearTimeout(deadline);reader.releaseLock();}
  const catalogResponse=z.object({models:z.array(z.object({slug:z.string().min(1).max(200),display_name:z.string().max(256).optional(),visibility:z.string().max(50)}).passthrough()).max(100)}).passthrough().parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  const catalog=catalogResponse.models.filter(model=>model.visibility==='list').map(model=>model.slug);
  if(!catalog.length || new Set(catalog).size!==catalog.length)throw new HttpError(409,'Official model discovery returned an invalid catalog.');
  return {identity,bundle,claims,catalog,verifiedAt:now};
}

/** Caller owns the user lock; expected selection prevents overwriting an account changed during OAuth I/O. */
export async function persistOfficialPlanGrant(p:Principal,prepared:Awaited<ReturnType<typeof prepareOfficialPlanGrant>>,tx:DbOrTx,expected?:OfficialPlanSelection){
  const fresh=await loadPrincipal(p.user.id,tx);if(!fresh || fresh.user.disabled || fresh.user.sessionVersion!==p.user.sessionVersion)throw new HttpError(403,'The account session changed.');
  const [prior]=await tx.select().from(officialPlanConnections).where(and(eq(officialPlanConnections.userId,p.user.id),eq(officialPlanConnections.selected,true))).for('update');
  if(expected && ((prior?.id??null)!==expected.id || (prior && prior.revision!==expected.revision)))throw new HttpError(409,'The selected official account changed.');
  const {identity,bundle,claims,catalog,verifiedAt}=prepared;
  if(claims.expiresAt<=Date.now())throw new HttpError(409,'The verified official token expired before it could be stored.');
  const [same]=await tx.select().from(officialPlanConnections).where(and(eq(officialPlanConnections.userId,p.user.id),eq(officialPlanConnections.clientId,identity.clientId),eq(officialPlanConnections.hostId,identity.hostId),eq(officialPlanConnections.subject,identity.subject))).for('update');
  if(prior && prior.id!==same?.id)await tx.update(officialPlanConnections).set({selected:false,updatedAt:new Date()}).where(eq(officialPlanConnections.id,prior.id));
  const id=same?.id??randomUUID(),revision=same? same.revision+1:1;
  const values={...identity,userId:p.user.id,selected:true,status:'active' as const,scopes:claims.scopes,expiresAt:new Date(claims.expiresAt),
    tokenBundleEnc:encrypt(JSON.stringify(bundle),officialPlanTokenAad({id,userId:p.user.id,...identity})),revision,catalog,catalogRevision:revision,
    catalogExpiresAt:new Date(Math.min(claims.expiresAt,verifiedAt+300000)),verifiedAt:new Date(verifiedAt),updatedAt:new Date()};
  if(same)await tx.update(officialPlanConnections).set(values).where(eq(officialPlanConnections.id,id));else await tx.insert(officialPlanConnections).values({id,...values});
  return {connected:true};
}

/** Trusted ingestion only; browser token objects are never accepted. */
export async function storeVerifiedOfficialPlanGrant(p:Principal,input:OfficialPlanGrantInput,services:OfficialPlanIngestion){
  const current=await loadPrincipal(p.user.id);if(!current || current.user.disabled || current.user.sessionVersion!==p.user.sessionVersion)throw new HttpError(403,'The account session changed.');
  const prepared=await prepareOfficialPlanGrant(input,services);
  return db.transaction(async tx=>{await tx.execute(sql`select id from users where id = ${p.user.id} for update`);return persistOfficialPlanGrant(p,prepared,tx);});
}

/** Metadata is fresh and owner-specific; no decryption, refresh, discovery or inference. */
export async function officialPlanMetadata(userId:string,model:string|undefined,q:DbOrTx=db,now=Date.now()){
  const [row]=await q.select({id:officialPlanConnections.id,userId:officialPlanConnections.userId,clientId:officialPlanConnections.clientId,hostId:officialPlanConnections.hostId,
    subject:officialPlanConnections.subject,status:officialPlanConnections.status,selected:officialPlanConnections.selected,scopes:officialPlanConnections.scopes,
    expiresAt:officialPlanConnections.expiresAt,credentialRevision:officialPlanConnections.tokenBundleEnc,revision:officialPlanConnections.revision,
    catalog:officialPlanConnections.catalog,catalogRevision:officialPlanConnections.catalogRevision,catalogExpiresAt:officialPlanConnections.catalogExpiresAt,verifiedAt:officialPlanConnections.verifiedAt})
    .from(officialPlanConnections).where(and(eq(officialPlanConnections.userId,userId),eq(officialPlanConnections.selected,true))).for('share');
  if(!row)return null;
  const [unresolved]=await q.select({id:officialPlanAuthOperations.id}).from(officialPlanAuthOperations).where(and(eq(officialPlanAuthOperations.connectionId,row.id),eq(officialPlanAuthOperations.credentialRevision,row.revision),sql`${officialPlanAuthOperations.state} in ('running','needs_attention')`));
  if(unresolved)throw new HttpError(409,'The official account has an unresolved token operation. Reconnect before model work.');
  const [exchanging]=await q.select({id:officialPlanAuthAttempts.id}).from(officialPlanAuthAttempts).where(and(eq(officialPlanAuthAttempts.expectedConnectionId,row.id),eq(officialPlanAuthAttempts.expectedRevision,row.revision),sql`${officialPlanAuthAttempts.state} in ('exchanging','needs_attention')`));
  if(exchanging)throw new HttpError(409,'The official account has an unresolved sign-in. Reconnect before model work.');
  if(!row.credentialRevision.startsWith('v2.') || row.status!=='active' || row.expiresAt.getTime()<=now || row.catalogExpiresAt.getTime()<=now
    || row.catalogRevision!==row.revision || OFFICIAL_PLAN_REQUIRED_SCOPES.some(scope=>!row.scopes.includes(scope)) || (model && !row.catalog.includes(model)))throw new HttpError(409,'The official personal account needs verified model access.');
  return {id:row.id,userId:row.userId,expiresAt:row.expiresAt.getTime(),bindingHash:hash({...row,expiresAt:row.expiresAt.getTime(),catalogExpiresAt:row.catalogExpiresAt.getTime(),verifiedAt:row.verifiedAt.getTime()})};
}

export function openOfficialPlanSecret(row:OfficialPlanConnection){
  if(!row.tokenBundleEnc.startsWith('v2.'))throw new HttpError(409,'An owner-bound official credential is required.');
  const bundle=tokenSchema.parse(JSON.parse(decrypt(row.tokenBundleEnc,officialPlanTokenAad(row))));
  if(hash(bundle.access)!==bundle.accessHash)throw new HttpError(409,'The official credential changed.');
  return bundle;
}

/** Local text Responses subset. No unsupported provider output cap or hosted tool is invented. */
export function validateOfficialPlanRequest(raw:unknown,model:string,requireHardLimits=false){
  if(requireHardLimits)throw new HttpError(409,'Official plan usage has no verified hard token or cost ceiling.');
  const textPart=z.object({type:z.enum(['input_text','output_text']),text:z.string().max(48000)}).strict();
  const inputItem=z.union([
    z.object({type:z.literal('message').optional(),role:z.enum(['user','assistant','developer']),content:z.union([z.string().max(48000),z.array(textPart).max(256)]),id:z.string().max(200).optional(),status:z.enum(['in_progress','completed','incomplete']).optional()}).strict(),
    z.object({type:z.literal('function_call'),call_id:z.string().min(1).max(200),name:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),arguments:z.string().max(48000),namespace:z.literal('collective_native').optional(),id:z.string().max(200).optional(),status:z.enum(['in_progress','completed','incomplete']).optional()}).strict(),
    z.object({type:z.literal('function_call_output'),call_id:z.string().min(1).max(200),output:z.union([z.string().max(48000),z.array(z.object({type:z.literal('input_text'),text:z.string().max(48000)}).strict()).max(256)])}).strict(),
    z.object({type:z.literal('reasoning'),encrypted_content:z.string().min(1).max(48000),summary:z.array(z.object({type:z.literal('summary_text'),text:z.string().max(48000)}).strict()).max(256)}).strict(),
  ]);
  const body=z.object({model:z.literal(model),input:z.array(inputItem).min(1).max(256),instructions:z.string().max(48000).optional(),
    stream:z.literal(true).optional(),store:z.literal(false).optional(),reasoning:z.union([z.object({enabled:z.literal(false)}).strict(),z.object({effort:z.enum(['minimal','low','medium','high']).optional(),summary:z.enum(['auto','concise','detailed']).optional()}).strict()]).optional(),
    max_output_tokens:z.literal(256).optional(), // The pinned native client's local hint is removed; this is not a provider ceiling.
    include:z.array(z.literal('reasoning.encrypted_content')).max(1).optional(),prompt_cache_key:z.string().min(1).max(64).optional(),prompt_cache_retention:z.enum(['in_memory','24h']).optional(),
    tools:z.array(z.object({type:z.literal('function'),name:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),description:z.string().max(4000).optional(),parameters:z.record(z.string(),z.unknown()).nullable().optional(),strict:z.boolean().nullable().optional()}).strict()).max(128).optional(),
    tool_choice:z.enum(['auto','none','required']).optional(),
    text:z.object({verbosity:z.enum(['low','medium','high']).optional(),format:z.object({type:z.enum(['text','json_object','json_schema']),name:z.string().max(200).optional(),description:z.string().max(4000).optional(),schema:z.record(z.string(),z.unknown()).optional(),strict:z.boolean().optional()}).strict().optional()}).strict().optional(),parallel_tool_calls:z.boolean().optional()}).strict().parse(raw);
  canonicalTeamToolInput(body);
  const {max_output_tokens:_nativeLocalHint,prompt_cache_retention:_unsupportedRetention,tools,reasoning,...supported}=body;
  void _nativeLocalHint;void _unsupportedRetention;
  const input=body.input.map(item=>item.type==='function_call'?{...item,namespace:'collective_native'}:item);
  return {...supported,input,store:false,stream:true,...(reasoning && !('enabled' in reasoning)?{reasoning}:{}),...(tools?.length?{tools:[{type:'namespace',name:'collective_native',description:'Approved local native functions',tools}]}:{})};
}

export function officialPlanCompleted(body:string){
  let completed=false;
  for(const line of body.split('\n'))if(line.startsWith('data:')){const text=line.slice(5).trim();if(!text || text==='[DONE]')continue;let event:Record<string,unknown>;try{event=JSON.parse(text);}catch{throw new HttpError(409,'Malformed official response stream.');}
    if(['response.failed','response.incomplete','error'].includes(String(event.type)))throw new HttpError(409,'The official response did not complete.');
    if(event.type==='response.completed')completed=true;
  }
  if(!completed)throw new HttpError(409,'The official response stream ended before completion.');
}

/** Supported official namespace output is converted back to the pinned native flat function contract. */
export function officialPlanNativeResponse(body:string,toolNames:readonly string[]){
 const allowed=new Set(toolNames);
 const inspect=(item:unknown):unknown=>{
  if(!item || typeof item!=='object')return item;
  const value=item as Record<string,unknown>;
  if(value.type==='function_call'){
   if(value.namespace!=='collective_native' || typeof value.name!=='string' || !allowed.has(value.name))throw new HttpError(409,'The official response selected an unsupported native function.');
   const {namespace:_namespace,...flat}=value;void _namespace;return flat;
  }
  return value;
 };
 return body.split(/\r?\n\r?\n/).map(block=>{
  const lines=block.split(/\r?\n/),raw=lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');
  if(!raw || raw==='[DONE]')return block;
  const event=JSON.parse(raw) as Record<string,unknown>;
  if(event.item)event.item=inspect(event.item);
  if(event.response && typeof event.response==='object'){
   const response=event.response as Record<string,unknown>;if(Array.isArray(response.output))response.output=response.output.map(inspect);
  }
  return [...lines.filter(line=>!line.startsWith('data:')),`data: ${JSON.stringify(event)}`].join('\n');
 }).join('\n\n');
}

/** The pin's auxiliary/delegate clients use Chat Completions even when the main client uses Responses. */
export function officialPlanFromNativeChat(raw:unknown,model:string){
 const body=validateNativeModelRequest(raw,'chat_completions',model);
 for(const key of ['temperature','top_p','presence_penalty','frequency_penalty','seed','stop'])if(body[key]!==undefined)throw new HttpError(409,'This native setting is unsupported by official plan usage.');
 const input:Record<string,unknown>[]=[];
 for(const rawMessage of body.messages as Record<string,unknown>[]){
  const message=z.object({role:z.enum(['system','developer','user','assistant','tool']),content:z.union([z.string(),z.null(),z.array(z.object({type:z.literal('text'),text:z.string()}).strict())]),
    tool_calls:z.array(z.object({id:z.string().min(1).max(200),type:z.literal('function'),function:z.object({name:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),arguments:z.string().max(48000)}).strict()}).strict()).max(128).optional(),tool_call_id:z.string().max(200).optional()}).strict().parse(rawMessage);
  const content=typeof message.content==='string'?message.content:Array.isArray(message.content)?message.content.map(part=>part.text).join('\n'):'';
  if(message.role==='tool'){if(!message.tool_call_id)throw new HttpError(409,'Missing native tool result identity.');input.push({type:'function_call_output',call_id:message.tool_call_id,output:content});continue;}
  if(content || !message.tool_calls?.length)input.push({role:message.role==='system'?'developer':message.role,content});
  for(const call of message.tool_calls??[])input.push({type:'function_call',namespace:'collective_native',call_id:call.id,name:call.function.name,arguments:call.function.arguments});
 }
 const tools=body.tools===undefined?undefined:z.array(z.object({type:z.literal('function'),function:z.object({name:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),description:z.string().max(4000).optional(),parameters:z.record(z.string(),z.unknown()).optional(),strict:z.boolean().optional()}).strict()}).strict()).max(128).parse(body.tools).map(tool=>({type:'function',...tool.function}));
 let text:unknown;
 if(body.response_format!==undefined){const format=z.union([z.object({type:z.literal('json_object')}).strict(),z.object({type:z.literal('json_schema'),json_schema:z.object({name:z.string().max(200),description:z.string().max(4000).optional(),schema:z.record(z.string(),z.unknown()),strict:z.boolean().optional()}).strict()}).strict()]).parse(body.response_format);
  text={format:format.type==='json_schema'?{type:'json_schema',...format.json_schema}:format};}
 return validateOfficialPlanRequest({model,input,...(tools?{tools}:{}),...(text?{text}:{}),...(body.tool_choice!==undefined?{tool_choice:body.tool_choice}:{}),
  ...(body.parallel_tool_calls!==undefined?{parallel_tool_calls:body.parallel_tool_calls}:{}),...(body.reasoning_effort!==undefined?{reasoning:{effort:body.reasoning_effort}}:{})},model);
}

/** Return the pin's Chat response shape after the mandatory official stream reaches a successful terminal event. */
export function officialPlanToNativeChat(body:string,model:string,streaming:boolean,usage:{input:number|null;output:number|null}){
 let response:Record<string,unknown>|undefined;
 for(const line of body.split('\n'))if(line.startsWith('data:')){const text=line.slice(5).trim();if(text==='[DONE]' || !text)continue;const event=JSON.parse(text);if(event.type==='response.completed')response=event.response;}
 if(!response || !Array.isArray(response.output))throw new HttpError(409,'The official response has no completed output.');
 let content='';const calls:Record<string,unknown>[]=[];
 for(const item of response.output){if(item.type==='message')for(const part of item.content??[]){if(part.type==='output_text')content+=part.text;else if(part.type==='refusal')throw new HttpError(409,'The official response was refused.');}
  else if(item.type==='function_call')calls.push({id:item.call_id,type:'function',function:{name:item.name,arguments:item.arguments}});}
 const counters={prompt_tokens:usage.input,completion_tokens:usage.output,total_tokens:usage.input!==null&&usage.output!==null?usage.input+usage.output:null};
 const common={id:`chatcmpl-${String(response.id??'official-native')}`,model,created:Math.floor(Date.now()/1000)};
 const message={role:'assistant',content:content||null,...(calls.length?{tool_calls:calls}:{})},finish=calls.length?'tool_calls':'stop';
 if(!streaming)return {contentType:'application/json',body:JSON.stringify({...common,object:'chat.completion',choices:[{index:0,message,finish_reason:finish}],usage:counters})};
 const delta={role:'assistant',...(content?{content}:{}),...(calls.length?{tool_calls:calls.map((call,index)=>({...call,index}))}:{})};
 return {contentType:'text/event-stream',body:`data: ${JSON.stringify({...common,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:null}]})}\n\ndata: ${JSON.stringify({...common,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:finish}],usage:counters})}\n\ndata: [DONE]\n\n`};
}
