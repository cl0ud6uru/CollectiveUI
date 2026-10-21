import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createMcpAppSandbox, mcpAppsHostOrigin } from '../../scripts/mcp-app-sandbox.mjs';

const server = createMcpAppSandbox('https://portal.example.invalid');
let origin: string;
beforeAll(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

it('serves only the sandbox document with inherited CSP, exact parent and no cookies or app routes', async () => {
  const response = await fetch(`${origin}/sandbox`);
  expect(response.status).toBe(200); expect(response.headers.get('set-cookie')).toBeNull();
  expect(response.headers.get('cache-control')).toBe('no-store');
  const csp = response.headers.get('content-security-policy')!;
  for (const directive of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "object-src 'none'", 'frame-ancestors https://portal.example.invalid']) expect(csp).toContain(directive);
  expect(response.headers.get('permissions-policy')).toContain('camera=()');
  const html = await response.text();
  expect(html).toContain("inner.setAttribute('sandbox', 'allow-scripts allow-forms')");
  expect(html).toContain('e.source === window.parent && e.origin === expected');
  expect(html).toContain("e.source === inner.contentWindow && e.origin === 'null'");
  for (const path of ['/', '/api/health', '/sandbox/', '/sandbox?x=1', '/api/auth/session']) expect((await fetch(`${origin}${path}`)).status).toBe(404);
  expect((await fetch(`${origin}/sandbox`, { method: 'POST' })).status).toBe(404);
});

it('rejects unsafe parent origins using fixed diagnostics and permits HTTPS or loopback HTTP only', () => {
  for (const value of [undefined, '', 'null', 'file:///tmp/widget', 'http://public.example.invalid', 'https://PRIVATE_USER:PRIVATE_SECRET@host.invalid', 'https://host.invalid/path', 'https://host.invalid?PRIVATE_QUERY', 'https://host.invalid/#fragment', 'https://host.invalid/?', 'https://host.invalid/#']) {
    expect(() => mcpAppsHostOrigin(value)).toThrow('MCP_APPS_HOST_ORIGIN must be');
    try { mcpAppsHostOrigin(value); } catch (error) { expect(String(error)).not.toMatch(/PRIVATE_|file:\/\//); }
  }
  for (const value of ['https://portal.example.invalid', 'http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) expect(mcpAppsHostOrigin(value)).toBe(value);
});
