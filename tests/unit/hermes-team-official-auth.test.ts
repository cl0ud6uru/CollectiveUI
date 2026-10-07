import { readFileSync,readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import type { Principal } from '@/lib/auth/groups';
import { exportJWK,generateKeyPair,SignJWT } from 'jose';
const fixture=vi.hoisted(()=>({client:null as PGlite|null}));
vi.mock('server-only',()=>({}));
vi.mock('@/db',async()=>{const {PGlite}=await import('@electric-sql/pglite');const {drizzle}=await import('drizzle-orm/pglite');const schema=await import('@/db/schema');fixture.client=new PGlite();return {db:drizzle(fixture.client,{schema}),schema};});
import { db,schema } from '@/db';
import { loadPrincipal } from '@/lib/auth/groups';
import { OFFICIAL_PLAN_ORIGIN,officialPlanMetadata,openOfficialPlanSecret,type VerifiedOfficialAccessClaims } from '@/lib/hermes-team/official-plan';
import { cancelOfficialPlanAuth,startOfficialPlanAuth,returnOfficialPlanAuth,operateOfficialPlanAuth,officialLoopbackUri,OFFICIAL_TOKEN_URL,VERIFIED_OFFICIAL_LOOPBACK_TRANSPORTS,type OfficialAuthServices } from '@/lib/hermes-team/official-plan-auth';
import { createOfficialPlanAuthHttp,officialPlanReturnHttp } from '@/lib/hermes-team/official-plan-auth-http';
import { createOfficialPlanVerifier } from '@/lib/hermes-team/official-plan-signatures';
let alice:Principal,bob:Principal;
const returns=new Map<string,string>();
let services:OfficialAuthServices;
const fetcher=vi.fn<typeof fetch>();
const claims=(subject='synthetic-alice',clientId='issued-synthetic-client'):VerifiedOfficialAccessClaims=>({issuer:'https://auth.openai.com',audience:OFFICIAL_PLAN_ORIGIN,subject,clientId,scopes:['openid','profile','chatgpt.tokens.use.direct','resource.invoke'],issuedAt:Date.now()-1000,notBefore:Date.now()-1000,expiresAt:Date.now()+3500000});
const tokenResponse=()=>({access_token:'synthetic-access',refresh_token:'synthetic-refresh',id_token:'synthetic-id',token_type:'Bearer',expires_in:3500,scope:'openid profile chatgpt.tokens.use.direct resource.invoke'});
const request=(body:unknown,origin='https://app.test.invalid')=>new Request('https://app.test.invalid/api/account/official-plan',{method:'POST',headers:{'Content-Type':'application/json',origin},body:JSON.stringify(body)});
async function begin(p=alice,reauth=false){const result=await startOfficialPlanAuth(p,reauth,services);const url=new URL(result.authorizationUrl);return {...result,url,authorization:`Bearer ${returns.get(result.attemptId)}`,callback:{state:url.searchParams.get('state')!,code:'synthetic-code',client_id:'issued-synthetic-client'}};}
async function connect(){const attempt=await begin();expect(await returnOfficialPlanAuth(attempt.attemptId,attempt.authorization,attempt.callback,services)).toEqual({connected:true});return attempt;}
beforeAll(async()=>{await fixture.client!.waitReady;for(const file of readdirSync('src/db/migrations').filter(f=>f.endsWith('.sql')).sort())await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`,'utf8').replace('CREATE EXTENSION IF NOT EXISTS vector;','').replace(/\bvector\b/g,'real[]'));},45000);
beforeEach(async()=>{
 vi.restoreAllMocks();vi.stubEnv('ENCRYPTION_KEY','synthetic-official-auth-fixture-only');vi.stubEnv('AUTH_URL','https://app.test.invalid');returns.clear();fetcher.mockReset();
 await fixture.client!.exec('TRUNCATE users CASCADE');await db.insert(schema.users).values([{id:'alice',upn:'alice@test.invalid',name:'Alice',authSource:'local',identityRealm:'local'},{id:'bob',upn:'bob@test.invalid',name:'Bob',authSource:'local',identityRealm:'local'}]);alice=(await loadPrincipal('alice'))!;bob=(await loadPrincipal('bob'))!;
 services={fetch:fetcher,transports:[{id:'synthetic-verified-loopback',prepare:vi.fn(async(p,input)=>{returns.set(input.attemptId,input.returnToken);return {hostId:`synthetic-host-${p.user.id}`,redirectUri:'http://127.0.0.1:1455/auth/callback'};})}],verifier:{verifyAccessToken:vi.fn(async()=>claims()),verifyIdToken:vi.fn(async()=>({subject:'synthetic-alice'})),revocationEndpoint:vi.fn(async()=> 'https://auth.openai.com/api/accounts/oauth/revoke')}};
 fetcher.mockImplementation(async(url,init)=>{expect(init?.redirect).toBe('error');if(String(url).endsWith('/models')){expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-access');return Response.json({models:[{slug:'synthetic-model',visibility:'list'}]});}if(String(url).endsWith('/revoke'))return new Response(null);expect(String(url)).toBe(OFFICIAL_TOKEN_URL);return Response.json(tokenResponse());});
});
afterAll(async()=>{await fixture.client!.close();vi.unstubAllEnvs();});

describe('Dormant exact official loopback OAuth controllers and durable rotating tokens',()=>{
 it('keeps production connect/refresh/return unavailable without a verified return transport, before rows or network',async()=>{
  expect(VERIFIED_OFFICIAL_LOOPBACK_TRANSPORTS).toEqual([]);const dormant={...services,transports:[]};const http=createOfficialPlanAuthHttp(async()=>alice,dormant);
  for(const action of ['connect','reconnect','refresh','disconnect'])expect((await http.POST(request({action}))).status).toBe(409);
  expect((await officialPlanReturnHttp(request({state:'x',code:'x'}),'unknown',dormant)).status).toBe(409);
  expect(await db.select().from(schema.officialPlanAuthAttempts)).toEqual([]);expect(fetcher).not.toHaveBeenCalled();expect(await (await http.GET()).json()).toMatchObject({connectAvailable:false,state:'not_connected'});
 });
 it('uses fresh PKCE/state/nonce and exchanges only the issued registration with the exact loopback URI',async()=>{
  const attempt=await begin();expect(attempt.url.origin+attempt.url.pathname).toBe('https://auth.openai.com/api/accounts/authorize');expect(attempt.url.searchParams.get('client_id')).toBe('dynamic_agent_client');expect(attempt.url.searchParams.get('code_challenge_method')).toBe('S256');expect(attempt.url.searchParams.get('agent_name_hint')).toBe('CollectiveUI');
  const row=(await db.select().from(schema.officialPlanAuthAttempts))[0];expect(JSON.stringify(row)).not.toContain(attempt.url.searchParams.get('nonce'));expect(JSON.stringify(row)).not.toContain(attempt.url.searchParams.get('state'));expect(JSON.stringify(row)).not.toContain(returns.get(row.id));
  expect(await returnOfficialPlanAuth(attempt.attemptId,attempt.authorization,attempt.callback,services)).toEqual({connected:true});
  const exchange=new URLSearchParams(String(fetcher.mock.calls[0][1]!.body));expect(exchange.get('client_id')).toBe('issued-synthetic-client');expect(exchange.get('redirect_uri')).toBe('http://127.0.0.1:1455/auth/callback');expect(exchange.get('resource')).toBe(OFFICIAL_PLAN_ORIGIN);expect(exchange.get('scope')).toBeNull();expect(exchange.get('client_secret')).toBeNull();
  expect(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url')).toBe(attempt.url.searchParams.get('code_challenge'));
  expect(services.verifier.verifyIdToken).toHaveBeenCalledWith('synthetic-id',{clientId:'issued-synthetic-client',nonce:attempt.url.searchParams.get('nonce')});
  const account=(await db.select().from(schema.officialPlanConnections))[0];expect(account).toMatchObject({userId:'alice',clientId:'issued-synthetic-client',subject:'synthetic-alice',revision:1});expect(openOfficialPlanSecret(account).refresh).toBe('synthetic-refresh');expect(account.tokenBundleEnc).not.toContain('synthetic-refresh');
 });
 it('runs the production callback through actual signed ID/access JWT discovery verification and owner catalog ingestion',async()=>{
  const attempt=await begin(),keys=await generateKeyPair('RS256'),publicKey={...await exportJWK(keys.publicKey),kid:'synthetic-auth-key',alg:'RS256',use:'sig'};
  const seconds=Math.floor(Date.now()/1000),common={iss:'https://auth.openai.com',sub:'synthetic-alice',iat:seconds-1,nbf:seconds-1,exp:seconds+3500};
  const sign=(payload:Record<string,unknown>)=>new SignJWT(payload).setProtectedHeader({alg:'RS256',kid:'synthetic-auth-key'}).sign(keys.privateKey);
  const access=await sign({...common,aud:OFFICIAL_PLAN_ORIGIN,client_id:'issued-synthetic-client',scope:'openid chatgpt.tokens.use.direct resource.invoke'}),identity=await sign({...common,aud:'issued-synthetic-client',nonce:attempt.url.searchParams.get('nonce')});
  const io=vi.fn<typeof fetch>().mockImplementation(async(url,init)=>{
   if(String(url).endsWith('/openid-configuration'))return Response.json({issuer:'https://auth.openai.com',authorization_endpoint:'https://auth.openai.com/api/accounts/authorize',token_endpoint:OFFICIAL_TOKEN_URL,jwks_uri:'https://auth.openai.com/.well-known/jwks.json'});
   if(String(url).endsWith('/jwks.json'))return Response.json({keys:[publicKey]});
   if(String(url).endsWith('/models')){expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${access}`);return Response.json({models:[{slug:'synthetic-model',visibility:'list'}]});}
   return Response.json({...tokenResponse(),access_token:access,id_token:identity});
  });
  const real={...services,fetch:io,verifier:createOfficialPlanVerifier(io)};
  expect(await returnOfficialPlanAuth(attempt.attemptId,attempt.authorization,attempt.callback,real)).toEqual({connected:true});expect(await officialPlanMetadata('alice','synthetic-model')).toBeTruthy();
  expect(io.mock.calls.every(([url])=>String(url).startsWith('https://auth.openai.com/')||String(url).startsWith(`${OFFICIAL_PLAN_ORIGIN}/`))).toBe(true);
 });
 it('makes an identical completed callback harmless and rejects changed callback replay without another exchange',async()=>{
  const attempt=await connect();expect(await returnOfficialPlanAuth(attempt.attemptId,attempt.authorization,attempt.callback,services)).toEqual({connected:true});await expect(returnOfficialPlanAuth(attempt.attemptId,attempt.authorization,{...attempt.callback,code:'changed'},services)).rejects.toMatchObject({status:409});expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it.each(['state','return-token','registration','session'] as const)('refuses %s tampering before token I/O',async(kind)=>{
  const attempt=await begin();if(kind==='session')await db.update(schema.users).set({sessionVersion:1}).where(eq(schema.users.id,'alice'));
  await expect(returnOfficialPlanAuth(attempt.attemptId,kind==='return-token'?`Bearer ${'a'.repeat(43)}`:attempt.authorization,{...attempt.callback,...(kind==='state'?{state:'wrong'}:{}),...(kind==='registration'?{client_id:'dynamic_agent_client'}:{})},services)).rejects.toMatchObject({status:kind==='registration'?409:403});expect(fetcher).not.toHaveBeenCalled();
 });
 it('checks a denial return state and cancels without token exchange',async()=>{
  const attempt=await begin();expect(await returnOfficialPlanAuth(attempt.attemptId,attempt.authorization,{state:attempt.callback.state,error:'access_denied'},services)).toEqual({connected:false,cancelled:true});expect(fetcher).not.toHaveBeenCalled();expect((await db.select().from(schema.officialPlanAuthAttempts))[0].state).toBe('cancelled');
 });
 it('uses the retained registration and subject for reconnect and refuses foreign callback registration',async()=>{
  await connect();const attempt=await begin(alice,true);expect(attempt.url.searchParams.get('client_id')).toBe('issued-synthetic-client');expect(attempt.url.searchParams.has('agent_name_hint')).toBe(false);
  await expect(returnOfficialPlanAuth(attempt.attemptId,attempt.authorization,{...attempt.callback,client_id:'foreign'},services)).rejects.toMatchObject({status:409});expect(fetcher).toHaveBeenCalledTimes(2);
  const {client_id:_issued,...withoutClient}=attempt.callback;void _issued;expect(await returnOfficialPlanAuth(attempt.attemptId,attempt.authorization,withoutClient,services)).toEqual({connected:true});expect((await db.select().from(schema.officialPlanConnections))[0].revision).toBe(2);expect(services.verifier.verifyIdToken).toHaveBeenLastCalledWith('synthetic-id',{clientId:'issued-synthetic-client',nonce:attempt.url.searchParams.get('nonce'),subject:'synthetic-alice'});
 });
 it('serializes double callbacks before provider I/O and never retries a crashed exchanging receipt',async()=>{
  const attempt=await begin();await db.update(schema.officialPlanAuthAttempts).set({state:'exchanging',callbackHash:'a'.repeat(64)}).where(eq(schema.officialPlanAuthAttempts.id,attempt.attemptId));
  await expect(returnOfficialPlanAuth(attempt.attemptId,attempt.authorization,attempt.callback,services)).rejects.toMatchObject({status:409});expect(fetcher).not.toHaveBeenCalled();await expect(db.update(schema.officialPlanAuthAttempts).set({state:'pending'})).rejects.toThrow();
 });
 it('rejects a transplanted encrypted attempt and terminal expiry before code exchange',async()=>{
  const a=await begin(),aRow=(await db.select().from(schema.officialPlanAuthAttempts))[0];await cancelOfficialPlanAuth(alice);const b=await begin(bob);
  await fixture.client!.exec('ALTER TABLE official_plan_auth_attempts DISABLE TRIGGER official_plan_auth_attempt_immutable');
  try{await db.update(schema.officialPlanAuthAttempts).set({payloadEnc:aRow.payloadEnc}).where(eq(schema.officialPlanAuthAttempts.id,b.attemptId));}finally{await fixture.client!.exec('ALTER TABLE official_plan_auth_attempts ENABLE TRIGGER official_plan_auth_attempt_immutable');}
  await expect(returnOfficialPlanAuth(b.attemptId,b.authorization,b.callback,services)).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
  vi.spyOn(Date,'now').mockReturnValue(Date.now()+600001);await expect(returnOfficialPlanAuth(a.attemptId,a.authorization,a.callback,services)).rejects.toMatchObject({status:409});expect(fetcher).not.toHaveBeenCalled();
 });
 it('claims concurrent callbacks exactly once before a deferred token exchange',async()=>{
  const attempt=await begin();let proceed!:(value:Response)=>void;let reached!:()=>void;
  const ready=new Promise<void>(resolve=>{reached=resolve;});const deferred=new Promise<Response>(resolve=>{proceed=resolve;});const base=fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async(...args)=>{if(String(args[0])===OFFICIAL_TOKEN_URL){reached();return deferred;}return base(...args);});
  const first=returnOfficialPlanAuth(attempt.attemptId,attempt.authorization,attempt.callback,services);await ready;
  await expect(returnOfficialPlanAuth(attempt.attemptId,attempt.authorization,attempt.callback,services)).rejects.toMatchObject({status:409});expect(fetcher).toHaveBeenCalledOnce();proceed(Response.json(tokenResponse()));expect(await first).toEqual({connected:true});expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('does not overwrite a selected account or invalidated session changed during exchange',async()=>{
  await connect();const attempt=await begin(alice,true);const base=fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async(...args)=>{if(String(args[0])===OFFICIAL_TOKEN_URL)await db.update(schema.users).set({sessionVersion:1}).where(eq(schema.users.id,'alice'));return base(...args);});
  await expect(returnOfficialPlanAuth(attempt.attemptId,attempt.authorization,attempt.callback,services)).rejects.toMatchObject({status:409});expect((await db.select().from(schema.officialPlanConnections))[0].revision).toBe(1);await expect(officialPlanMetadata('alice','synthetic-model')).rejects.toMatchObject({status:409});
 });
 it('bounds an upstream token body that ignores abort and records uncertain exchange without a paid repeat',async()=>{
  const attempt=await begin();const immediate=setImmediate;vi.useFakeTimers();let bodyCancelled=false;
  fetcher.mockResolvedValue(new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){bodyCancelled=true;}}),{headers:{'content-type':'application/json'}}));
  try{const operation=returnOfficialPlanAuth(attempt.attemptId,attempt.authorization,attempt.callback,services);const assertion=expect(operation).rejects.toMatchObject({status:409});
   for(let i=0;i<100 && !fetcher.mock.calls.length;i++)await new Promise(resolve=>immediate(resolve));
   expect(fetcher).toHaveBeenCalledOnce();await vi.advanceTimersByTimeAsync(8001);await assertion;expect(bodyCancelled).toBe(true);expect((await db.select().from(schema.officialPlanAuthAttempts))[0].state).toBe('needs_attention');
  }finally{vi.useRealTimers();}
 });
 it.each(['signature','scope','catalog','unknown-network'] as const)('records %s uncertainty without replaying the code or exposing upstream values',async(kind)=>{
  const attempt=await begin();if(kind==='signature')vi.mocked(services.verifier.verifyIdToken).mockRejectedValue(new Error('synthetic-id-secret'));if(kind==='scope')fetcher.mockResolvedValueOnce(Response.json({...tokenResponse(),scope:'openid'}));if(kind==='catalog')fetcher.mockImplementation(async(url)=>String(url).endsWith('/models')?Response.json({models:[]}):Response.json(tokenResponse()));if(kind==='unknown-network')fetcher.mockRejectedValue(new Error('synthetic-provider-secret'));
  await expect(returnOfficialPlanAuth(attempt.attemptId,attempt.authorization,attempt.callback,services)).rejects.toMatchObject({status:409});expect((await db.select().from(schema.officialPlanAuthAttempts))[0].state).toBe('needs_attention');const count=fetcher.mock.calls.length;await expect(returnOfficialPlanAuth(attempt.attemptId,attempt.authorization,attempt.callback,services)).rejects.toMatchObject({status:409});expect(fetcher).toHaveBeenCalledTimes(count);expect(await db.select().from(schema.officialPlanConnections)).toHaveLength(0);
 });
 it('keeps owner status private and verifies CSRF/strict action payloads at the real controller seam',async()=>{
  await connect();const http=createOfficialPlanAuthHttp(async()=>bob,services);expect(await (await http.GET()).json()).toMatchObject({state:'not_connected',connectAvailable:false});const own=createOfficialPlanAuthHttp(async()=>alice,services);const text=await (await own.GET()).text();expect(text).not.toMatch(/issued-synthetic|synthetic-alice|synthetic-host|access|refresh/);
  for(const req of [request({action:'refresh'},'https://foreign.test.invalid'),request({action:'refresh',connectionId:'foreign'}),request({action:'refresh',access_token:'malicious'})])expect((await own.POST(req)).status).toBeGreaterThanOrEqual(400);expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('rotates refresh once atomically without scope, dynamic client or company fallback',async()=>{
  await connect();fetcher.mockClear();fetcher.mockImplementation(async(url,init)=>{if(String(url).endsWith('/models'))return Response.json({models:[{slug:'synthetic-model',visibility:'list'}]});const form=new URLSearchParams(String(init!.body));expect(form.get('grant_type')).toBe('refresh_token');expect(form.get('client_id')).toBe('issued-synthetic-client');expect(form.get('refresh_token')).toBe('synthetic-refresh');expect(form.has('scope')).toBe(false);return Response.json({...tokenResponse(),access_token:'synthetic-rotated-access',refresh_token:'synthetic-rotated-refresh'});});
  expect(await operateOfficialPlanAuth(alice,'refresh',services)).toEqual({connected:true});const row=(await db.select().from(schema.officialPlanConnections))[0];expect(row.revision).toBe(2);expect(openOfficialPlanSecret(row).refresh).toBe('synthetic-rotated-refresh');expect((await db.select().from(schema.officialPlanAuthOperations))[0]).toMatchObject({credentialRevision:1,state:'complete'});expect(await officialPlanMetadata('alice','synthetic-model')).toBeTruthy();
 });
 it('retains an undocumented earliest-refresh hint privately without guessing its units or scheduling a token exchange',async()=>{
  const attempt=await begin();fetcher.mockResolvedValueOnce(Response.json({...tokenResponse(),earliest_refresh_at:'synthetic-opaque-timing-hint'}));expect(await returnOfficialPlanAuth(attempt.attemptId,attempt.authorization,attempt.callback,services)).toEqual({connected:true});
  const row=(await db.select().from(schema.officialPlanConnections))[0];expect(openOfficialPlanSecret(row).earliestRefreshHint).toBe('synthetic-opaque-timing-hint');expect(await (await createOfficialPlanAuthHttp(async()=>alice,services).GET()).text()).not.toContain('timing-hint');expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('persists unknown refresh attribution and pauses all model admission/new refresh nonces until reconnect',async()=>{
  await connect();fetcher.mockClear();fetcher.mockRejectedValue(new Error('synthetic unknown rotation'));
  await expect(operateOfficialPlanAuth(alice,'refresh',services)).rejects.toMatchObject({status:409});await expect(operateOfficialPlanAuth(alice,'refresh',services)).rejects.toMatchObject({status:409});expect(fetcher).toHaveBeenCalledOnce();await expect(officialPlanMetadata('alice','synthetic-model')).rejects.toMatchObject({status:409});expect((await db.select().from(schema.officialPlanAuthOperations))[0].state).toBe('needs_attention');
 });
 it('marks a lost refresh receipt unresolved before network and never reuses its old token',async()=>{
  await connect();const row=(await db.select().from(schema.officialPlanConnections))[0];await db.insert(schema.officialPlanAuthOperations).values({userId:'alice',connectionId:row.id,credentialRevision:row.revision,sessionVersion:0,kind:'refresh'});fetcher.mockClear();await expect(operateOfficialPlanAuth(alice,'refresh',services)).rejects.toMatchObject({status:409});await expect(officialPlanMetadata('alice','synthetic-model')).rejects.toMatchObject({status:409});expect(fetcher).not.toHaveBeenCalled();
 });
 it('clears only the owner secret before remote revoke and truthfully records an unconfirmed remote result',async()=>{
  await connect();fetcher.mockClear();fetcher.mockRejectedValue(new Error('synthetic unavailable revoke'));expect(await operateOfficialPlanAuth(alice,'revoke',services)).toEqual({disconnected:true,remoteRevocationConfirmed:false});const row=(await db.select().from(schema.officialPlanConnections))[0];expect(row.status).toBe('revoked');expect(()=>openOfficialPlanSecret(row)).toThrow();await expect(officialPlanMetadata('alice','synthetic-model')).rejects.toMatchObject({status:409});expect((await db.select().from(schema.officialPlanAuthOperations))[0]).toMatchObject({kind:'revoke',state:'needs_attention'});expect(fetcher).toHaveBeenCalledOnce();
  expect(await operateOfficialPlanAuth(alice,'revoke',services)).toEqual({disconnected:true,remoteRevocationConfirmed:false});expect(fetcher).toHaveBeenCalledOnce();
 });
 it('handles concurrent and completed disconnect replay without decrypting the cleared envelope or repeating remote I/O',async()=>{
  await connect();fetcher.mockClear();let reached!:()=>void;let finish!:(value:Response)=>void;const ready=new Promise<void>(resolve=>{reached=resolve;}),deferred=new Promise<Response>(resolve=>{finish=resolve;});
  fetcher.mockImplementation(async()=>{reached();return deferred;});const first=operateOfficialPlanAuth(alice,'revoke',services);await ready;
  expect(await operateOfficialPlanAuth(alice,'revoke',services)).toEqual({disconnected:true,remoteRevocationConfirmed:false});await expect(operateOfficialPlanAuth(bob,'revoke',services)).rejects.toMatchObject({status:404});expect(fetcher).toHaveBeenCalledOnce();
  finish(new Response(null));expect(await first).toEqual({disconnected:true,remoteRevocationConfirmed:true});expect(await operateOfficialPlanAuth(alice,'revoke',services)).toEqual({disconnected:true,remoteRevocationConfirmed:true});expect(fetcher).toHaveBeenCalledOnce();expect(await db.select().from(schema.officialPlanAuthOperations)).toHaveLength(1);
 });
 it('enforces immutable attempt/operation identity and keeps another owner from deleting or selecting it',async()=>{
  const attempt=await connect();await expect(db.update(schema.officialPlanAuthAttempts).set({userId:'bob'}).where(eq(schema.officialPlanAuthAttempts.id,attempt.attemptId))).rejects.toThrow();await expect(operateOfficialPlanAuth(bob,'refresh',services)).rejects.toMatchObject({status:404});
  const row=(await db.select().from(schema.officialPlanConnections))[0];await expect(db.insert(schema.officialPlanAuthOperations).values({userId:'bob',connectionId:row.id,credentialRevision:row.revision,sessionVersion:0,kind:'refresh'})).rejects.toThrow();
  const before=fetcher.mock.calls.length;await db.update(schema.users).set({sessionVersion:1}).where(eq(schema.users.id,'alice'));await expect(operateOfficialPlanAuth(alice,'refresh',services)).rejects.toMatchObject({status:403});expect(fetcher).toHaveBeenCalledTimes(before);
 });
 it('bounds attempts and rejects invented HTTPS, localhost, paths and pasted callback alternatives',async()=>{
  for(const uri of ['https://app.test.invalid/auth/callback','http://localhost:1455/auth/callback','http://127.0.0.1:1455/other','http://127.0.0.1:1455/auth/callback?code=x','http://user@127.0.0.1:1455/auth/callback'])expect(()=>officialLoopbackUri(uri)).toThrow();
  const first=await begin();await expect(begin()).rejects.toMatchObject({status:409});expect(fetcher).not.toHaveBeenCalled();await cancelOfficialPlanAuth(alice);const second=await begin();expect(second.url.searchParams.get('state')).not.toBe(first.url.searchParams.get('state'));expect(second.url.searchParams.get('nonce')).not.toBe(first.url.searchParams.get('nonce'));expect(second.url.searchParams.get('code_challenge')).not.toBe(first.url.searchParams.get('code_challenge'));
  for(let i=0;i<3;i++){await cancelOfficialPlanAuth(alice);await begin();}await cancelOfficialPlanAuth(alice);await expect(begin()).rejects.toMatchObject({status:409});
 });
});
