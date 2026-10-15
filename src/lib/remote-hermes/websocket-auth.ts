import { HttpError } from '@/lib/authz';
import type { DashboardSecrets } from './client';

const GATEWAY_PROTOCOL = 'hermes-gateway-v1';
const TICKET_PROTOCOL_PREFIX = 'hermes-gateway-ticket.';

/** Keep the legacy native token query only where the pinned runtime requires it. */
export function websocketAuthentication(url: URL, secrets: DashboardSecrets, ticket?: string) {
  const target = new URL(url);
  if (secrets.mode === 'sessionToken') {
    target.searchParams.set('token', secrets.sessionToken!);
    return { url: target, protocols: undefined };
  }
  // The pinned native endpoint returns secrets.token_urlsafe(32), which is safe
  // for an RFC 6455 subprotocol token. Reject malformed upstream values rather
  // than placing arbitrary response text in the upgrade header.
  if (!ticket || !/^[A-Za-z0-9_-]{1,256}$/.test(ticket))
    throw new HttpError(502, 'Hermes returned an invalid WebSocket ticket. Sign in again.');
  target.searchParams.delete('ticket');
  target.searchParams.delete('token');
  return { url: target, protocols: [GATEWAY_PROTOCOL, `${TICKET_PROTOCOL_PREFIX}${ticket}`] };
}
