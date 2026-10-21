import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DashboardClient, type DashboardSecrets } from '@/lib/remote-hermes/client';
import { nativeMcpAuthorizationURL, nativeMcpOAuthSlot } from '@/lib/remote-hermes/mcp-oauth-contract';
import { startPinnedDashboard } from '../fixtures/remote-hermes-dashboard';

const enabled = process.env.REMOTE_HERMES_DASHBOARD_CONFORMANCE === '1';
let fixture: Awaited<ReturnType<typeof startPinnedDashboard>>;
let client: DashboardClient, secrets: DashboardSecrets;
const nativeBase = 'https://native.example.invalid/hermes';
async function metrics() {
  return (await fetch(fixture.base + '/api/__fixture/metrics', { headers: { Authorization: `Bearer ${secrets.accessToken}` } })).json();
}
describe.skipIf(!enabled)('exact pinned native MCP OAuth REST/callback contract; synthetic worker only', () => {
  beforeAll(async () => {
    fixture = await startPinnedDashboard();
    secrets = await new DashboardClient(fixture.base, fetch).passwordLogin('synthetic', 'synthetic-password');
    client = new DashboardClient(fixture.base, fetch, secrets);
    const response = await fetch(fixture.base + '/api/__fixture/control', { method: 'POST', headers: { Authorization: `Bearer ${secrets.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ prepare_mcp_oauth: true }) });
    expect(response.ok).toBe(true); await response.body?.cancel();
  }, 45000);
  afterAll(async () => { await fixture?.stop(); });
  it('uses a native HTTPS callback while the RPC rejects public HTTPS client redirects', async () => {
    const started = await client.startMcpOAuth('default', 'fixture-oauth');
    expect(started.status).toBe('authorization_required');
    expect(started.flow_id).not.toBe('runtime');
    const url = new URL(nativeMcpAuthorizationURL(nativeBase, 'fixture-oauth', started.authorization_url));
    expect(url.searchParams.get('redirect_uri')).toBe(nativeBase + '/api/mcp/oauth/callback/fixture-oauth');
    expect((await metrics()).mcp_rpc_https_callback_rejected).toBe(true);
    for (const [name, slot] of Object.entries((await metrics()).mcp_oauth_filename_cases)) expect(nativeMcpOAuthSlot(name)).toBe(slot);
    expect((await client.mcpOAuthFlow(started.flow_id)).status).toBe('authorization_required');
    expect(await client.cancelMcpOAuth(started.flow_id)).toEqual({ ok: true, status: 'error' });
    await expect.poll(async () => (await client.mcpOAuthFlow(started.flow_id)).status).toBe('error');
  });
  it('rejects wrong callback state, approves asynchronously, and never treats cancellation as revocation', async () => {
    const started = await client.startMcpOAuth('default', 'fixture-oauth');
    const url = new URL(started.authorization_url!);
    const path = '/api/mcp/oauth/callback/fixture-oauth';
    const wrong = await fetch(fixture.base + path + '?code=synthetic-code&state=wrong');
    expect(wrong.status).toBe(404); await wrong.body?.cancel();
    expect((await client.mcpOAuthFlow(started.flow_id)).status).toBe('authorization_required');
    const accepted = await fetch(fixture.base + path + '?' + new URLSearchParams({ code: 'synthetic-code', state: url.searchParams.get('state')!, iss: 'https://auth.example.invalid' }));
    expect(accepted.ok).toBe(true); await accepted.body?.cancel();
    await expect.poll(async () => (await client.mcpOAuthFlow(started.flow_id)).status).toBe('approved');
    expect(await client.cancelMcpOAuth(started.flow_id)).toEqual({ ok: true, status: 'approved' });
    expect((await client.mcpOAuthFlow(started.flow_id)).status).toBe('approved');
    const replay = await fetch(fixture.base + path + '?' + new URLSearchParams({ code: 'synthetic-code', state: url.searchParams.get('state')! }));
    expect(replay.status).toBe(404); await replay.body?.cancel();
    const evidence = await metrics();
    expect(evidence.mcp_oauth_starts).toBe(2); expect(evidence.mcp_oauth_approvals).toBe(1);
    expect(evidence.external_attempts).toBe(0);
  });
});
