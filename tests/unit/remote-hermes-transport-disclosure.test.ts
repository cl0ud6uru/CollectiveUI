import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('@/app/(chat)/settings/remote-hermes-actions', () => ({ signIntoRemoteHermes: vi.fn(), loadRemoteHermesProfiles: vi.fn() }));
import { RemoteHermes } from '@/components/settings/remote-hermes';
import { dashboardTransportDisclosure } from '@/lib/remote-hermes/transport-contract';
import { dashboardBase } from '@/lib/remote-hermes/policy';
import { DashboardClient } from '@/lib/remote-hermes/client';
import { DashboardSocket } from '@/lib/remote-hermes/socket';
const sockets: DashboardSocket[] = [];
afterEach(() => { for (const socket of sockets.splice(0)) socket.close(); });
describe('RemoteHermes transport trust disclosure', () => {
  it.each(['http://192.168.1.10:9119', 'http://127.0.0.1:9119', 'http://hermes.internal:9119'])('does not equate approved/private/loopback addressing with encryption (%s)', base => {
    expect(dashboardTransportDisclosure(base)).toMatch(/HTTP.*not encrypted/);
    expect(dashboardTransportDisclosure(base)).toMatch(/approval.*does not/);
    expect(dashboardTransportDisclosure(base)).toMatch(/passwords, tokens and protected replies/);
  });
  it('does not invent trust classification for TLS or invalid drafts', () => {
    expect(dashboardTransportDisclosure('https://hermes.example.com')).toBeNull();
    expect(dashboardTransportDisclosure('unparsed draft')).toBeNull();
  });
  it('shows a retained HTTP connection warning even when admission is disabled', () => {
    const markup = renderToStaticMarkup(createElement(RemoteHermes, { allowed: false, initial: [{ id: 'fixture', name: 'Synthetic', baseUrl: 'http://hermes.internal:9119', authMode: 'sessionToken', version: null }] }));
    expect(markup).toContain('HTTP is not encrypted');
    expect(markup).toContain('protected replies');
  });
  it('omits raw invalid base URLs from validation errors', () => {
    let error: unknown;
    try { dashboardBase('invalid-url?token=synthetic-token'); } catch (caught) { error = caught; }
    expect(error).toHaveProperty('status', 400);
    expect(String(error)).not.toContain('synthetic-token');
    expect(error).not.toHaveProperty('input');
  });
  it('omits authentication URLs from unexpected socket-target errors without logging them', async () => {
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const socket = new DashboardSocket(async () => { throw new Error('ws://hermes.internal/api/ws?token=synthetic-token&ticket=synthetic-ticket'); }, () => {});
      sockets.push(socket);
      const error = await socket.connect().catch(caught => caught);
      expect(error).toHaveProperty('status', 502);
      expect(String(error)).not.toMatch(/synthetic-token|synthetic-ticket|api\/ws/);
      expect(error).not.toHaveProperty('cause');
      expect(logger).not.toHaveBeenCalled();
    } finally { logger.mockRestore(); }
  });
  it('omits native callback auth codes from malformed callback errors', async () => {
    let calls = 0;
    const transport = (async () => {
      ++calls;
      if (calls === 1) return new Response(JSON.stringify({ providers: [{ name: 'fixture', supports_password: true }] }));
      if (calls === 2) return new Response(null, { status: 302, headers: { 'Set-Cookie': 'fixture=synthetic' } });
      return new Response(JSON.stringify({ next: 'invalid-callback?code=synthetic-code&state=synthetic-state' }));
    }) as typeof fetch;
    const error = await new DashboardClient('https://hermes.example.com', transport).passwordLogin('synthetic', 'synthetic').catch(caught => caught);
    expect(error).toHaveProperty('status', 502);
    expect(String(error)).not.toMatch(/synthetic-code|synthetic-state/);
    expect(error).not.toHaveProperty('input');
  });
});
