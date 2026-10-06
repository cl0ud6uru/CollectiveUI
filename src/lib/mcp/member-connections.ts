import 'server-only';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type DbOrTx } from '@/db';
import { bots, users, mcpMemberConnections, mcpServers, type McpServer } from '@/db/schema';
import { HttpError } from '@/lib/authz';
import type { Principal } from '@/lib/auth/groups';
import { loadPrincipal } from '@/lib/auth/groups';
import { encrypt, decrypt, sha256Hex, rewrap } from '@/lib/crypto';
import { authorizeTeam } from '@/lib/hermes-team/store';
import { canonicalTeamToolInput, type TeamToolCapability } from '@/lib/hermes-team/tool-policy';
import { snapshotHash } from './snapshot';
import { candidateResourceAdapterId } from '@/lib/hermes-team/candidate-resource-adapter';
import { getSetting } from '@/lib/settings';

export type MemberMcpConnection = typeof mcpMemberConnections.$inferSelect;
const MAX_HEADERS_BYTES = 8000;
const MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const reserved = /^(host|cookie|content-type|content-length|accept|connection|transfer-encoding|mcp-session-id|mcp-protocol-version|last-event-id|x-portal-.*|x-collective-.*)$/i;
const saveInput = z.object({ expectedRevision: z.number().int().min(0).max(2147483646),
  headers: z.record(z.string(), z.string().min(1).max(MAX_HEADERS_BYTES)), expiresAt: z.iso.datetime({ offset: true }) }).strict();
export const memberMcpRevokeInput = z.object({ expectedRevision: z.number().int().min(1).max(2147483646) }).strict();

/** A member account never follows an edited endpoint or newly reviewed tool policy. */
export function memberMcpTargetHash(server: McpServer): string {
  return sha256Hex(canonicalTeamToolInput({ id: server.id, url: server.url, transport: server.transport,
    policyRevision: server.policyRevision, toolsHash: server.toolsHash, toolPolicy: server.toolPolicy,
    trust: server.trust, identityHeader: server.identityHeader }));
}
export function memberMcpBindingHash(server: McpServer, connection: MemberMcpConnection): string {
  return sha256Hex(canonicalTeamToolInput({ target: memberMcpTargetHash(server), id: connection.id,
    userId: connection.userId, serverId: connection.serverId, targetHash: connection.targetHash,
    credentialRevision: connection.headersEnc, status: connection.status, expiresAt: connection.expiresAt.getTime(), revision: connection.revision }));
}
const aad = (connection: Pick<MemberMcpConnection, 'id' | 'userId' | 'serverId' | 'targetHash'>) =>
  `mcp_member_connections.headers_enc|${canonicalTeamToolInput({ id: connection.id, userId: connection.userId, serverId: connection.serverId, targetHash: connection.targetHash })}`;

function personalHeaders(raw: unknown, server: McpServer): Record<string, string> {
  const input = z.record(z.string(), z.string()).parse(raw), entries = Object.entries(input);
  if (!entries.length || entries.length > 32 || Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_HEADERS_BYTES)
    throw new HttpError(400, 'Enter a bounded personal connector credential.');
  const output: Record<string, string> = {};
  for (const [name, value] of entries) {
    const normalized = name.toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/i.test(name) || reserved.test(name) || normalized === server.identityHeader?.toLowerCase()
      || Object.hasOwn(output, normalized) || !value || /[\x00-\x1f\x7f]/.test(value))
      throw new HttpError(400, 'Invalid personal connector headers.');
    // Store and redact exactly the value sent by Fetch, including its whitespace normalization.
    try {
      const wire = new Headers([[normalized, value]]).get(normalized);
      if (!wire) throw new Error('Empty connector credential.');
      output[normalized] = wire;
    } catch { throw new HttpError(400, 'Invalid personal connector headers.'); }
  }
  return output;
}

