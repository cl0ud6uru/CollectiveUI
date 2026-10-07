import { randomBytes,randomUUID } from 'node:crypto';
import { and,eq,gte,inArray,sql } from 'drizzle-orm';
import { z } from 'zod';
import { db,type DbOrTx } from '@/db';
import { officialPlanAuthAttempts,officialPlanAuthOperations,officialPlanConnections } from '@/db/schema';
import { decrypt,encrypt,safeEqual,sha256Hex } from '@/lib/crypto';
import { loadPrincipal,type Principal } from '@/lib/auth/groups';
import { HttpError } from '@/lib/authz';
import { OFFICIAL_PLAN_ORIGIN,OFFICIAL_PLAN_REQUIRED_SCOPES,openOfficialPlanSecret,officialPlanTokenAad,prepareOfficialPlanGrant,persistOfficialPlanGrant,type OfficialPlanConnection,type VerifiedOfficialAccessClaims } from './official-plan';
import { createOfficialPlanVerifier } from './official-plan-signatures';

export const OFFICIAL_AUTHORIZE_URL='https://auth.openai.com/api/accounts/authorize';
export const OFFICIAL_TOKEN_URL='https://auth.openai.com/api/accounts/oauth/token';
export const OFFICIAL_AUTH_UNAVAILABLE='Official sign-in needs a verified authenticated loopback return transport. It is unavailable in this build.';
const SCOPES=['openid','profile','email','offline_access',...OFFICIAL_PLAN_REQUIRED_SCOPES].join(' ');
const random=()=>randomBytes(32).toString('base64url');
type Attempt=typeof officialPlanAuthAttempts.$inferSelect;
type Tx=Parameters<Parameters<typeof db.transaction>[0]>[0];
const secretSchema=z.object({version:z.literal(1),verifier:z.string().regex(/^[A-Za-z0-9_-]{43}$/),nonce:z.string().regex(/^[A-Za-z0-9_-]{43}$/),clientId:z.string().min(1).max(256),subject:z.string().max(256).nullable()}).strict();
const aad=(row:Pick<Attempt,'id'|'userId'|'sessionVersion'|'transportId'|'hostId'|'redirectUri'|'stateHash'|'returnTokenHash'|'expectedConnectionId'|'expectedRevision'|'expiresAt'>)=>`official_plan_auth_attempts.secret_enc|${JSON.stringify([row.id,row.userId,row.sessionVersion,row.transportId,row.hostId,row.redirectUri,row.stateHash,row.returnTokenHash,row.expectedConnectionId,row.expectedRevision,row.expiresAt.getTime()])}`;
const callbackSchema=z.object({state:z.string().min(1).max(100),code:z.string().min(1).max(4000).optional(),client_id:z.string().min(1).max(256).optional(),scope:z.string().max(4000).optional(),error:z.enum(['access_denied','invalid_request','server_error','temporarily_unavailable']).optional()}).strict().refine(value=>Boolean(value.code)!==Boolean(value.error));
const tokenSchema=z.object({access_token:z.string().min(1).max(16000),refresh_token:z.string().min(1).max(16000).optional(),id_token:z.string().min(1).max(16000).optional(),token_type:z.string().refine(value=>value.toLowerCase()==='bearer'),expires_in:z.number().int().positive().max(3660),scope:z.string().max(4000),earliest_refresh_at:z.union([z.string().max(256),z.number().finite(),z.null()]).optional()}).passthrough();
type TokenResponse=z.infer<typeof tokenSchema>;

