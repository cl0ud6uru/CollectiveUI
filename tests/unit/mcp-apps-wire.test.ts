import { afterEach, expect, it, vi } from 'vitest';
import type { McpServer } from '@/db/schema';
vi.mock('@/lib/mcp/url', () => ({ checkMcpUrl: async () => null }));
import { connectMcp, redactMcpValue } from '@/lib/mcp/client';
import { sealIdentitySecret } from '@/lib/mcp/identity';
import { AAD, encrypt } from '@/lib/crypto';
import { listAllTools } from '@/lib/mcp/snapshot';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('preserves widget metadata over the real SDK/transport, advertises UI, and reauthorizes identity on every wire request', async () => {
  vi.stubEnv('ENCRYPTION_KEY', 'synthetic-wire-encryption'); vi.stubEnv('ENCRYPTION_KEYS', ''); vi.stubEnv('ENCRYPTION_PRIMARY_KID', '');
  const secret = 'synthetic-wire-bearer', privateMarker = 'SYNTHETIC_WIRE_METADATA';
  const server = { id: 'synthetic-wire', url: 'https://wire.example.invalid/mcp', transport: 'http', timeoutMs: 1000,
    headersEnc: encrypt(JSON.stringify({ Authorization: `Bearer ${secret}` }), AAD.mcpHeaders), identityHeader: 'X-Portal-Identity',
    identitySecretEnc: sealIdentitySecret('synthetic-wire', 'synthetic-identity-only') } as McpServer;
  const seen: { body: Record<string, unknown>; headers: Headers; redirect: unknown }[] = [];
  const wire = vi.fn<typeof fetch>(async (_input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    seen.push({ body, headers: new Headers(init?.headers), redirect: init?.redirect });
    if (body.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (body.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'Synthetic wire', version: '1' } };
    else if (body.method === 'tools/list') result = { tools: [{ name: 'view', inputSchema: { type: 'object' }, _meta: { ui: { resourceUri: 'ui://wire/view' } } }] };
    else if (body.method === 'tools/call') result = { content: [{ type: 'text', text: secret }], structuredContent: { rows: [1, 2] }, _meta: { privateMarker, echoed: secret } };
    else if (body.method === 'resources/read') result = { contents: [{ uri: 'ui://wire/view', mimeType: 'text/html;profile=mcp-app', text: '<table></table>' }] };
    else throw new Error(`Unexpected synthetic method ${body.method}`);
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  });
  vi.stubGlobal('fetch', wire);
  let revoked = false;
  const caller = { apps: true, botId: 'synthetic-bot', conversationId: 'synthetic-chat',
    subject: { kind: 'user' as const, id: 'synthetic-owner', upn: 'owner@example.invalid', email: null, name: 'Owner', groups: [] },
    authorize: vi.fn(async () => { if (revoked) throw new Error('Synthetic revoked'); return { subject: caller.subject, botId: caller.botId, conversationId: caller.conversationId }; }) };
  const client = await connectMcp(server, caller);
  try {
    expect((await listAllTools(client))[0]._meta?.ui?.resourceUri).toBe('ui://wire/view');
    const result = redactMcpValue(await client.callTool({ name: 'view', arguments: {} }), server);
    expect(result.structuredContent).toEqual({ rows: [1, 2] }); expect(result._meta).toEqual({ privateMarker, echoed: '[redacted]' });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect((await client.readResource({ uri: 'ui://wire/view' })).contents[0]).toMatchObject({ text: '<table></table>' });
    const initialize = seen.find(request => request.body.method === 'initialize')!;
    expect((initialize.body.params as { capabilities: unknown }).capabilities).toMatchObject({ extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } });
    for (const request of seen) {
      expect(request.headers.get('authorization')).toBe(`Bearer ${secret}`); expect(request.redirect).toBe('error');
      const claims = JSON.parse(Buffer.from(request.headers.get('x-portal-identity')!.split('.')[1], 'base64url').toString());
      expect(claims).toMatchObject({ sub: 'synthetic-owner', bot: 'synthetic-bot', conv: 'synthetic-chat', aud: server.url });
    }
    const before = wire.mock.calls.length; revoked = true;
    await expect(client.callTool({ name: 'view', arguments: {} })).rejects.toThrow(); expect(wire).toHaveBeenCalledTimes(before);
    expect(caller.authorize.mock.calls.length).toBeGreaterThanOrEqual(seen.length);
  } finally { await client.close().catch(() => {}); }
});
