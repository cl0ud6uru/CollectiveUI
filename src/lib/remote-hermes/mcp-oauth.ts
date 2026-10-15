import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { remoteHermesSessions, remoteHermesTurns } from '@/db/schema';
import { decrypt, encrypt, hmacSha256Hex, sha256Hex, toolApprovalSecret } from '@/lib/crypto';
import { HttpError } from '@/lib/authz';
import { newId } from '@/lib/ids';
import { getSetting } from '@/lib/settings';
import { assertRemoteHermesAdmission } from './policy';
import { ownedNativeSession } from './sessions';
import { remoteAccess } from './store';
import { nativeHub } from './hub';
import { record } from './socket';
import { dashboardAddress, dashboardFetchPinned } from './transport';
import type { DashboardClient, RemoteMcpOAuthFlow } from './client';
import { mcpOAuthInput, nativeMcpAuthorizationURL, nativeMcpOAuthSlot, unsupportedMcpOAuth } from './mcp-oauth-contract';

const claimSchema = z.object({ nativeId: z.string().regex(/^[A-Za-z0-9_-]{16,200}$/), name: z.string().min(1).max(64), profile: z.string().min(1).max(200), storedId: z.string().min(1).max(200), base: z.string().url(), target: z.string().length(64), authorization: z.string().length(64), expiresAt: z.number().int() }).strict();
export { mcpOAuthInput, nativeMcpAuthorizationURL } from './mcp-oauth-contract';