/** A local listener must already be running, authenticated and verified before it returns a callback URI. */
export type OfficialLoopbackTransport={id:string;prepare(p:Principal,input:{attemptId:string;returnToken:string}):Promise<{hostId:string;redirectUri:string}>};
/** No public HTTPS callback or paste-return substitute is silently installed. */
export const VERIFIED_OFFICIAL_LOOPBACK_TRANSPORTS:readonly OfficialLoopbackTransport[]=[];
export type OfficialAuthServices={fetch:typeof fetch;transports:readonly OfficialLoopbackTransport[];verifier:{verifyAccessToken(token:string):Promise<VerifiedOfficialAccessClaims>;verifyIdToken(token:string,expected:{clientId:string;nonce?:string;subject?:string}):Promise<{subject:string}>;revocationEndpoint():Promise<string>}};
export function officialAuthServices(fetcher:typeof fetch=fetch):OfficialAuthServices{return {fetch:fetcher,transports:VERIFIED_OFFICIAL_LOOPBACK_TRANSPORTS,verifier:createOfficialPlanVerifier(fetcher)};}

export function officialLoopbackUri(value:string){
 const uri=new URL(value);if(uri.protocol!=='http:' || uri.hostname!=='127.0.0.1' || !uri.port || Number(uri.port)<1024 || uri.pathname!=='/auth/callback' || uri.username || uri.password || uri.search || uri.hash)throw new HttpError(409,'A verified OpenAI loopback callback is required.');
 return uri.href;
}
async function principal(p:Principal,q:DbOrTx=db){const fresh=await loadPrincipal(p.user.id,q);if(!fresh || fresh.user.disabled || fresh.user.sessionVersion!==p.user.sessionVersion)throw new HttpError(403,'The account session changed.');return fresh;}
async function ownerLock(tx:Tx,p:Principal){await tx.execute(sql`select id from users where id = ${p.user.id} for update`);await principal(p,tx);}
async function selected(p:Principal,q:DbOrTx=db){return (await q.select().from(officialPlanConnections).where(and(eq(officialPlanConnections.userId,p.user.id),eq(officialPlanConnections.selected,true))).for('update'))[0];}

/** Bounded fixed-endpoint protocol I/O; no retries, redirects or upstream error/token echo. */
async function oauthForm(services:OfficialAuthServices,url:string,body:URLSearchParams,empty=false){
 const controller=new AbortController();let rejectTimeout:(error:Error)=>void=()=>{};
 const timeout=new Promise<never>((_,reject)=>{rejectTimeout=reject;});
 const deadline=setTimeout(()=>{controller.abort();rejectTimeout(new HttpError(408,'Official token operation timed out.'));},8000);let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 try{
  const response=await Promise.race([services.fetch(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:body.toString(),redirect:'error',signal:controller.signal}),timeout]);
  reader=response.body?.getReader();let bytes=0;const chunks:Uint8Array[]=[];
  while(reader){const part=await Promise.race([reader.read(),timeout]);if(part.done)break;bytes+=part.value.length;if(bytes>64000)throw new HttpError(409,'The official token response is too large.');chunks.push(part.value);}
  const text=Buffer.concat(chunks).toString('utf8');
  if(!response.ok)throw new HttpError(409,'The official token operation failed. Reconnect instead of retrying it.');
  if(empty){
   // The official renewable-session contract confirms only an empty HTTP 200.
   if(response.status!==200 || bytes!==0)throw new HttpError(409,'Official remote logout was not confirmed.');
   return null;
  }
  if(!response.headers.get('content-type')?.startsWith('application/json'))throw new HttpError(409,'The official token response is invalid.');
  return tokenSchema.parse(JSON.parse(text));
 }catch{throw new HttpError(409,'The official token operation was not confirmed. Reconnect before continuing.');}
 finally{clearTimeout(deadline);controller.abort();void reader?.cancel().catch(()=>{});reader?.releaseLock();}
}
async function verifiedTokens(services:OfficialAuthServices,tokens:TokenResponse,clientId:string,expected:{nonce?:string;subject?:string},idRequired:boolean){
 const scopes=tokens.scope.split(/\s+/).filter(Boolean);if(OFFICIAL_PLAN_REQUIRED_SCOPES.some(scope=>!scopes.includes(scope)))throw new HttpError(409,'Official plan permission was not granted.');
 if(idRequired && !tokens.id_token)throw new HttpError(409,'The official identity token is missing.');
 const identity=tokens.id_token?await services.verifier.verifyIdToken(tokens.id_token,{clientId,...expected}):{subject:expected.subject};
 const access=await services.verifier.verifyAccessToken(tokens.access_token);
 if(!identity.subject || access.subject!==identity.subject || access.clientId!==clientId || OFFICIAL_PLAN_REQUIRED_SCOPES.some(scope=>!access.scopes.includes(scope)))throw new HttpError(409,'The official token owner or permission changed.');
 return access;
}

