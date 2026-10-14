import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { revokeSIWCTokens } from '../lib/llm/chatgpt/siwc';
import { OfficialPlanLocalCompanion, LocalPairingSchema, type LocalCompanionStore } from '../lib/hermes-team/official-plan-local-companion';
import { CompanionHostIdSchema, signTranscript, signedSchema, TicketSchema, AckSchema } from '../lib/hermes-team/official-plan-companion-protocol';
const uuid = z.string().uuid(), capability = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const failure = () => new Error('ChatGPT companion operation was not confirmed. Check account status before retrying.');
export function exactOrigin(value: string) { const u = new URL(value); if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash || value !== u.origin) throw failure(); return u.origin; }
export function parseLaunch(value: string, approvedOrigins: readonly string[]) {
  const u = new URL(value);
  if (u.protocol !== 'collectiveui-chatgpt:' || u.hostname !== 'connect' || u.pathname || u.username || u.password || u.port || u.hash || [...u.searchParams.keys()].some(k => !['origin','attempt','ticket'].includes(k) || u.searchParams.getAll(k).length !== 1)) throw failure();
  const origin = exactOrigin(u.searchParams.get('origin') ?? ''); if (!approvedOrigins.includes(origin)) throw failure();
  return { origin, attemptId: uuid.parse(u.searchParams.get('attempt')), launchToken: capability.parse(u.searchParams.get('ticket')) };
}
const publicPairing = LocalPairingSchema.omit({ sourceSigningPrivateKey: true });
const redeemedSchema = z.object({ returnToken: capability, origin: z.string(), ownerId: z.string().min(1).max(256), email: z.email(), pairing: publicPairing,
  registration: z.object({ clientId: z.string().min(1).max(256), subject: z.string().min(1).max(256) }).strict().optional(), expiresAt: z.number().int().positive().safe() }).strict();
