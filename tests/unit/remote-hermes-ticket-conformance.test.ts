import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DashboardClient, type DashboardSecrets } from '@/lib/remote-hermes/client';
import { DashboardSocket } from '@/lib/remote-hermes/socket';
import { websocketAuthentication } from '@/lib/remote-hermes/websocket-auth';
import { DASHBOARD_PIN, startTicketDashboard } from '../fixtures/remote-hermes-ticket-dashboard';

const enabled = process.env.REMOTE_HERMES_TICKET_CONFORMANCE === '1';
let fixture: Awaited<ReturnType<typeof startTicketDashboard>>;
let client: DashboardClient, secrets: DashboardSecrets, base: string;
const target = () => new URL(`${base.replace('http:', 'ws:')}/api/ws`);

/** Return fixed handshake facts only; never retain an upstream error or credential. */
async function upgrade(url: URL, protocols?: string[]) {
  return new Promise<{ accepted: boolean; protocol?: string; status?: number }>(resolve => {
    const options = { handshakeTimeout: 5000, followRedirects: false, perMessageDeflate: false };
    const ws = protocols ? new WebSocket(url, protocols, options) : new WebSocket(url, options);
    const timer = setTimeout(() => { ws.terminate(); resolve({ accepted: false }); }, 6000);
    const finish = (result: { accepted: boolean; protocol?: string; status?: number }) => {
      clearTimeout(timer); resolve(result);
    };
    ws.on('open', () => { finish({ accepted: true, protocol: ws.protocol }); ws.close(); });
    ws.on('unexpected-response', (_request, response) => {
      response.resume(); finish({ accepted: false, status: response.statusCode }); ws.terminate();
    });
    ws.on('error', () => finish({ accepted: false }));
  });
}

describe.skipIf(!enabled)('actual pinned gated native WebSocket ticket/subprotocol contract', () => {
  beforeAll(async () => {
    fixture = await startTicketDashboard(); base = fixture.base;
    const bootstrap = new DashboardClient(base, fetch);
    expect(await bootstrap.status()).toMatchObject({ version: '0.21.5', authRequired: true });
    secrets = await bootstrap.passwordLogin('synthetic', 'synthetic-password');
    client = new DashboardClient(base, fetch, secrets);
  }, 45000);
  afterAll(async () => { await fixture?.stop(); });

  it('requires synthetic authenticated native login before minting a ticket', async () => {
    const response = await fetch(`${base}/api/auth/ws-ticket`, { method: 'POST' });
    expect(response.status).toBe(401); await response.body?.cancel();
    expect((await client.websocketTicket()).length > 0).toBe(true);
  });
  it('accepts the app-generated subprotocol with no URL credential and selects only the public protocol', async () => {
    const ticket = await client.websocketTicket();
    const auth = websocketAuthentication(target(), secrets, ticket);
    expect(auth.url.search).toBe('');
    expect(auth.url.toString().includes(ticket)).toBe(false);
    const result = await upgrade(auth.url, auth.protocols);
    expect(result).toEqual({ accepted: true, protocol: 'hermes-gateway-v1' });
    expect(await upgrade(auth.url, auth.protocols)).toEqual({ accepted: false, status: 403 });
  });
  it('negotiates actual native readiness and approvals through the production socket and helper', async () => {
    let cleanUrl = false;
    const socket = new DashboardSocket(async () => {
      const ticket = await client.websocketTicket();
      const auth = websocketAuthentication(target(), secrets, ticket);
      cleanUrl = !auth.url.search && !auth.url.toString().includes(ticket);
      return { ...auth, options: {} };
    }, () => {});
    try {
      await socket.connect();
      expect(cleanUrl).toBe(true);
      expect(socket.state).toBe('connected');
      expect(socket.serverRequests).toContain('approval');
    } finally { socket.close(); }
  });
  it('rejects an unknown ticket in the otherwise valid pinned protocol set', async () => {
    const auth = websocketAuthentication(target(), secrets, 'synthetic-never-minted');
    expect(await upgrade(auth.url, auth.protocols)).toEqual({ accepted: false, status: 403 });
  });
  it('rejects missing/ambiguous public protocol sets without consuming the ticket', async () => {
    const ticket = await client.websocketTicket();
    expect(await upgrade(target(), [`hermes-gateway-ticket.${ticket}`])).toEqual({ accepted: false, status: 403 });
    expect(await upgrade(target(), ['hermes-gateway-v1', `hermes-gateway-ticket.${ticket}`, 'hermes-gateway-ticket.synthetic-second'])).toEqual({ accepted: false, status: 403 });
    const auth = websocketAuthentication(target(), secrets, ticket);
    expect(await upgrade(auth.url, auth.protocols)).toEqual({ accepted: true, protocol: 'hermes-gateway-v1' });
  });
  it('rejects even the correct legacy session token in gated mode', async () => {
    const auth = websocketAuthentication(target(), { mode: 'sessionToken', sessionToken: 'synthetic-loopback-only' });
    expect(await upgrade(auth.url, auth.protocols)).toEqual({ accepted: false, status: 403 });
  });
  it('has used the exact pin without any external network attempt', async () => {
    const response = await fetch(`${base}/api/__fixture/metrics`, { headers: { Authorization: `Bearer ${secrets.accessToken}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pin: DASHBOARD_PIN, external_attempts: 0, agent_attempts: 0 });
  });
});
