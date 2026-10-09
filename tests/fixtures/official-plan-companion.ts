/** Synthetic only: generated in-memory keys, mocked OpenAI, real local loopback and encrypted stdio. */
import { generateKeyPairSync, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Principal } from '@/lib/auth/groups';
import { OfficialPlanLocalCompanion, type LocalCompanionPairing } from '@/lib/hermes-team/official-plan-local-companion';
import { OfficialPlanCompanionReceiver, type ApprovedCompanionPairing } from '@/lib/hermes-team/official-plan-companion-receiver';
import { CompanionPrivateStore } from '@/lib/hermes-team/official-plan-companion-storage';
import { CompanionRpcClient, runOfficialPlanReceiver, type ApprovedLocalCompanionDriver } from '@/lib/hermes-team/official-plan-companion-stdio';
import { createOfficialPlanVerifier } from '@/lib/hermes-team/official-plan-signatures';

export async function syntheticCompanion(p: Principal, model = 'synthetic-model') {
  const root = await mkdtemp(join(tmpdir(), 'collective-companion-fixture-')), source = new CompanionPrivateStore(root);
  const vmRoot = await mkdtemp(join(tmpdir(), 'collective-companion-vm-fixture-'));
  const signing = generateKeyPairSync('ed25519'), receiverSigning = generateKeyPairSync('ed25519'), encryption = generateKeyPairSync('x25519');
  const pem = (key: ReturnType<typeof generateKeyPairSync>['publicKey']) => key.export({ format: 'pem', type: key.type === 'private' ? 'pkcs8' : 'spki' }).toString();
  const sourceHostId = `urn:uuid:${randomUUID()}`, pairingId = randomUUID(), approvedUntil = Date.now() + 86400000;
  const pairing: LocalCompanionPairing = { version: 1, pairingId, appOwnerId: p.user.id, sourceHostId, sourceSigningPrivateKey: pem(signing.privateKey), sourceSigningPublicKey: pem(signing.publicKey),
    receiverHostId: 'urn:uuid:11111111-1111-4111-8111-111111111111', receiverSigningPublicKey: pem(receiverSigning.publicKey), receiverEncryptionPublicKey: pem(encryption.publicKey), approvedUntil };
  const approved: ApprovedCompanionPairing = { pairingId, ownerId: p.user.id, sourceHostId, sourceSigningPublicKey: pairing.sourceSigningPublicKey, approvedUntil };
  const rsa = await generateKeyPair('RS256'), jwk = { ...await exportJWK(rsa.publicKey), kid: 'synthetic-companion-key', alg: 'RS256', use: 'sig' };
  const control = { principal: p, approved: true, exchangeCount: 0, access: '', refresh: '', idToken: '', nonce: '', browserUrl: '',
    tokenHook: null as null | (() => Promise<void>), catalogHook: null as null | (() => Promise<void>), tokenMutation: null as null | ((tokens: Record<string, unknown>) => void) };
  const clientId = `issued-${p.user.id}-work`, subject = `official-${p.user.id}`, scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
  const io: typeof fetch = async (url, init) => {
    const path = String(url);
    if (path.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize', token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke', id_token_signing_alg_values_supported: ['RS256'] });
    if (path.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [jwk] });
    if (path.endsWith('/oauth/token')) {
      control.exchangeCount++; await control.tokenHook?.(); const body = new URLSearchParams(String(init?.body));
      if (body.get('client_id') !== clientId || body.get('resource') !== 'https://api.openai.com/v1' || init?.redirect !== 'error') throw new Error('Synthetic contract mismatch');
      if (body.get('grant_type') === 'authorization_code') {
        const request = new URL(control.browserUrl);
        if (body.get('redirect_uri') !== request.searchParams.get('redirect_uri') || createHash('sha256').update(body.get('code_verifier')!).digest('base64url') !== request.searchParams.get('code_challenge')) throw new Error('Synthetic PKCE mismatch');
      } else if (body.get('refresh_token') !== control.refresh) throw new Error('Synthetic refresh mismatch');
      const now = Math.floor(Date.now() / 1000);
      control.access = await new SignJWT({ client_id: clientId, scope: scopes }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer('https://auth.openai.com').setAudience('https://api.openai.com/v1').setSubject(subject).setIssuedAt(now).setNotBefore(now).setExpirationTime(now + 3600).setJti(randomUUID()).sign(rsa.privateKey);
      control.idToken = await new SignJWT({ nonce: control.nonce }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer('https://auth.openai.com').setAudience(clientId).setSubject(subject).setIssuedAt(now).setExpirationTime(now + 3600).sign(rsa.privateKey);
      control.refresh = `synthetic-refresh-${p.user.id}-${randomUUID()}`;
      const tokens: Record<string, unknown> = { access_token: control.access, refresh_token: control.refresh, id_token: control.idToken, token_type: 'Bearer', expires_in: 3600, scope: scopes }; control.tokenMutation?.(tokens);
      return Response.json(tokens);
    }
    if (path === 'https://api.openai.com/v1/models') { await control.catalogHook?.(); if (new Headers(init?.headers).get('authorization') !== `Bearer ${control.access}`) throw new Error('Synthetic bearer mismatch'); return Response.json({ models: [{ slug: model, visibility: 'list' }] }); }
    if (path.endsWith('/oauth/revoke')) return new Response(null);
    throw new Error('External network refused by synthetic fixture');
  };
  const local = new OfficialPlanLocalCompanion(source, pairing, io);
  const receiver = new OfficialPlanCompanionReceiver({ hostId: pairing.receiverHostId, signingPrivateKey: pem(receiverSigning.privateKey), encryptionPrivateKey: pem(encryption.privateKey), privateRoot: vmRoot,
    getPrincipal: async () => control.principal, approvedPairing: async id => control.approved && id === pairingId ? approved : null }, { fetch: io, verifier: createOfficialPlanVerifier(io) });
  const browser = async (url: string) => {
    control.browserUrl = url; const auth = new URL(url); control.nonce = auth.searchParams.get('nonce')!;
    const callback = new URL(auth.searchParams.get('redirect_uri')!); callback.searchParams.set('state', auth.searchParams.get('state')!); callback.searchParams.set('code', 'synthetic-local-code'); callback.searchParams.set('client_id', clientId);
    await fetch(callback).then(response => response.text());
  };
  const transports: { a: PassThrough; b: PassThrough; done: Promise<void> }[] = [];
  const connect = async () => {
    const a = new PassThrough(), b = new PassThrough(), done = runOfficialPlanReceiver(a, b, receiver); transports.push({ a, b, done });
    return { client: new CompanionRpcClient(b, a), close: () => { a.end(); } };
  };
  const driver: ApprovedLocalCompanionDriver = { id: 'synthetic-approved-installation', local: async () => local, openBrowser: browser, connect };
  return { local, receiver, source, pairing, approved, control, browser, io, driver, root, vmRoot, clientId, subject,
    dispose: async () => { for (const t of transports) { t.a.end(); await t.done; t.b.end(); } await rm(root, { recursive: true, force: true }); await rm(vmRoot, { recursive: true, force: true }); } };
}