/** Does not decrypt, contact the connector or recover any shared credentials. */
export async function resolveMemberMcpConnection(userId: string, server: McpServer, q: DbOrTx = db) {
  const [connection] = await q.select().from(mcpMemberConnections)
    .where(and(eq(mcpMemberConnections.userId, userId), eq(mcpMemberConnections.serverId, server.id))).for('share');
  if (!connection || connection.status !== 'active' || connection.expiresAt.getTime() <= Date.now()
    || connection.targetHash !== memberMcpTargetHash(server)) return null;
  return connection;
}
/** No compatibility fallback: ciphertext copied between people, rows or endpoints cannot decrypt. */
export function openMemberMcpHeaders(connection: MemberMcpConnection, server: McpServer): Record<string, string> {
  if (connection.serverId !== server.id || connection.status !== 'active' || connection.expiresAt.getTime() <= Date.now()
    || connection.targetHash !== memberMcpTargetHash(server) || !connection.headersEnc.startsWith('v2.')) throw new HttpError(409, 'Reconnect your personal connector account.');
  try { return personalHeaders(JSON.parse(decrypt(connection.headersEnc, aad(connection))), server); }
  catch { throw new HttpError(409, 'Reconnect your personal connector account.'); }
}
const publicMetadata = (connection: MemberMcpConnection | null) => connection ? {
  id: connection.id, revision: connection.revision, expiresAt: connection.expiresAt.toISOString(),
  status: connection.status === 'revoked' ? 'revoked' as const : connection.expiresAt.getTime() <= Date.now() ? 'expired' as const : 'connected' as const,
} : { status: 'connection_needed' as const, revision: 0 };

/** Bot-before-user locks match Team dispatch and audience edits; no outside pool reads inside this transaction. */
async function authorizeAccountScope(p: Principal, botId: string, q: DbOrTx, allowDisabled = false) {
  try { return await authorizeTeam(p, botId, 'member', q, allowDisabled); }
  catch (error) {
    if (!(error instanceof HttpError) || error.status !== 403) throw error;
    // Admin mode has a distinct audience boundary: current admin AND assigned maintainer, never generic oversight.
    return authorizeTeam(p, botId, 'admin', q, allowDisabled);
  }
}

async function memberCapability(p: Principal, botId: string, capabilityId: string, q: DbOrTx, disconnect = false) {
  await q.select({ id: bots.id }).from(bots).where(eq(bots.id, botId)).for('share');
  await q.select({ id: users.id }).from(users).where(eq(users.id, p.user.id)).for('share');
  const current = await authorizeAccountScope(p, botId, q, disconnect);
  const capability = current.definition.toolPolicy.capabilities.find(c => c.capabilityId === capabilityId);
  if (!capability?.connectionId || (!disconnect && capability.connectionMode !== 'member_connection'))
    throw new HttpError(404, 'This capability does not require your connection.');
  const [server] = await q.select().from(mcpServers).where(eq(mcpServers.id, capability.connectionId)).for('share');
  const settings = await getSetting('tools', q);
  if (!disconnect && (settings.disabledTools.includes('mcp') || settings.disabledTools.includes(`mcp:${capability.connectionId}`)))
    throw new HttpError(409, 'This connector is disabled by your administrator.');
  const tool = server?.toolsSnapshot?.find(t => t.name === capability.action);
  if (!server) throw new HttpError(404, 'The connector account was not found.');
  if (!disconnect && (server.status !== 'enabled' || server.trust !== 'trusted' || server.toolsDrift || !server.toolsSnapshot?.length
    || server.toolsHash !== snapshotHash(server.toolsSnapshot) || !tool || capability.adapterId !== candidateResourceAdapterId(tool)
    || server.toolPolicy[capability.action!]?.enabled === false))
    throw new HttpError(409, 'This fixed connector needs an administrator’s review.');
  // Personal headers are supported only at the admin-reviewed HTTPS endpoint.
  const url = disconnect ? null : new URL(server.url);
  if (url && (url.protocol !== 'https:' || url.username || url.password)) throw new HttpError(409, 'Personal connectors require a fixed HTTPS endpoint.');
  return { capability, server };
}

