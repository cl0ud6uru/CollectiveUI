const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
const secure = (url: URL) => url.protocol === 'https:' || (url.protocol === 'http:' && loopback.has(url.hostname));

/** Safe to show to administrators or include in a tool result: never echo configuration values. */
export function mcpAppSandboxConfig(): { url: string; issue: null } | { url: null; issue: string } {
  if (!process.env.MCP_APPS_SANDBOX_URL) return { url: null, issue:
    'Interactive widget unavailable: MCP_APPS_SANDBOX_URL is not configured. Ask an administrator to enable the dedicated widget sandbox and set its URL on both web and worker. See docs/architecture/mcp-apps.md.' };
  try {
    const host = new URL(process.env.AUTH_URL!);
    if (!secure(host) || host.href !== `${host.origin}/`) throw new Error();
  } catch {
    return { url: null, issue: 'Interactive widget unavailable: AUTH_URL must be the public CollectiveUI HTTPS origin (HTTP is allowed only on loopback). Ask an administrator to correct it on both web and worker.' };
  }
  try {
    const host = new URL(process.env.AUTH_URL!);
    const sandbox = new URL(process.env.MCP_APPS_SANDBOX_URL);
    if (!secure(sandbox) || host.origin === sandbox.origin || sandbox.href !== `${sandbox.origin}/sandbox`) throw new Error();
    return { url: sandbox.href, issue: null };
  } catch {
    return { url: null, issue:
      'Interactive widget unavailable: MCP_APPS_SANDBOX_URL must use a distinct, cookieless HTTPS origin and the exact /sandbox path, without credentials, query or fragment (HTTP is allowed only on loopback). Ask an administrator to correct it on both web and worker. See docs/architecture/mcp-apps.md.' };
  }
}
