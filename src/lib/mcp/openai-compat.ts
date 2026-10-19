/** Small legacy surface on top of MCP Apps JSON-RPC. No ChatGPT APIs or privileges are implied. */
function compatibilityBootstrap() {
  let sequence = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const notify = (method: string, params?: unknown) => window.parent.postMessage({ jsonrpc: '2.0', method, params: params ?? {} }, '*');
  const request = (method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Widget request timed out.')); }, 180000);
    pending.set(id, { resolve, reject, timer });
    window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
  });
  const globals: Record<string, unknown> = { toolInput: {}, toolOutput: null, toolResponseMetadata: {}, widgetState: null,
    theme: 'light', locale: navigator.language, displayMode: 'inline', maxHeight: 800 };
  const update = (values: Record<string, unknown>) => {
    Object.assign(globals, values);
    window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: values } }));
  };
  const unsupported = () => Promise.reject(new Error('This host does not support this ChatGPT capability.'));
  const api = Object.assign(globals, {
    callTool: async (name: string, args: Record<string, unknown> = {}) => {
      const result = await request('tools/call', { name, arguments: args }) as { structuredContent?: unknown; content?: unknown[]; _meta?: unknown };
      return result;
    },
    setWidgetState: (state: unknown) => { update({ widgetState: state }); },
    requestDisplayMode: async ({ mode }: { mode: string }) => {
      if (mode !== 'inline') throw new Error('Only inline widgets are supported.');
      return { mode: 'inline' };
    },
    notifyIntrinsicHeight: (height: number) => { if (Number.isFinite(height)) notify('ui/notifications/size-changed', { height }); },
    sendFollowUpMessage: unsupported, openExternal: unsupported, requestModal: unsupported, uploadFile: unsupported,
    getFileDownloadUrl: unsupported, requestClose: () => notify('ui/notifications/request-teardown'),
  });
  Object.defineProperty(window, 'openai', { value: api, writable: false, configurable: false });
  window.addEventListener('message', event => {
    if (event.source !== window.parent || !event.data || event.data.jsonrpc !== '2.0') return;
    const message = event.data;
    if (typeof message.id === 'number' && pending.has(message.id)) {
      const waiting = pending.get(message.id)!; pending.delete(message.id); clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new Error('The widget request was refused.'));
      else waiting.resolve(message.result);
      return;
    }
    if (message.method === 'ui/notifications/tool-input') update({ toolInput: message.params?.arguments ?? {} });
    if (message.method === 'ui/notifications/tool-result') update({ toolOutput: message.params?.structuredContent ?? null, toolResponseMetadata: message.params?._meta ?? {} });
    if (message.method === 'ui/notifications/host-context-changed') update({ theme: message.params?.theme ?? globals.theme });
    if (message.method === 'ui/resource-teardown') {
      for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error('Widget closed.')); }
      pending.clear();
      window.parent.postMessage({ jsonrpc: '2.0', id: message.id, result: {} }, '*');
    }
  });
  void request('ui/initialize', { appInfo: { name: 'CollectiveUI OpenAI compatibility', version: '1.0.0' }, appCapabilities: {}, protocolVersion: '2026-01-26' })
    .then(result => { const host = result as { hostContext?: Record<string, unknown> }; update({ theme: host.hostContext?.theme ?? 'light' }); notify('ui/notifications/initialized'); })
    .catch(() => update({ toolResponseMetadata: { error: 'Widget initialization failed.' } }));
}

export function withOpenAICompatibility(html: string) {
  return `<!doctype html><script>(${compatibilityBootstrap.toString()})();</script>${html}`;
}