const statusSchema = z.object({ state: z.enum(['created','paired','receiving','complete','cancelled','needs_attention','expired']), reason: z.string().max(1000).optional() }).strict();
export class CompanionTransport {
  constructor(readonly origin: string, private readonly fetcher: typeof fetch = fetch) { exactOrigin(origin); }
  async request(body: unknown, returnToken?: string) {
    const controller = new AbortController(); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure()); }, 15000); });
    try {
      const pending = this.fetcher(`${this.origin}/api/chatgpt/companion`, { method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...(returnToken ? { authorization: `Companion ${capability.parse(returnToken)}` } : {}) }, body: JSON.stringify(body), signal: controller.signal });
      void pending.then(response => { if (controller.signal.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
      const response = await Promise.race([pending, timeout]);
      if (!response.ok || response.redirected || !response.headers.get('content-type')?.startsWith('application/json') || !response.body) throw failure();
      reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      for (;;) { const p = await Promise.race([reader.read(), timeout]); if (p.done) break; bytes += p.value.length; if (bytes > 128000) throw failure(); chunks.push(p.value); }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch { throw failure(); } finally { clearTimeout(timer); controller.abort(); void reader?.cancel().catch(() => {}); reader?.releaseLock(); }
  }
}
export type CompanionClientOptions = { approvedOrigins: readonly string[]; globalStore: LocalCompanionStore; attemptStore(id: string): LocalCompanionStore;
  confirm(origin: string, email: string): Promise<boolean>; openBrowser(url: string): Promise<void>; returnToApp(url: string): Promise<void>; fetcher?: typeof fetch; pollMs?: number };
/** Single operation per protected attempt. Browser receives only non-secret completion navigation. */
export async function runCompanion(value: string, options: CompanionClientOptions) {
  const launch = parseLaunch(value, options.approvedOrigins), store = options.attemptStore(launch.attemptId);
  const host = await options.globalStore.locked(async () => {
    const prior = await options.globalStore.read('host.json');
    if (prior) return CompanionHostIdSchema.parse(z.object({ hostId: CompanionHostIdSchema }).strict().parse(prior).hostId);
    const hostId = `urn:uuid:${randomUUID()}`; await options.globalStore.write('host.json', { hostId }); return hostId;
  });
  const source = await store.locked(async () => {
    const schema = z.object({ origin: z.string(), attemptId: uuid, sourceSigningPrivateKey: z.string(), sourceSigningPublicKey: z.string() }).strict();
    const previous = await store.read('source.json'); if (previous) { const v = schema.parse(previous); if (v.origin !== launch.origin || v.attemptId !== launch.attemptId) throw failure(); return v; }
    const pair = generateKeyPairSync('ed25519'); const v = { origin: launch.origin, attemptId: launch.attemptId,
      sourceSigningPrivateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), sourceSigningPublicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString() };
    await store.write('source.json', v); return v;
  });
  const transport = new CompanionTransport(launch.origin, options.fetcher);
  const proof = { attemptId: launch.attemptId, launchToken: launch.launchToken, sourceHostId: host, sourceSigningPublicKey: source.sourceSigningPublicKey };
  // Retain the returned capability before any OAuth; retry redemption uses exactly the persisted key.
  let redeemed = await store.read('redemption.json');
  if (!redeemed) { redeemed = redeemedSchema.parse(await transport.request({ action: 'redeem', ...proof, signature: signTranscript(proof, source.sourceSigningPrivateKey).signature })); await store.write('redemption.json', redeemed); }
  const registration = redeemedSchema.parse(redeemed), p = registration.pairing;
  if (registration.origin !== launch.origin || p.pairingId !== launch.attemptId || p.appOwnerId !== registration.ownerId || p.sourceHostId !== host || p.sourceSigningPublicKey !== source.sourceSigningPublicKey) throw failure();
  const rpc = (action: string, input?: unknown) => transport.request({ action, attemptId: launch.attemptId, ...(input === undefined ? {} : { input }) }, registration.returnToken);
  const local = new OfficialPlanLocalCompanion(store, { ...p, sourceSigningPrivateKey: source.sourceSigningPrivateKey }, options.fetcher, registration.registration);
  const state = await local.status();
  const revokeLocal = () => local.cancelBeforeCustody(async file => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([revokeSIWCTokens({ clientId: file.client_id, refreshToken: file.refresh_token, accessToken: file.access_token }, options.fetcher),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 10000); })]); } finally { clearTimeout(timer); }
  });
  // Cached redemption never bypasses the current destination state. Custody stays suspended until signed recovery.
  const remoteState = statusSchema.parse(await rpc('status')).state;
  if (['cancelled', 'expired', 'needs_attention'].includes(remoteState) && !['suspended', 'transferred'].includes(state.state)) {
    await revokeLocal(); throw failure();
  }

  if (state.state === 'transferred') { if (statusSchema.parse(await rpc('status')).state !== 'complete') throw failure(); await options.returnToApp(`${launch.origin}/settings?tab=connected-accounts`); return { connected: true }; }
  if (state.state === 'suspended') {
    const ack = signedSchema(AckSchema).parse(await rpc('recover', await local.recoveryRequest()));
    const result = ack.body.state === 'pending' ? await rpc('receive', await local.retrySuspended(ack)) : ack;
    await local.acknowledge(result);
  } else {
    if (registration.expiresAt <= Date.now()) throw failure();
    if (!await options.confirm(launch.origin, registration.email)) {
      z.object({ cancelled: z.literal(true) }).strict().parse(await rpc('cancel'));
      const result = await revokeLocal(); if (!result.revocationConfirmed) throw failure();
      return { connected: false };
    }
    if (registration.expiresAt <= Date.now()) throw failure();
    const controller = new AbortController(); let stopped = false;
    const poll = async () => { while (!stopped) { await new Promise(r => setTimeout(r, options.pollMs ?? 1500)); if (stopped) break;
      try { if (['cancelled','expired','needs_attention'].includes(statusSchema.parse(await rpc('status')).state)) { controller.abort(); break; } } catch { controller.abort(); break; } } };
    const polling = poll();
    try {
      if (state.state !== 'active') await local.signIn(options.openBrowser, false, controller.signal);
      if (controller.signal.aborted || registration.expiresAt <= Date.now()) throw failure();
      const ticket = signedSchema(TicketSchema).parse(await rpc('challenge', await local.offer()));
      const envelope = await local.suspend(ticket);
      // Never automatically retransmit after delivery uncertainty. Next launch uses signed recovery.
      await local.acknowledge(await rpc('receive', envelope));
    } catch (error) {
      // Browser cancellation can race the completed local callback. Clear only locally owned, unsuspended material.
      const phase = (await local.status()).state;
      if (!['suspended', 'transferred'].includes(phase)) {
        try { if (['cancelled', 'expired', 'needs_attention'].includes(statusSchema.parse(await rpc('status')).state)) await revokeLocal(); }
        catch { /* An uncertain destination never permits custody cleanup or refresh. */ }
      }
      throw error;
    } finally { stopped = true; controller.abort(); await polling; }
  }
  if ((await local.status()).state !== 'transferred' || statusSchema.parse(await rpc('status')).state !== 'complete') throw failure();
  await options.returnToApp(`${launch.origin}/settings?tab=connected-accounts`); return { connected: true };
}