export async function startOfficialPlanAuth(p:Principal,reauth=false,services:OfficialAuthServices=officialAuthServices()){
 await principal(p);const transport=services.transports[0];if(!transport)throw new HttpError(409,OFFICIAL_AUTH_UNAVAILABLE);
 const id=randomUUID(),state=random(),returnToken=random(),nonce=random(),verifier=random();
 // prepare must prove the listener is live first; its secret is delivered only to this trusted adapter.
 const prepared=await transport.prepare(p,{attemptId:id,returnToken});const redirectUri=officialLoopbackUri(prepared.redirectUri),hostId=z.string().min(1).max(256).parse(prepared.hostId);
 return db.transaction(async tx=>{
  await ownerLock(tx,p);const now=new Date();
  await tx.update(officialPlanAuthAttempts).set({state:'expired',updatedAt:now}).where(and(eq(officialPlanAuthAttempts.userId,p.user.id),eq(officialPlanAuthAttempts.state,'pending'),sql`${officialPlanAuthAttempts.expiresAt} <= ${now}`));
  await tx.update(officialPlanAuthAttempts).set({state:'needs_attention',updatedAt:now}).where(and(eq(officialPlanAuthAttempts.userId,p.user.id),eq(officialPlanAuthAttempts.state,'exchanging'),sql`${officialPlanAuthAttempts.expiresAt} <= ${now}`));
  const recent=await tx.select({id:officialPlanAuthAttempts.id,state:officialPlanAuthAttempts.state}).from(officialPlanAuthAttempts).where(and(eq(officialPlanAuthAttempts.userId,p.user.id),gte(officialPlanAuthAttempts.createdAt,new Date(now.getTime()-600000))));
  if(recent.length>=5 || recent.some(row=>row.state==='pending'||row.state==='exchanging'))throw new HttpError(409,'Complete or reconcile the existing official sign-in first.');
  const connection=await selected(p,tx);if(reauth && (!connection || connection.hostId!==hostId))throw new HttpError(409,'Reconnect requires the retained registration and its stable loopback host.');
  const clientId=reauth?connection!.clientId:'dynamic_agent_client';
  const row={id,userId:p.user.id,sessionVersion:p.user.sessionVersion,transportId:transport.id,hostId,redirectUri,stateHash:sha256Hex(state),returnTokenHash:sha256Hex(returnToken),expectedConnectionId:connection?.id??null,expectedRevision:connection?.revision??null,expiresAt:new Date(now.getTime()+600000)};
  await tx.insert(officialPlanAuthAttempts).values({...row,payloadEnc:encrypt(JSON.stringify({version:1,verifier,nonce,clientId,subject:reauth?connection!.subject:null}),aad(row)),createdAt:now});
  const url=new URL(OFFICIAL_AUTHORIZE_URL);for(const [key,value] of Object.entries({response_type:'code',client_id:clientId,redirect_uri:redirectUri,scope:SCOPES,resource:OFFICIAL_PLAN_ORIGIN,state,nonce,code_challenge:Buffer.from(sha256Hex(verifier),'hex').toString('base64url'),code_challenge_method:'S256',ext_agent_host_id:hostId,...(!reauth?{agent_name_hint:'CollectiveUI'}:{})}))url.searchParams.set(key,value);
  return {attemptId:id,authorizationUrl:url.href};
 });
}

