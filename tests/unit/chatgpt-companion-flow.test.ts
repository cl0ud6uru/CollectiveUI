import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
vi.mock('@/lib/hermes-team/official-plan-signatures', () => ({ createOfficialPlanVerifier: () => ({
  verifyIdToken: async (_token: string, options: { clientId: string; nonce?: string; subject?: string }) => { if (options.subject && options.subject !== 'subject-alice') throw new Error('wrong subject'); return { subject: 'subject-alice' }; },
  revocationEndpoint: async () => 'https://auth.openai.com/api/accounts/oauth/revoke',
  verifyAccessToken: async () => ({ subject: 'subject-alice', clientId: 'issued-client', scopes: ['resource.invoke','chatgpt.tokens.use.direct'], expiresAt: Date.now() + 3600000 }),
}) }));
import { runCompanion } from '@/chatgpt-companion/client';
import type { LocalCompanionStore } from '@/lib/hermes-team/official-plan-local-companion';
import { signTranscript, transcriptDigest, openCompanionPayload, type CompanionTicket } from '@/lib/hermes-team/official-plan-companion-protocol';
class MemoryStore implements LocalCompanionStore { values = new Map<string, unknown>(); busy = false; async read(n: string) { return this.values.get(n) ?? null; } async write(n: string, v: unknown) { this.values.set(n,v); } async locked<T>(op: () => Promise<T>) { if (this.busy) throw new Error('locked'); this.busy = true; try { return await op(); } finally { this.busy = false; } } async isLocked() { return this.busy; } }
function fixture({ lostAck = false, cancel = false, registration = false, revocationFails = false } = {}) {
  const origin = 'https://collective.example', attemptId = randomUUID(), hostId = `urn:uuid:${randomUUID()}`;
  const signing = generateKeyPairSync('ed25519'), encryption = generateKeyPairSync('x25519');
  const signingPrivate = signing.privateKey.export({ format:'pem', type:'pkcs8' }).toString();
  const globalStore = new MemoryStore(), store = new MemoryStore(); let pair: Record<string, unknown>, ticket: CompanionTicket, ack: unknown, paired = false;
  const counts = { oauth:0, receive:0, recover:0, refresh:0, redeemed:0, revoke:0 }; let cancelled = false, refuseChallenge = false;
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('/revoke')) { counts.revoke++; return new Response(null, { status: revocationFails ? 503 : 200 }); }
    if (String(url).includes('auth.openai.com')) {
      const form = new URLSearchParams(String(init?.body)); if (form.get('grant_type') === 'refresh_token') counts.refresh++;
      return Response.json({ access_token:'synthetic-access',refresh_token:'synthetic-refresh',id_token:'synthetic-id',token_type:'Bearer',expires_in:3600,scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' });
    }
    const b = JSON.parse(String(init?.body));
    if (b.action === 'redeem') {
      counts.redeemed++; paired = true;
      pair = { version:1,pairingId:attemptId,appOwnerId:'alice',sourceHostId:b.sourceHostId,sourceSigningPublicKey:b.sourceSigningPublicKey,receiverHostId:hostId,
        receiverSigningPublicKey:signing.publicKey.export({format:'pem',type:'spki'}).toString(),receiverEncryptionPublicKey:encryption.publicKey.export({format:'pem',type:'spki'}).toString(),approvedUntil:Date.now()+86400000 };
      return Response.json({ origin,ownerId:'alice',email:'alice@example.test',returnToken:'r'.repeat(43),expiresAt:Date.now()+600000,pairing:pair,...(registration ? {registration:{clientId:'issued-client',subject:'subject-alice'}}:{}) });
    }
    expect((init?.headers as Record<string,string>).authorization).toBe(`Companion ${'r'.repeat(43)}`);
    if (b.action === 'status') return Response.json({state:cancelled?'cancelled':ack?'complete':paired?'paired':'created'});
    if (b.action === 'cancel') { cancelled = true; return Response.json({ cancelled: true }); }
    if (b.action === 'challenge') {
      if (refuseChallenge) throw new Error('synthetic pre-custody network failure');
      const snapshot = b.input, pairRecord = { pairingId:attemptId,ownerId:'alice',sourceHostId:pair.sourceHostId,sourceSigningPublicKey:pair.sourceSigningPublicKey,approvedUntil:pair.approvedUntil };
      ticket = {version:1,pairingId:attemptId,transferId:randomUUID(),ownerId:'alice',sessionVersion:0,sourceHostId:String(pair.sourceHostId),destinationHostId:hostId,transportId:'collective-companion-v1',
        clientId:'issued-client',subject:'subject-alice',snapshotDigest:transcriptDigest(snapshot),credentialDigest:snapshot.body.credentialDigest,pairingDigest:transcriptDigest(pairRecord),createdAt:Date.now(),expiresAt:Date.now()+600000};
      return Response.json(signTranscript(ticket, signingPrivate));
    }
    if (b.action === 'receive') {
      counts.receive++; const payload = openCompanionPayload(b.input,encryption.privateKey.export({format:'pem',type:'pkcs8'}).toString(),String(pair.sourceSigningPublicKey));
      ack = signTranscript({version:1,ticketDigest:transcriptDigest(ticket),custodyDigest:transcriptDigest(payload.custody),state:'complete',at:Date.now()},signingPrivate);
      if (lostAck) { lostAck = false; throw new Error('synthetic lost acknowledgment'); } return Response.json(ack);
    }
    if (b.action === 'recover') { counts.recover++; if (cancelled) throw new Error('synthetic unavailable signed recovery'); return Response.json(ack); }
    throw new Error('unexpected request');
  };
  const openBrowser = vi.fn(async (value: string) => {
    counts.oauth++; const u = new URL(value);
    expect(u.searchParams.get('client_id')).toBe(registration?'issued-client':'dynamic_agent_client');
    expect(u.searchParams.has('agent_name_hint')).toBe(!registration);
    if (cancel) { cancelled = true; return; }
    const callback = new URL(u.searchParams.get('redirect_uri')!); callback.searchParams.set('state',u.searchParams.get('state')!);callback.searchParams.set('code','synthetic-code');if(!registration)callback.searchParams.set('client_id','issued-client');
    expect((await fetch(callback)).status).toBe(200);
  });
  const options = { approvedOrigins:[origin],globalStore,attemptStore:()=>store,confirm:async()=>true,openBrowser,returnToApp:vi.fn(async()=>{}),fetcher:fetcher as typeof fetch,pollMs:5 };
  return {options,store,counts, setRefuseChallenge: (value: boolean) => { refuseChallenge = value; }, setCancelled: () => { cancelled = true; }, launch:`collectiveui-chatgpt://connect?origin=${encodeURIComponent(origin)}&attempt=${attemptId}&ticket=${'t'.repeat(43)}`};
}
describe('synthetic native OAuth and encrypted custody flow', () => {
  it('accepts access JWT resource scopes separately from full grant scopes and removes local tokens after complete', async () => {
    const f = fixture(); expect(await runCompanion(f.launch,f.options)).toEqual({connected:true});
    expect(f.counts).toMatchObject({oauth:1,receive:1,refresh:0});expect(JSON.stringify(f.store.values.get('journal.json'))).not.toContain('synthetic-refresh');
    expect(f.options.returnToApp).toHaveBeenCalledWith('https://collective.example/settings?tab=connected-accounts');
  });
  it('uses retained account registration without another dynamic registration', async () => {
    const f=fixture({registration:true});await runCompanion(f.launch,f.options);expect(f.counts.oauth).toBe(1);
  });
  it('recovers lost acknowledgment without repeating OAuth or sending credentials again', async () => {
    const f=fixture({lostAck:true});await expect(runCompanion(f.launch,f.options)).rejects.toThrow();
    expect((f.store.values.get('journal.json') as {body:{phase:string}}).body.phase).toBe('suspended');
    expect(await runCompanion(f.launch,f.options)).toEqual({connected:true});expect(f.counts).toEqual({oauth:1,receive:1,recover:1,refresh:0,redeemed:1,revoke:0});
  });
  it('native Cancel revokes and removes a pre-custody local active grant without refresh or replay', async () => {
    const f = fixture(); f.setRefuseChallenge(true); await expect(runCompanion(f.launch, f.options)).rejects.toThrow();
    expect((f.store.values.get('journal.json') as {body:{phase:string}}).body.phase).toBe('active');
    f.options.confirm = async () => false;
    expect(await runCompanion(f.launch, f.options)).toEqual({ connected: false });
    expect(f.counts).toMatchObject({ oauth: 1, receive: 0, refresh: 0, revoke: 1 });
    expect(JSON.stringify(f.store.values.get('journal.json'))).not.toContain('synthetic-refresh');
    expect((f.store.values.get('journal.json') as {body:{phase:string}}).body.phase).toBe('empty');
  });
  it('unconfirmed pre-custody revocation still removes local token retention without claiming success', async () => {
    const f = fixture({ revocationFails: true }); f.setRefuseChallenge(true); await expect(runCompanion(f.launch, f.options)).rejects.toThrow();
    f.options.confirm = async () => false; await expect(runCompanion(f.launch, f.options)).rejects.toThrow();
    expect(f.counts).toMatchObject({ oauth: 1, receive: 0, refresh: 0, revoke: 1 });
    expect(JSON.stringify(f.store.values.get('journal.json'))).not.toContain('synthetic-refresh');
  });
  it('cached redemption checks cancellation before another prompt and cleans only pre-custody grants', async () => {
    const f=fixture(); f.setRefuseChallenge(true); await expect(runCompanion(f.launch,f.options)).rejects.toThrow(); f.setCancelled();
    const confirmation = vi.fn(async () => true); f.options.confirm = confirmation;
    await expect(runCompanion(f.launch,f.options)).rejects.toThrow(); expect(confirmation).not.toHaveBeenCalled();
    expect(f.counts).toMatchObject({ oauth: 1, receive: 0, refresh: 0, revoke: 1 });
  });
  it('terminal status cannot clear suspended custody without a signed recovery acknowledgement', async () => {
    const f=fixture({lostAck:true});await expect(runCompanion(f.launch,f.options)).rejects.toThrow();f.setCancelled();
    await expect(runCompanion(f.launch,f.options)).rejects.toThrow();expect(f.counts.recover).toBe(1);expect(f.counts.revoke).toBe(0);expect((f.store.values.get('journal.json') as {body:{phase:string}}).body.phase).toBe('suspended');
  });
  it('cancels pending local OAuth when server status cancels, without transferring credentials', async () => {
    const f=fixture({cancel:true});await expect(runCompanion(f.launch,f.options)).rejects.toThrow();expect(f.counts.receive).toBe(0);expect(f.counts.refresh).toBe(0);
  });
});
