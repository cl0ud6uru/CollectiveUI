import { createServer } from 'node:http';

/** Dedicated, cookieless origin. Never run a general web server or proxy the application on this origin. */
export function createMcpAppSandbox(hostOrigin) {
  const host = new URL(hostOrigin).origin;
  const script = `(() => {
    const expected = ${JSON.stringify(host)};
    if (window === window.top) return;
    const inner = document.createElement('iframe');
    inner.title = 'Widget content';
    inner.style = 'width:100%;height:100%;border:0';
    inner.setAttribute('sandbox', 'allow-scripts allow-forms');
    inner.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; payment 'none'; fullscreen 'none'");
    document.body.append(inner);
    let loaded = false;
    window.addEventListener('message', e => {
      if (e.source === window.parent && e.origin === expected) {
        if (e.data?.method === 'ui/notifications/sandbox-resource-ready') {
          if (loaded || typeof e.data.params?.html !== 'string' || e.data.params.html.length > 1500000) return;
          loaded = true; inner.srcdoc = e.data.params.html;
        } else if (loaded) inner.contentWindow.postMessage(e.data, '*');
      } else if (e.source === inner.contentWindow && e.origin === 'null' && loaded) {
        if (e.data?.method === 'ui/notifications/sandbox-proxy-ready' || e.data?.method === 'ui/notifications/sandbox-resource-ready') return;
        window.parent.postMessage(e.data, expected);
      }
    });
    window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/sandbox-proxy-ready',params:{}}, expected);
  })();`;
  return createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/sandbox') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      // Inherited by srcdoc. Removing or adding a meta policy cannot relax an HTTP CSP.
      'Content-Security-Policy': `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${host}; sandbox allow-scripts allow-same-origin allow-forms`,
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), payment=(), fullscreen=(), usb=(), serial=()',
    });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>CollectiveUI widget sandbox</title><style>html,body{margin:0;height:100%;overflow:hidden}</style></head><body><script>${script}</script></body></html>`);
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (!process.env.MCP_APPS_HOST_ORIGIN) throw new Error('MCP_APPS_HOST_ORIGIN is required.');
  const server = createMcpAppSandbox(process.env.MCP_APPS_HOST_ORIGIN);
  server.listen(Number(process.env.MCP_APPS_SANDBOX_PORT ?? 3102), process.env.MCP_APPS_SANDBOX_HOST ?? '127.0.0.1', () => console.log('MCP Apps sandbox listening'));
}