export async function readTeamMemberMcpConnection(p: Principal, botId: string, capabilityId: string) {
  return db.transaction(async tx => {
    const { server } = await memberCapability(p, botId, capabilityId, tx);
    const [row] = await tx.select().from(mcpMemberConnections).where(and(eq(mcpMemberConnections.userId, p.user.id), eq(mcpMemberConnections.serverId, server.id)));
    if (row?.status === 'active' && row.targetHash !== memberMcpTargetHash(server))
      return { status: 'connection_needed' as const, revision: row.revision };
    return publicMetadata(row ?? null);
  });
}
/** Trusted account storage API; authenticating ownership at a real connector remains a separate verification gate. */
export async function saveTeamMemberMcpConnection(p: Principal, botId: string, capabilityId: string, raw: unknown) {
  const input = saveInput.parse(JSON.parse(canonicalTeamToolInput(raw))), expiresAt = new Date(input.expiresAt), now = Date.now();
  if (expiresAt.getTime() <= now || expiresAt.getTime() > now + MAX_LIFETIME_MS) throw new HttpError(400, 'Choose a future expiry within 30 days.');
  return db.transaction(async tx => {
    const { server } = await memberCapability(p, botId, capabilityId, tx);
    const headers = personalHeaders(input.headers, server);
    const [prior] = await tx.select().from(mcpMemberConnections).where(and(eq(mcpMemberConnections.userId, p.user.id), eq(mcpMemberConnections.serverId, server.id))).for('update');
    if ((prior?.revision ?? 0) !== input.expectedRevision) throw new HttpError(409, 'Your connection changed. Reload before saving.');
    const identity = { id: prior?.id ?? randomUUID(), userId: p.user.id, serverId: server.id, targetHash: memberMcpTargetHash(server) };
    const values = { headersEnc: encrypt(JSON.stringify(headers), aad(identity)), targetHash: identity.targetHash, expiresAt, status: 'active' as const };
    const [row] = prior ? await tx.update(mcpMemberConnections).set({ ...values, revision: prior.revision + 1, updatedAt: new Date() }).where(eq(mcpMemberConnections.id, prior.id)).returning()
      : await tx.insert(mcpMemberConnections).values({ ...identity, ...values }).onConflictDoNothing().returning();
    if (!row) throw new HttpError(409, 'Your connection changed. Reload before saving.');
    return publicMetadata(row);
  });
}
export async function revokeTeamMemberMcpConnection(p: Principal, botId: string, capabilityId: string, raw: unknown) {
  const input = memberMcpRevokeInput.parse(raw);
  return db.transaction(async tx => {
    const { server } = await memberCapability(p, botId, capabilityId, tx, true);
    const [row] = await tx.select().from(mcpMemberConnections).where(and(eq(mcpMemberConnections.userId, p.user.id), eq(mcpMemberConnections.serverId, server.id))).for('update');
    if (!row) throw new HttpError(404, 'Your connector account was not found.');
    if (row.revision !== input.expectedRevision) throw new HttpError(409, 'Your connection changed. Reload before disconnecting.');
    if (row.status === 'revoked') return publicMetadata(row);
    const [revoked] = await tx.update(mcpMemberConnections).set({ status: 'revoked', headersEnc: encrypt('{}', aad(row)), revision: sql`${mcpMemberConnections.revision} + 1`, updatedAt: new Date() })
      .where(eq(mcpMemberConnections.id, row.id)).returning();
    return publicMetadata(revoked);
  });
}

/** Self-revocation remains possible after removal from a bot or its policy; it grants no tool access. */
async function retainedAccountOwner(p: Principal, q: DbOrTx) {
  await q.select({ id: users.id }).from(users).where(eq(users.id, p.user.id)).for('share');
  const current = await loadPrincipal(p.user.id, q);
  if (!current || current.user.sessionVersion !== p.user.sessionVersion) throw new HttpError(403, 'Your account or session changed.');
  return current;
}

/** Settings can list retained own accounts for cleanup without restoring bot or connector access. */
export async function listOwnedMemberMcpConnections(p: Principal, cursor?: string) {
  const after = cursor === undefined ? undefined : z.uuid().parse(cursor);
  return db.transaction(async tx => {
    const current = await retainedAccountOwner(p, tx);
    const rows = await tx.select({ connection: mcpMemberConnections, name: mcpServers.name }).from(mcpMemberConnections)
      .innerJoin(mcpServers, eq(mcpMemberConnections.serverId, mcpServers.id))
      .where(and(eq(mcpMemberConnections.userId, current.user.id), after ? gt(mcpMemberConnections.id, after) : undefined))
      .orderBy(asc(mcpMemberConnections.id)).limit(101);
    return { connections: rows.slice(0, 100).map(({ connection, name }) => ({ ...publicMetadata(connection), name })),
      nextCursor: rows.length > 100 ? rows[99].connection.id : null };
  });
}