/** Called only by a verified, authenticated loopback return adapter, never with a pasted browser code. */
export async function returnOfficialPlanAuth(attemptId:string,returnAuthorization:string|null,raw:unknown,services:OfficialAuthServices=officialAuthServices()){
 const callback=callbackSchema.parse(raw),callbackHash=sha256Hex(JSON.stringify(callback));
 const [peek]=await db.select().from(officialPlanAuthAttempts).where(eq(officialPlanAuthAttempts.id,attemptId));
 const bearer=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(returnAuthorization??'')?.[1];
 if(!peek || !bearer || !services.transports.some(t=>t.id===peek.transportId) || !safeEqual(sha256Hex(bearer),peek.returnTokenHash) || !safeEqual(sha256Hex(callback.state),peek.stateHash))throw new HttpError(403,'The loopback return is not authorized.');
 const p=await loadPrincipal(peek.userId);if(!p || p.user.sessionVersion!==peek.sessionVersion)throw new HttpError(403,'The account session changed.');
 const claimed=await db.transaction(async tx=>{
  await ownerLock(tx,p);const [row]=await tx.select().from(officialPlanAuthAttempts).where(eq(officialPlanAuthAttempts.id,attemptId)).for('update');
  if(!row || row.expiresAt.getTime()<=Date.now())throw new HttpError(409,'The official sign-in expired.');
  if(row.state==='complete' && row.callbackHash===callbackHash)return null;
  if(row.state!=='pending' || (row.callbackHash && row.callbackHash!==callbackHash))throw new HttpError(409,'This official sign-in was already consumed.');
  if(!row.payloadEnc.startsWith('v2.'))throw new HttpError(409,'An owner-bound authorization attempt is required.');
  const secret=secretSchema.parse(JSON.parse(decrypt(row.payloadEnc,aad(row))));
  const current=await selected(p,tx);if((current?.id??null)!==row.expectedConnectionId || (current && current.revision!==row.expectedRevision))throw new HttpError(409,'The selected official account changed.');
  if(callback.error){await tx.update(officialPlanAuthAttempts).set({state:'cancelled',callbackHash,updatedAt:new Date()}).where(eq(officialPlanAuthAttempts.id,row.id));return {cancelled:true as const};}
  const clientId=secret.clientId==='dynamic_agent_client'?callback.client_id:secret.clientId;
  if(!clientId || clientId==='dynamic_agent_client' || (secret.clientId!=='dynamic_agent_client' && callback.client_id && callback.client_id!==clientId))throw new HttpError(409,'The issued official registration is missing or changed.');
  await tx.update(officialPlanAuthAttempts).set({state:'exchanging',callbackHash,updatedAt:new Date()}).where(eq(officialPlanAuthAttempts.id,row.id));
  return {row,secret,clientId};
 });
 if(!claimed)return {connected:true};if('cancelled' in claimed)return {connected:false,cancelled:true};
 try{
  const tokens=(await oauthForm(services,OFFICIAL_TOKEN_URL,new URLSearchParams({grant_type:'authorization_code',client_id:claimed.clientId,code:callback.code!,code_verifier:claimed.secret.verifier,redirect_uri:claimed.row.redirectUri,resource:OFFICIAL_PLAN_ORIGIN})))!;
  const claims=await verifiedTokens(services,tokens,claimed.clientId,{nonce:claimed.secret.nonce,...(claimed.secret.subject?{subject:claimed.secret.subject}:{})},true);
  const prepared=await prepareOfficialPlanGrant({clientId:claimed.clientId,hostId:claimed.row.hostId,subject:claims.subject,access:tokens.access_token,refresh:tokens.refresh_token,idToken:tokens.id_token,earliestRefreshHint:tokens.earliest_refresh_at},{fetch:services.fetch,verifyAccessToken:async()=>claims});
  return await db.transaction(async tx=>{await ownerLock(tx,p);const [row]=await tx.select().from(officialPlanAuthAttempts).where(eq(officialPlanAuthAttempts.id,attemptId)).for('update');
   if(row?.state!=='exchanging' || row.callbackHash!==callbackHash || row.expiresAt.getTime()<=Date.now())throw new HttpError(409,'The official sign-in changed during exchange.');
   const result=await persistOfficialPlanGrant(p,prepared,tx,{id:row.expectedConnectionId,revision:row.expectedRevision??undefined});
   await tx.update(officialPlanAuthAttempts).set({state:'complete',updatedAt:new Date()}).where(eq(officialPlanAuthAttempts.id,attemptId));return result;});
 }catch{await db.update(officialPlanAuthAttempts).set({state:'needs_attention',updatedAt:new Date()}).where(and(eq(officialPlanAuthAttempts.id,attemptId),eq(officialPlanAuthAttempts.state,'exchanging')));throw new HttpError(409,'Official sign-in was not confirmed. Start a new sign-in instead of repeating this exchange.');}
}

