import { expect, it, vi } from 'vitest';
import { DashboardClient } from '@/lib/remote-hermes/client';
it('uses exact native REST start/status/cancel routes with a separate flow identity', async () => {
  const flowId = 'synthetic-native-flow-12345678';
  const transport = vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => init.method === 'DELETE'
    ? Response.json({ ok: true, status: 'approved', token: 'synthetic-secret' })
    : Response.json({ flow_id: flowId, server_name: 'team-api', status: 'authorization_required', authorization_url: 'https://auth.example.invalid/authorize', error: 'synthetic-secret', access_token: 'synthetic-secret' }));
  const client = new DashboardClient('https://native.example.invalid/hermes', transport, { mode: 'sessionToken', sessionToken: 'synthetic-session-token' });
  const start = await client.startMcpOAuth('worker profile', 'team-api');
  const status = await client.mcpOAuthFlow(flowId);
  const cancel = await client.cancelMcpOAuth(flowId);
  expect(JSON.stringify([start, status, cancel])).not.toContain('synthetic-secret');
  expect(transport.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
    ['https://native.example.invalid/hermes/api/mcp/servers/team-api/auth?profile=worker+profile', 'POST'],
    [`https://native.example.invalid/hermes/api/mcp/oauth/flows/${flowId}`, 'GET'],
    [`https://native.example.invalid/hermes/api/mcp/oauth/flows/${flowId}`, 'DELETE'],
  ]);
  expect(transport.mock.calls[0][1]?.body).toBe('{}');
  expect(new Headers(transport.mock.calls[0][1]?.headers).get('X-Hermes-Session-Token')).toBe('synthetic-session-token');
});
it('rejects path-ambiguous server and flow identities before dispatch', async () => {
  const transport = vi.fn();
  const client = new DashboardClient('https://native.example.invalid', transport);
  await expect(client.startMcpOAuth('default', '../other')).rejects.toThrow();
  await expect(client.mcpOAuthFlow('../other')).rejects.toThrow();
  await expect(client.cancelMcpOAuth('bad/id')).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
});
