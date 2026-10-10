import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { createOfficialPlanVerifier } from './official-plan-signatures';
import { CompanionPrivateStore } from './official-plan-companion-storage';
import { AckSchema, CompanionCredentialSchema, CompanionHostIdSchema, CustodySchema, SnapshotSchema, TicketSchema, companionFailure, credentialDigest,
  samePublicKey, sealCompanionPayload, signTranscript, signedSchema, transcriptDigest, verifyTranscript, type CompanionEnvelope, type Signed, type SourceSnapshot } from './official-plan-companion-protocol';

const ISSUER = 'https://auth.openai.com', RESOURCE = 'https://api.openai.com/v1';
const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'];
const id = z.string().min(1).max(256), key = z.string().min(1).max(8000);
export const LocalPairingSchema = z.object({ version: z.literal(1), pairingId: id, appOwnerId: id, sourceHostId: CompanionHostIdSchema,
  sourceSigningPrivateKey: key, sourceSigningPublicKey: key, receiverHostId: CompanionHostIdSchema, receiverSigningPublicKey: key,
  receiverEncryptionPublicKey: key, approvedUntil: z.number().int().positive().safe() }).strict();
export type LocalCompanionPairing = z.infer<typeof LocalPairingSchema>;
const journalSchema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative().safe(), phase: z.enum(['empty', 'signing_in', 'active', 'refreshing', 'suspended', 'transferred', 'needs_attention']),
  registrationClientId: id.optional(),
  file: CompanionCredentialSchema.optional(), snapshot: signedSchema(SnapshotSchema).optional(),
  ticket: signedSchema(TicketSchema).optional(), custody: signedSchema(CustodySchema).optional(),
  attempt: z.object({ state: id, nonce: id, verifier: id, redirectUri: z.string().max(512) }).strict().optional() }).strict();
type Journal = z.infer<typeof journalSchema>;
const tokenSchema = z.object({ access_token: z.string().min(1).max(16000), refresh_token: z.string().min(1).max(16000), id_token: z.string().min(1).max(16000).optional(),
  token_type: z.string().refine(v => v.toLowerCase() === 'bearer'), expires_in: z.number().int().positive().max(3660), scope: z.string().max(4000),
  earliest_refresh_at: z.union([z.string().max(256), z.number().finite(), z.null()]).optional() }).passthrough();
const random = () => randomBytes(32).toString('base64url');
/** Ticket times come from the VM clock; tolerate the same skew as the receiver's own checks. */
const CLOCK_SKEW_MS = 60000;