export async function officialPlanAuthStatus(p:Principal){
 await principal(p);const [connection]=await db.select({status:officialPlanConnections.status,expiresAt:officialPlanConnections.expiresAt,revision:officialPlanConnections.revision,id:officialPlanConnections.id}).from(officialPlanConnections).where(and(eq(officialPlanConnections.userId,p.user.id),eq(officialPlanConnections.selected,true)));
 const operations=connection?await db.select({state:officialPlanAuthOperations.state}).from(officialPlanAuthOperations).where(and(eq(officialPlanAuthOperations.connectionId,connection.id),eq(officialPlanAuthOperations.credentialRevision,connection.revision),inArray(officialPlanAuthOperations.state,['running','needs_attention']))):[];
 const attempts=connection?await db.select({id:officialPlanAuthAttempts.id}).from(officialPlanAuthAttempts).where(and(eq(officialPlanAuthAttempts.expectedConnectionId,connection.id),eq(officialPlanAuthAttempts.expectedRevision,connection.revision),inArray(officialPlanAuthAttempts.state,['exchanging','needs_attention']))):[];
 return {connectAvailable:false,connectReason:OFFICIAL_AUTH_UNAVAILABLE,state:operations.length||attempts.length?'needs_attention':!connection?'not_connected':connection.status!=='active'||connection.expiresAt.getTime()<=Date.now()?'connection_needed':'connected'};
}

export async function cancelOfficialPlanAuth(p:Principal){return db.transaction(async tx=>{await ownerLock(tx,p);await tx.update(officialPlanAuthAttempts).set({state:'cancelled',updatedAt:new Date()}).where(and(eq(officialPlanAuthAttempts.userId,p.user.id),eq(officialPlanAuthAttempts.state,'pending')));return {cancelled:true};});}

