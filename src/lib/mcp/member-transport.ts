import 'server-only';
import type { McpServer } from '@/db/schema';
import { HttpError } from '@/lib/authz';
import { connectMcpWithHeaders, redactMcpSecrets, type McpCaller } from './client';
import { openMemberMcpHeaders, type MemberMcpConnection } from './member-connections';

/** A member transport cannot inherit the endpoint's shared bearer or signing secret. */
export function memberMcpServer(server: McpServer): McpServer {
  return { ...server, headersEnc: null, identityHeader: null, identitySecretEnc: null, timeoutMs: Math.min(server.timeoutMs, 45000) };
}
export async function connectMemberMcp(server: McpServer, connection: MemberMcpConnection, caller: McpCaller, signal?: AbortSignal) {
  if (caller.subject.kind !== 'user' || caller.subject.id !== connection.userId || !caller.authorize)
    throw new HttpError(403, 'A freshly authorized owner is required for this connector account.');
  if (new URL(server.url).protocol !== 'https:') throw new HttpError(409, 'Personal connectors require HTTPS.');
  // Reauthorize before decrypting, including when called outside the normal native service.
  const current = await caller.authorize();
  if (current.subject.kind !== 'user' || current.subject.id !== connection.userId)
    throw new HttpError(403, 'The connector account owner changed.');
  const headers = openMemberMcpHeaders(connection, server);
  return connectMcpWithHeaders(memberMcpServer(server), caller, headers, signal);
}
export function redactMemberMcpValue<T>(value: T, server: McpServer, connection: MemberMcpConnection): T {
  const secrets = Object.values(openMemberMcpHeaders(connection, server)).flatMap(value => [value, value.replace(/^(Bearer|Basic)\s+/i, '')]).filter(Boolean);
  return redactMcpSecrets(value, secrets);
}