/** User-driven native-dashboard OAuth. The portal never receives provider codes or tokens. */
export async function nativeMcpOAuth(ownerId: string, connectionId: string, sessionId: string, raw: unknown) {
  const input = mcpOAuthInput.parse(raw);
  const row = await ownedNativeSession(ownerId, connectionId, sessionId);
  const binding = JSON.stringify(['remote-hermes-mcp-oauth:v1', ownerId, connectionId, sessionId]);
  let claim: z.infer<typeof claimSchema> | null = null;
  if (input.operation !== 'start') {
    try {
      claim = claimSchema.parse(JSON.parse(decrypt(input.flow, binding)));
      if (claim.expiresAt <= Date.now() || claim.expiresAt > Date.now() + 600_000 || claim.profile !== row.profile || claim.storedId !== row.storedId) throw new Error();
    } catch { throw new HttpError(409, 'This OAuth flow is invalid, expired, or belongs to a different conversation. Check its outcome in Hermes.'); }
  }
  // A verified flow handle permits only bounded cleanup after admission is
  // disabled; destination revocation and durable ownership still apply.
  const cleanup = input.operation === 'cancel';
  const access = await remoteAccess(ownerId, connectionId, cleanup ? 'continuation' : 'admission');
  if (claim && claim.base !== access.client.base) throw new HttpError(409, 'The Hermes destination changed. Check the OAuth outcome in Hermes.');
  if (new URL(access.client.base).protocol !== 'https:') throw unsupportedMcpOAuth();
  if (!cleanup && !(await access.client.profiles()).some(profile => profile.name === row.profile)) throw new HttpError(404, 'Hermes profile not found.');
  const hub = nativeHub(ownerId, connectionId);
  if (!cleanup) await hub.refresh(row);
  const epoch = hub.socket.connectionEpoch;
  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
  async function lock(tx: Tx, idle: boolean) {
    const connection = await hub.lockBoundary(tx);
    const policy = await getSetting('remoteHermes', tx);
    if (!cleanup) assertRemoteHermesAdmission(policy);
    const [current] = await tx.select().from(remoteHermesSessions).where(eq(remoteHermesSessions.id, sessionId)).for('update');
    const cached = hub.sessions.get(sessionId);
    if (!current || current.profile !== row.profile || current.storedId !== row.storedId || current.connectionId !== connectionId || !cleanup && (!cached?.row.runtimeId || !cached.view ||
        cached.row.profile !== row.profile || cached.row.storedId !== row.storedId || current.runtimeId !== cached.row.runtimeId ||
        cached.view.profile !== row.profile || cached.view.nativeProfile !== row.profile || hub.socket.connectionEpoch !== epoch))
      throw new HttpError(409, 'The native conversation changed. Check the OAuth outcome in Hermes.');
    if (idle && (current.status !== 'idle' || current.queueRequestId || cached!.view.running || cached!.view.uncertain || cached!.view.queuePending))
      throw new HttpError(409, 'Finish the native turn and pending work before starting OAuth.');
    if (connection.baseUrl !== access.client.base) throw new HttpError(409, 'The Hermes destination changed.');
    return { connection, policy };
  }
  async function dashboard<T>(request: (client: DashboardClient) => Promise<T>, idle = false) {
    const { reply } = await db.transaction(async tx => {
      const { connection, policy } = await lock(tx, idle);
      const address = await dashboardAddress(connection.baseUrl, policy);
      if (!cleanup && hub.socket.connectionEpoch !== epoch) throw new HttpError(409, 'The verified Hermes connection changed.');
      return { reply: request(access.client.withTransport(dashboardFetchPinned(connection.baseUrl, address))) };
    });
    return reply;
  }
  async function server(name: string) {
    const payload = record(await hub.socket.callConnected('mcp.servers.list', { profile: row.profile }, epoch, 30_000));
    if (!Array.isArray(payload.servers) || payload.servers.length > 100) throw new HttpError(409, 'Refresh the MCP inventory before authorizing.');
    const matches = payload.servers.map(record).filter(item => item.name === name);
    const target = matches[0];
    if (matches.length !== 1 || target.source !== 'config' || !['http', 'sse', 'streamable-http'].includes(String(target.transport)) || typeof target.url !== 'string' || target.url.length > 2048 || target.auth === 'header')
      throw new HttpError(409, 'Choose a configured HTTP MCP server that supports OAuth.');
    const slot = nativeMcpOAuthSlot(name)!;
    for (const value of payload.servers) {
      const other = record(value);
      const otherSlot = typeof other.name === 'string' ? nativeMcpOAuthSlot(other.name) : null;
      if (!otherSlot) throw new HttpError(409, 'The native OAuth credential slots could not be verified safely. Refresh the inventory in Hermes.');
      // Case-insensitive comparison also protects native homes on case-insensitive filesystems.
      if (other.name !== name && otherSlot.toLowerCase() === slot.toLowerCase())
        throw new HttpError(409, 'This MCP server shares a protected OAuth credential slot with another native server. Authorize it directly in Hermes.');
    }
    return { fingerprint: sha256Hex(JSON.stringify([name, target.source, target.transport, target.url])), tokensPresent: target.oauth_tokens_present === true };
  }
  if (input.operation === 'start') {
    const digest = hmacSha256Hex(toolApprovalSecret('native-mcp-oauth-receipt:v1'), JSON.stringify(input));
    // Resolve an existing receipt before inventory checks; a lost start response must never replay.
    const duplicate = await db.transaction(async tx => {
      await lock(tx, true);
      const [receipt] = await tx.select().from(remoteHermesTurns).where(and(eq(remoteHermesTurns.sessionId, sessionId), eq(remoteHermesTurns.requestId, input.requestId)));
      if (receipt && receipt.digest !== digest) throw new HttpError(409, 'This OAuth receipt belongs to different content.');
      return !!receipt;
    });
    if (duplicate) return { duplicate: true, status: 'uncertain', message: 'This authorization was already started and will not be replayed. Check its outcome in Hermes.' };
    const before = await server(input.name);
    const reserved = await db.transaction(async tx => {
      await lock(tx, true);
      const [receipt] = await tx.select().from(remoteHermesTurns).where(and(eq(remoteHermesTurns.sessionId, sessionId), eq(remoteHermesTurns.requestId, input.requestId)));
      if (receipt) { if (receipt.digest !== digest) throw new HttpError(409, 'This OAuth receipt belongs to different content.'); return false; }
      await tx.insert(remoteHermesTurns).values({ id: newId(), sessionId, requestId: input.requestId, digest });
      return true;
    });
    if (!reserved) return { duplicate: true, status: 'uncertain', message: 'This authorization was already started and will not be replayed. Check its outcome in Hermes.' };
    if ((await server(input.name)).fingerprint !== before.fingerprint) throw new HttpError(409, 'The MCP server changed before authorization. Refresh before continuing.');
    const started = await dashboard(client => client.startMcpOAuth(row.profile, input.name), true);
    if (started.server_name !== input.name) throw new HttpError(502, 'Hermes did not confirm the requested OAuth server. Check its outcome in Hermes.');
    if (started.status !== 'authorization_required') {
      await dashboard(client => client.cancelMcpOAuth(started.flow_id)).catch(() => {});
      throw new HttpError(502, 'Hermes did not return a pending authorization. Check its outcome in Hermes.');
    }
    let authorizationUrl: string;
    try { authorizationUrl = nativeMcpAuthorizationURL(access.client.base, input.name, started.authorization_url); }
    catch (error) { await dashboard(client => client.cancelMcpOAuth(started.flow_id)).catch(() => {}); throw error; }
    const next = { nativeId: started.flow_id, name: input.name, profile: row.profile, storedId: row.storedId, base: access.client.base, target: before.fingerprint, authorization: sha256Hex(authorizationUrl), expiresAt: Date.now() + 600_000 };
    return { status: 'pending', flow: encrypt(JSON.stringify(next), binding), authorizationUrl, expiresAt: next.expiresAt };
  }
  const target = claim!;
  if (input.operation === 'cancel') {
    // Cancellation is idempotent cleanup, available even if the chat became busy.
    const result = await dashboard(client => client.cancelMcpOAuth(target.nativeId));
    return { status: result.status === 'approved' ? 'uncertain' : 'cancelled', message: result.status === 'approved' ? 'Hermes reports this authorization was already approved. Cancellation does not revoke the grant; refresh Hermes and manage it there or at the provider.' : 'The pending authorization was cancelled. Cancellation does not revoke a grant the provider may already have issued.' };
  }
  const result: RemoteMcpOAuthFlow = await dashboard(client => client.mcpOAuthFlow(target.nativeId));
  if (result.flow_id !== target.nativeId || result.server_name !== target.name) throw new HttpError(409, 'Hermes returned a different OAuth flow.');
  if (result.authorization_url && sha256Hex(nativeMcpAuthorizationURL(target.base, target.name, result.authorization_url)) !== target.authorization)
    throw new HttpError(409, 'The authorization changed. Cancel this attempt and review a new sign-in.');
  const current = await server(target.name);
  if (current.fingerprint !== target.target) throw new HttpError(409, 'The MCP server changed during authorization. Check its outcome in Hermes.');
  if (result.status === 'approved') {
    if (!current.tokensPresent) throw new HttpError(502, 'Hermes has not confirmed the saved OAuth credentials. Refresh to check its outcome.');
    return { status: 'approved', message: 'Hermes confirmed OAuth authorization and saved credentials for this profile. Other clients using it may be affected.' };
  }
  return { status: result.status === 'error' ? 'error' : 'pending', message: result.status === 'error' ? 'Hermes could not complete authorization. Check the outcome in Hermes before starting again.' : 'Waiting for authorization in Hermes.' };
}