/** Rotation/revocation receipts are durable before network I/O, so retries cannot reuse an old refresh token. */
export async function operateOfficialPlanAuth(p:Principal,kind:'refresh'|'revoke',services:OfficialAuthServices=officialAuthServices()){
 const claimed=await db.transaction(async tx=>{
  await ownerLock(tx,p);const row=await selected(p,tx);if(!row)throw new HttpError(404,'Official account not found.');
  if(kind==='revoke' && row.status==='revoked'){
   const [prior]=await tx.select({state:officialPlanAuthOperations.state}).from(officialPlanAuthOperations).where(and(eq(officialPlanAuthOperations.userId,p.user.id),eq(officialPlanAuthOperations.connectionId,row.id),eq(officialPlanAuthOperations.kind,'revoke'),eq(officialPlanAuthOperations.credentialRevision,row.revision-1)));
   // The cleared envelope is never reopened. Only the exact completed receipt proves remote logout.
   return {already:{disconnected:true as const,remoteRevocationConfirmed:prior?.state==='complete'}};
  }
  if(kind==='refresh' && row.status!=='active')throw new HttpError(409,'Reconnect the official account first.');
  const [prior]=await tx.select().from(officialPlanAuthOperations).where(and(eq(officialPlanAuthOperations.connectionId,row.id),eq(officialPlanAuthOperations.credentialRevision,row.revision),eq(officialPlanAuthOperations.kind,kind))).for('update');
  if(prior)throw new HttpError(409,'The official token operation was already claimed. Reconnect if its result is uncertain.');
  const bundle=openOfficialPlanSecret(row);if(kind==='refresh' && !bundle.refresh)throw new HttpError(409,'The official account cannot refresh yet.');
  const [operation]=await tx.insert(officialPlanAuthOperations).values({userId:p.user.id,sessionVersion:p.user.sessionVersion,connectionId:row.id,credentialRevision:row.revision,kind}).returning();
  if(kind==='revoke')await closeAccount(tx,row,'revoked');
  return {row,bundle,operation};
 });
 if('already' in claimed)return claimed.already;
 try{
  if(kind==='revoke'){
   if(!claimed.bundle.refresh)throw new HttpError(409,'No refresh grant is available to confirm remote logout.');
   await oauthForm(services,await services.verifier.revocationEndpoint(),new URLSearchParams({token:claimed.bundle.refresh,token_type_hint:'refresh_token',client_id:claimed.row.clientId}),true);
   await db.update(officialPlanAuthOperations).set({state:'complete',updatedAt:new Date()}).where(eq(officialPlanAuthOperations.id,claimed.operation.id));return {disconnected:true,remoteRevocationConfirmed:true};
  }
  const tokens=(await oauthForm(services,OFFICIAL_TOKEN_URL,new URLSearchParams({grant_type:'refresh_token',client_id:claimed.row.clientId,refresh_token:claimed.bundle.refresh!,resource:OFFICIAL_PLAN_ORIGIN})))!;
  if(!tokens.refresh_token)throw new HttpError(409,'The rotating official refresh token is missing.');
  const claims=await verifiedTokens(services,tokens,claimed.row.clientId,{subject:claimed.row.subject},false);
  const prepared=await prepareOfficialPlanGrant({clientId:claimed.row.clientId,hostId:claimed.row.hostId,subject:claims.subject,access:tokens.access_token,refresh:tokens.refresh_token,idToken:tokens.id_token??claimed.bundle.idToken,earliestRefreshHint:tokens.earliest_refresh_at},{fetch:services.fetch,verifyAccessToken:async()=>claims});
  return await db.transaction(async tx=>{await ownerLock(tx,p);await persistOfficialPlanGrant(p,prepared,tx,{id:claimed.row.id,revision:claimed.row.revision});await tx.update(officialPlanAuthOperations).set({state:'complete',updatedAt:new Date()}).where(eq(officialPlanAuthOperations.id,claimed.operation.id));return {connected:true};});
 }catch{
  await db.update(officialPlanAuthOperations).set({state:'needs_attention',updatedAt:new Date()}).where(and(eq(officialPlanAuthOperations.id,claimed.operation.id),eq(officialPlanAuthOperations.state,'running')));
  if(kind==='revoke')return {disconnected:true,remoteRevocationConfirmed:false};
  throw new HttpError(409,'Official refresh was not confirmed. Reconnect before any more model work.');
 }
}
async function closeAccount(tx:Tx,row:OfficialPlanConnection,status:'revoked'){
 const revision=row.revision+1;await tx.update(officialPlanConnections).set({status,revision,catalogRevision:revision,tokenBundleEnc:encrypt(JSON.stringify({version:1,revoked:true}),officialPlanTokenAad(row)),scopes:[],catalog:[],expiresAt:new Date(0),catalogExpiresAt:new Date(0),verifiedAt:new Date(),updatedAt:new Date()}).where(eq(officialPlanConnections.id,row.id));
}