export async function revokeOwnedMemberMcpConnection(p: Principal, id: string, raw: unknown) {
  const accountId = z.string().min(1).max(200).parse(id), input = memberMcpRevokeInput.parse(raw);
  return db.transaction(async tx => {
    const current = await retainedAccountOwner(p, tx);
    const [row] = await tx.select().from(mcpMemberConnections).where(and(eq(mcpMemberConnections.id, accountId), eq(mcpMemberConnections.userId, current.user.id))).for('update');
    if (!row) throw new HttpError(404, 'Your connector account was not found.');
    if (row.revision !== input.expectedRevision) throw new HttpError(409, 'Your connection changed. Reload before disconnecting.');
    if (row.status === 'revoked') return publicMetadata(row);
    const [revoked] = await tx.update(mcpMemberConnections).set({ status: 'revoked', headersEnc: encrypt('{}', aad(row)), revision: row.revision + 1, updatedAt: new Date() })
      .where(eq(mcpMemberConnections.id, row.id)).returning();
    return publicMetadata(revoked);
  });
}

/** Only fixed required connections enter the ordinary chat flow; setup remains unavailable pending live verification. */
export async function listTeamMemberMcpConnections(p: Principal, botId: string) {
  return db.transaction(async tx => {
    await tx.select({ id: bots.id }).from(bots).where(eq(bots.id, botId)).for('share');
    const current = await authorizeAccountScope(p, botId, tx), result = [];
    for (const capability of current.definition.toolPolicy.capabilities) {
      if (capability.connectionMode !== 'member_connection' || !capability.connectionId) continue;
      const [server] = await tx.select().from(mcpServers).where(eq(mcpServers.id, capability.connectionId));
      const [row] = await tx.select().from(mcpMemberConnections).where(and(eq(mcpMemberConnections.userId, current.principal.user.id), eq(mcpMemberConnections.serverId, capability.connectionId)));
      const metadata = row?.status === 'active' && server && row.targetHash !== memberMcpTargetHash(server)
        ? { ...publicMetadata(row), status: 'connection_needed' as const } : publicMetadata(row ?? null);
      result.push({ capabilityId: capability.capabilityId, name: server?.name ?? 'Required account', ...metadata,
        available: false as const, reason: 'Connecting your own account is awaiting verification.', setup: { kind: 'unavailable' as const } });
    }
    return { connections: result };
  });
}

export function memberMcpToolConnection(userId: string, capability: TeamToolCapability, server: McpServer, connection: MemberMcpConnection | null) {
  if (capability.connectionMode !== 'member_connection' || !connection || connection.userId !== userId || connection.serverId !== server.id) return null;
  return { id: server.id, mode: 'member_connection' as const, userId, version: connection.revision, status: 'active' as const,
    expiresAt: connection.expiresAt.getTime(), bindingHash: memberMcpBindingHash(server, connection) };
}

/** Worker key rotation is serialized with explicit saves/disconnects and invalidates old approval bindings. */
export async function rewrapMemberMcpSecrets(): Promise<number> {
  let changed = 0;
  for (const { id } of await db.select({ id: mcpMemberConnections.id }).from(mcpMemberConnections)) {
    const did = await db.transaction(async tx => {
      const [row] = await tx.select().from(mcpMemberConnections).where(eq(mcpMemberConnections.id, id)).for('update');
      if (!row) return false;
      if (!row.headersEnc.startsWith('v2.')) throw new HttpError(409, 'A personal connector credential requires reconciliation.');
      const next = rewrap(row.headersEnc, aad(row));
      if (!next) return false;
      await tx.update(mcpMemberConnections).set({ headersEnc: next, revision: row.revision + 1, updatedAt: new Date() }).where(eq(mcpMemberConnections.id, id));
      return true;
    });
    if (did) changed++;
  }
  return changed;
}
