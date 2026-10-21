import type { McpToolDef } from './kinds';

export type McpAppMeta = {
  ui?: { resourceUri?: string; visibility?: ('model' | 'app')[] };
  'ui/resourceUri'?: string;
  'openai/outputTemplate'?: string;
  'openai/widgetAccessible'?: boolean;
};

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const isUiUri = (v: unknown): v is string => typeof v === 'string' && v.length <= 2048 && /^ui:\/\/[^\s\u0000-\u001f\u007f]+$/u.test(v);

/** Only reviewed host routing/visibility fields survive. Invalid security fields reject the descriptor. */
export function appToolMeta(value: unknown): McpAppMeta | undefined {
  if (!record(value)) return undefined;
  const meta: McpAppMeta = {};
  if (value.ui !== undefined) {
    if (!record(value.ui)) throw new Error('Invalid MCP App UI metadata');
    const ui: NonNullable<McpAppMeta['ui']> = {};
    if (value.ui.resourceUri !== undefined) {
      if (!isUiUri(value.ui.resourceUri)) throw new Error('Invalid MCP App resource URI');
      ui.resourceUri = value.ui.resourceUri;
    }
    if (value.ui.visibility !== undefined) {
      const v = value.ui.visibility;
      if (!Array.isArray(v) || !v.length || v.length > 2 || v.some(x => x !== 'model' && x !== 'app') || new Set(v).size !== v.length)
        throw new Error('Invalid MCP App visibility');
      ui.visibility = [...v].sort();
    }
    if (Object.keys(ui).length) meta.ui = ui;
  }
  for (const key of ['ui/resourceUri', 'openai/outputTemplate'] as const) {
    if (value[key] !== undefined) {
      if (!isUiUri(value[key])) throw new Error('Invalid MCP App resource URI');
      meta[key] = value[key];
    }
  }
  if (value['openai/widgetAccessible'] !== undefined) {
    if (typeof value['openai/widgetAccessible'] !== 'boolean') throw new Error('Invalid widget accessibility');
    meta['openai/widgetAccessible'] = value['openai/widgetAccessible'];
  }
  return Object.keys(meta).length ? meta : undefined;
}

export function appResource(def: McpToolDef): { uri: string; compatibility: boolean } | null {
  const standard = def._meta?.ui?.resourceUri ?? def._meta?.['ui/resourceUri'];
  if (standard) return { uri: standard, compatibility: false };
  const legacy = def._meta?.['openai/outputTemplate'];
  return legacy ? { uri: legacy, compatibility: true } : null;
}
export function appToolVisible(def: McpToolDef, audience: 'model' | 'app', compatibility = false): boolean {
  return (def._meta?.ui?.visibility ?? ['model', 'app']).includes(audience) &&
    (!compatibility || audience !== 'app' || def._meta?.['openai/widgetAccessible'] === true);
}

export function appInstanceId(output: unknown): string | null {
  return record(output) && typeof output._mcpApp === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(output._mcpApp) ? output._mcpApp : null;
}

/** Also used when replay has no corresponding tool definition. Never serialize component fields to a model. */
export function withoutAppReference(output: unknown): unknown {
  if (!record(output) || !('_mcpApp' in output)) return output;
  const { content, structuredContent, isError } = output;
  return { ...(Array.isArray(content) ? { content } : {}), ...(structuredContent !== undefined ? { structuredContent } : {}),
    ...(typeof isError === 'boolean' ? { isError } : {}) };
}

export type AppView = {
  html: string; resourceHash: string; input: Record<string, unknown>;
  result: { content: { type: string; [key: string]: unknown }[]; structuredContent?: unknown; _meta?: Record<string, unknown>; isError?: boolean };
  compatibility: boolean; sandboxUrl: string; title: string;
};
export type AppActionReply = { id: string; status: 'pending' | 'running' | 'done' | 'denied' | 'error'; tool: string; input: unknown; result?: AppView['result'] };
