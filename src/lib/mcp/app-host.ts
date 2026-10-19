import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { AppView } from './apps-contract';
import { withOpenAICompatibility } from './openai-compat';

/** Official AppBridge; handlers are registered before loading either iframe. No direct MCP credentials in browser. */
export async function mountMcpApp(frame: HTMLIFrameElement, view: AppView, handlers: {
  callTool: (name: string, input: Record<string, unknown>) => Promise<AppView['result']>;
  error: (message: string) => void;
  ready: () => void;
  close: () => void;
}) {
  const sandbox = new URL(view.sandboxUrl);
  if (sandbox.origin === window.location.origin) throw new Error('The widget sandbox must have a separate origin.');
  const bridge = new AppBridge(null, { name: 'CollectiveUI', version: '1.0.0' }, { serverTools: {}, sandbox: { csp: {}, permissions: {} } }, {
    hostContext: { theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light', displayMode: 'inline',
      availableDisplayModes: ['inline'], platform: 'web', locale: navigator.language, containerDimensions: { maxHeight: 800 } },
  });
  let disposed = false, initialized = false;
  const timeout = window.setTimeout(() => { if (!initialized && !disposed) handlers.error('The widget did not initialize.'); }, 15000);
  const rejectOtherOrigins = (event: MessageEvent) => {
    if (event.source === frame.contentWindow && event.origin !== sandbox.origin) event.stopImmediatePropagation();
  };
  window.addEventListener('message', rejectOtherOrigins);
  bridge.oncalltool = async params => {
    if (disposed) throw new Error('Widget closed.');
    return await handlers.callTool(params.name, params.arguments ?? {}) as never;
  };
  bridge.onrequestdisplaymode = async () => ({ mode: 'inline' });
  bridge.addEventListener('sizechange', ({ height }) => {
    if (typeof height === 'number' && Number.isFinite(height)) frame.style.height = `${Math.max(120, Math.min(800, height))}px`;
  });
  bridge.addEventListener('requestteardown', () => { handlers.close(); });
  bridge.addEventListener('initialized', () => {
    if (initialized || disposed) return;
    initialized = true; clearTimeout(timeout);
    void bridge.sendToolInput({ arguments: view.input }).then(() => bridge.sendToolResult(view.result as never)).then(handlers.ready).catch(() => handlers.error('The widget data could not be delivered.'));
  });
  bridge.addEventListener('sandboxready', () => {
    if (disposed) return;
    void bridge.sendSandboxResourceReady({ html: view.compatibility ? withOpenAICompatibility(view.html) : view.html,
      sandbox: 'allow-scripts allow-forms', csp: {}, permissions: {} }).catch(() => handlers.error('The widget sandbox could not be loaded.'));
  });
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; payment 'none'; fullscreen 'none'");
  await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
  const observer = new MutationObserver(() => {
    if (initialized && !disposed) void bridge.sendHostContextChange({ theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light' });
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  const resize = new ResizeObserver(([entry]) => {
    if (initialized && !disposed) void bridge.sendHostContextChange({ containerDimensions: { width: Math.round(entry.contentRect.width), maxHeight: 800 } });
  });
  resize.observe(frame);
  frame.src = sandbox.href;
  return async () => {
    if (disposed) return;
    disposed = true; clearTimeout(timeout); observer.disconnect(); resize.disconnect();
    if (initialized) await bridge.teardownResource({}, { timeout: 500 }).catch(() => {});
    await bridge.close();
    window.removeEventListener('message', rejectOtherOrigins);
    frame.removeAttribute('src');
  };
}