/** An already approved pairing is supplied by installation; this class does not provision trust or accept uploaded token files. */
export class OfficialPlanLocalCompanion {
  private readonly pairing: LocalCompanionPairing;
  private readonly verifier: ReturnType<typeof createOfficialPlanVerifier>;
  constructor(private readonly store: CompanionPrivateStore, pairing: LocalCompanionPairing, private readonly fetcher: typeof fetch = fetch) {
    this.pairing = LocalPairingSchema.parse(pairing); this.verifier = createOfficialPlanVerifier(fetcher); this.authority();
  }
  private authority() {
    if (this.pairing.approvedUntil <= Date.now() || this.pairing.sourceHostId === this.pairing.receiverHostId
      || !samePublicKey(this.pairing.sourceSigningPrivateKey, this.pairing.sourceSigningPublicKey)) throw companionFailure();
  }
  private async load(): Promise<Journal> {
    this.authority(); const raw = await this.store.read('journal.json');
    if (!raw) return { version: 1, revision: 0, phase: 'empty' };
    const signed = signedSchema(journalSchema).parse(raw), journal = verifyTranscript(signed, this.pairing.sourceSigningPublicKey);
    if (journal.snapshot) {
      const snapshot = verifyTranscript(journal.snapshot, this.pairing.sourceSigningPublicKey);
      if (snapshot.pairingId !== this.pairing.pairingId || snapshot.sourceHostId !== this.pairing.sourceHostId
        || (journal.file && (credentialDigest(journal.file) !== snapshot.credentialDigest || journal.file.subject !== snapshot.subject || journal.file.client_id !== snapshot.clientId))) throw companionFailure();
    }
    return journal;
  }
  private async save(journal: Journal) { await this.store.write('journal.json', signTranscript(journalSchema.parse(journal), this.pairing.sourceSigningPrivateKey)); }
  async status() {
    try { if (await this.store.isLocked()) return { state: 'needs_attention' as const }; return { state: (await this.load()).phase }; }
    catch { return { state: 'needs_attention' as const }; }
  }
  private async exchange(body: URLSearchParams) {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(companionFailure()); }, 8000); });
    try {
      const pending = this.fetcher(`${ISSUER}/api/accounts/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: body.toString(), redirect: 'error', signal: controller.signal });
      void pending.then(response => { if (controller.signal.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
      const response = await Promise.race([pending, deadline]);
      if (!response.ok || response.redirected || !response.headers.get('content-type')?.startsWith('application/json') || !response.body) throw companionFailure();
      reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      for (;;) { const part = await Promise.race([reader.read(), deadline]); if (part.done) break; size += part.value.length; if (size > 64000) throw companionFailure(); chunks.push(part.value); }
      return tokenSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
    } catch { throw companionFailure(); }
    finally { clearTimeout(timer); controller.abort(); void reader?.cancel().catch(() => {}); reader?.releaseLock(); }
  }
  private async record(tokens: z.infer<typeof tokenSchema>, clientId: string, expected: { nonce?: string; subject?: string }, priorId?: string) {
    const scopes = tokens.scope.split(/\s+/).filter(Boolean);
    if (SCOPES.some(scope => !scopes.includes(scope))) throw companionFailure();
    if (!tokens.id_token && !priorId) throw companionFailure();
    const subject = tokens.id_token ? (await this.verifier.verifyIdToken(tokens.id_token, { clientId, ...expected })).subject : expected.subject;
    const access = await this.verifier.verifyAccessToken(tokens.access_token);
    if (!subject || access.subject !== subject || access.clientId !== clientId || SCOPES.some(scope => !access.scopes.includes(scope))) throw companionFailure();
    const file = CompanionCredentialSchema.parse({ version: 1, client_id: clientId, subject, source_host_id: this.pairing.sourceHostId,
      access_token: tokens.access_token, refresh_token: tokens.refresh_token, id_token: tokens.id_token ?? priorId, ...(tokens.earliest_refresh_at === undefined ? {} : { earliest_refresh_at: tokens.earliest_refresh_at }) });
    const snapshot = signTranscript<SourceSnapshot>({ version: 1, pairingId: this.pairing.pairingId, sourceHostId: this.pairing.sourceHostId, clientId, subject,
      exchangeId: randomUUID(), credentialDigest: credentialDigest(file), receivedAt: Date.now(), expiresAt: access.expiresAt, scopes, validation: expected.nonce ? 'authorization_code' : 'refresh_token' }, this.pairing.sourceSigningPrivateKey);
    return { file, snapshot };
  }
  /** Browser launcher is trusted installation code; token hints are deliberately omitted from URLs and process arguments. */
  async signIn(openBrowser: (authorizationUrl: string) => Promise<void>, reconnect = false, signal?: AbortSignal, timeoutMs = 120000) {
    return this.store.locked(async () => {
      const prior = await this.load(); if (['signing_in', 'refreshing', 'suspended'].includes(prior.phase)) throw companionFailure();
      if (reconnect && !prior.snapshot) throw companionFailure();
      const retainedClient = prior.snapshot?.body.clientId ?? prior.registrationClientId, reauthorize = Boolean(retainedClient);
      const clientId = retainedClient ?? 'dynamic_agent_client', state = random(), nonce = random(), verifier = random();
      let server: Server | undefined, accepted = false, cancelled = false, activated = false, timer: ReturnType<typeof setTimeout> | undefined, processing: Promise<void> | undefined;
      let resolveDone!: () => void, rejectDone!: (error: Error) => void;
      const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; }); void done.catch(() => {});
      const journal: Journal = { ...prior, revision: prior.revision + 1, phase: 'signing_in' };
      const abort = () => { cancelled = true; rejectDone(companionFailure()); };
      try {
        server = createServer((request, response) => {
          const finish = (status: number) => { response.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); response.end(status === 200 ? 'Return to CollectiveUI.' : 'Sign-in was not confirmed.'); };
          const handle = async () => { try {
            if (cancelled || signal?.aborted || accepted || request.method !== 'GET' || request.headers.host !== new URL(journal.attempt!.redirectUri).host || (request.url?.length ?? 0) > 8192) { finish(400); return; }
            const callback = new URL(request.url!, journal.attempt!.redirectUri);
            if (callback.pathname !== '/auth/callback' || [...callback.searchParams.keys()].some(k => callback.searchParams.getAll(k).length !== 1 || !['state', 'code', 'client_id', 'scope', 'error'].includes(k)) || callback.searchParams.get('state') !== state) { finish(400); return; }
            accepted = true;
            if (callback.searchParams.has('error') || !callback.searchParams.get('code') || callback.searchParams.get('code')!.length > 4000) throw companionFailure();
            const issued = callback.searchParams.get('client_id') ?? (reauthorize ? clientId : null);
            if (!issued || issued === 'dynamic_agent_client' || issued.length > 256 || (reauthorize && issued !== clientId)) throw companionFailure();
            journal.registrationClientId = issued; await this.save(journal);
            if (cancelled || signal?.aborted) throw companionFailure();
            const tokens = await this.exchange(new URLSearchParams({ grant_type: 'authorization_code', client_id: issued, code: callback.searchParams.get('code')!, code_verifier: verifier, redirect_uri: journal.attempt!.redirectUri, resource: RESOURCE }));
            const recorded = await this.record(tokens, issued, { nonce, ...(prior.snapshot ? { subject: prior.snapshot.body.subject } : {}) });
            if (cancelled || signal?.aborted) throw companionFailure();
            this.authority(); await this.save({ version: 1, revision: journal.revision + 1, phase: 'active', ...recorded }); activated = true; finish(200); resolveDone();
          } catch { finish(400); rejectDone(companionFailure()); } };
          const pending = handle(); if (!processing && accepted) processing = pending;
        });
        server.headersTimeout = 8000; server.requestTimeout = 8000; server.keepAliveTimeout = 100;
        await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
        const address = server.address(); if (!address || typeof address === 'string') throw companionFailure();
        const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
        journal.attempt = { state, nonce, verifier, redirectUri }; await this.save(journal);
        const url = new URL(`${ISSUER}/api/accounts/authorize`);
        for (const [name, value] of Object.entries({ client_id: clientId, response_type: 'code', redirect_uri: redirectUri, scope: SCOPES.join(' '), resource: RESOURCE,
          state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), ext_agent_host_id: this.pairing.sourceHostId,
          ...(!reauthorize ? { agent_name_hint: 'CollectiveUI' } : {}) })) url.searchParams.set(name, value);
        timer = setTimeout(abort, Math.min(Math.max(timeoutMs, 1), 120000)); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) throw companionFailure();
        const launched = openBrowser(url.href); void launched.catch(() => {});
        await Promise.race([launched, done]); await done;
        return { connectedLocally: true };
      } catch {
        cancelled = true; await processing;
        // A timeout/abort that lands mid-save must not overwrite the newly stored grant with the superseded one.
        if (activated) return { connectedLocally: true };
        await this.save({ ...prior, registrationClientId: journal.registrationClientId ?? retainedClient, revision: journal.revision + 1, phase: 'needs_attention', attempt: undefined }); throw companionFailure();
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); server?.closeAllConnections(); await new Promise<void>(resolve => { if (server?.listening) server.close(() => resolve()); else resolve(); }); }
    });
  }
  async refresh() {
    return this.store.locked(async () => {
      const prior = await this.load(); if (prior.phase !== 'active' || !prior.file || !prior.snapshot) throw companionFailure();
      await this.save({ ...prior, revision: prior.revision + 1, phase: 'refreshing' });
      try {
        const tokens = await this.exchange(new URLSearchParams({ grant_type: 'refresh_token', client_id: prior.file.client_id, refresh_token: prior.file.refresh_token, resource: RESOURCE }));
        const recorded = await this.record(tokens, prior.file.client_id, { subject: prior.file.subject }, prior.file.id_token);
        await this.save({ version: 1, revision: prior.revision + 2, phase: 'active', ...recorded }); return { refreshed: true };
      } catch { await this.save({ ...prior, revision: prior.revision + 2, phase: 'needs_attention' }); throw companionFailure(); }
    });
  }
  async offer(): Promise<Signed<SourceSnapshot>> {
    if (await this.store.isLocked()) throw companionFailure(); const journal = await this.load();
    if (journal.phase !== 'active' || !journal.file || !journal.snapshot || journal.snapshot.body.expiresAt <= Date.now()) throw companionFailure();
    return journal.snapshot;
  }
  async suspend(raw: unknown): Promise<CompanionEnvelope> {
    return this.store.locked(async () => {
      const journal = await this.load(), ticket = signedSchema(TicketSchema).parse(raw), body = verifyTranscript(ticket, this.pairing.receiverSigningPublicKey);
      if (journal.phase !== 'active' || !journal.file || !journal.snapshot || body.pairingId !== this.pairing.pairingId || body.ownerId !== this.pairing.appOwnerId
        || body.pairingDigest !== transcriptDigest({ pairingId: this.pairing.pairingId, ownerId: this.pairing.appOwnerId, sourceHostId: this.pairing.sourceHostId, sourceSigningPublicKey: this.pairing.sourceSigningPublicKey, approvedUntil: this.pairing.approvedUntil })
        || body.sourceHostId !== this.pairing.sourceHostId || body.destinationHostId !== this.pairing.receiverHostId || body.clientId !== journal.snapshot.body.clientId || body.subject !== journal.snapshot.body.subject
        || body.credentialDigest !== credentialDigest(journal.file) || body.snapshotDigest !== transcriptDigest(journal.snapshot) || body.expiresAt <= Date.now() || body.createdAt > Date.now() + CLOCK_SKEW_MS) throw companionFailure();
      const custody = signTranscript({ version: 1 as const, ticketDigest: transcriptDigest(body), snapshotDigest: body.snapshotDigest, credentialDigest: body.credentialDigest,
        journalRevision: journal.revision + 1, suspendedAt: Date.now(), refreshOwner: 'collective_vm' as const }, this.pairing.sourceSigningPrivateKey);
      const suspended: Journal = { ...journal, revision: journal.revision + 1, phase: 'suspended', ticket, custody }; await this.save(suspended);
      return sealCompanionPayload({ file: journal.file, snapshot: journal.snapshot, custody }, body, this.pairing.receiverEncryptionPublicKey, this.pairing.sourceSigningPrivateKey);
    });
  }
  async recoveryRequest() {
    if (await this.store.isLocked()) throw companionFailure(); const journal = await this.load();
    if (journal.phase !== 'suspended' || !journal.ticket || !journal.custody) throw companionFailure();
    return signTranscript({ ticket: journal.ticket, custodyDigest: transcriptDigest(journal.custody) }, this.pairing.sourceSigningPrivateKey);
  }
  private acknowledgment(journal: Journal, raw: unknown) {
    const ack = signedSchema(AckSchema).parse(raw), body = verifyTranscript(ack, this.pairing.receiverSigningPublicKey);
    if (journal.phase !== 'suspended' || !journal.ticket || !journal.custody || body.ticketDigest !== transcriptDigest(journal.ticket.body) || body.custodyDigest !== transcriptDigest(journal.custody)
      || body.at > Date.now() + 60000 || body.at < Date.now() - 60000) throw companionFailure();
    return body;
  }
  /** Only a freshly authenticated pending status permits retransmission of the same suspended grant. Never refresh/re-arm it. */
  async retrySuspended(raw: unknown) {
    return this.store.locked(async () => {
      const journal = await this.load(), ack = this.acknowledgment(journal, raw);
      if (ack.state !== 'pending' || !journal.file || !journal.snapshot || !journal.ticket || !journal.custody || journal.ticket.body.expiresAt <= Date.now()) throw companionFailure();
      return sealCompanionPayload({ file: journal.file, snapshot: journal.snapshot, custody: journal.custody }, journal.ticket.body, this.pairing.receiverEncryptionPublicKey, this.pairing.sourceSigningPrivateKey);
    });
  }
  async acknowledge(raw: unknown) {
    return this.store.locked(async () => {
      const journal = await this.load(), body = this.acknowledgment(journal, raw);
      if (body.state === 'pending') throw companionFailure();
      if (body.state !== 'complete') { await this.save({ ...journal, revision: journal.revision + 1, phase: 'needs_attention' }); return { transferred: false, state: 'needs_attention' as const }; }
      await this.save({ ...journal, revision: journal.revision + 1, phase: 'transferred', file: undefined, attempt: undefined }); return { transferred: true };
    });
  }
}
