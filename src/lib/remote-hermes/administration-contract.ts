import { z } from 'zod';
import type { RpcRecord } from './socket';
const record = (value: unknown): RpcRecord => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RpcRecord : {};

export const administrationInput = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('inspect') }).strict(),
  z.object({ operation: z.literal('setting'), requestId: z.string().uuid(), key: z.enum(['reasoning', 'fast']), value: z.string(), scope: z.enum(['session', 'profile']) }).strict(),
  z.object({ operation: z.literal('test'), name: z.string().min(1).max(200) }).strict(),
  z.object({ operation: z.literal('install'), requestId: z.string().uuid(), preset: z.string().min(1).max(200) }).strict(),
  z.object({ operation: z.literal('credential'), requestId: z.string().uuid(), name: z.string().min(1).max(200), envVar: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/), value: z.string().min(1).max(16000) }).strict(),
]);
export type AdministrationInput = z.infer<typeof administrationInput>;
export const settingValues = { reasoning: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'], fast: ['normal', 'fast', 'auto', 'cold', 'ultrafast'] } as const;
const str = (value: unknown, max = 200) => typeof value === 'string' ? value.slice(0, max) : '';
const rows = (value: unknown) => Array.isArray(value) ? value.slice(0, 100).map(record) : [];
const envKey = (value: unknown) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(value);
export function settingValue(key: keyof typeof settingValues, result: RpcRecord) {
  const value = str(result.value);
  return (settingValues[key] as readonly string[]).includes(value) ? value : '';
}
/** Do not forward native config, URLs, command arguments, headers, env values, or error text. */
export function mcpInventory(list: RpcRecord, status: RpcRecord, catalog: RpcRecord) {
  const states = new Map(rows(status.servers).map(s => [str(s.name), s]));
  return {
    servers: rows(list.servers).map(s => {
      const state = states.get(str(s.name)) ?? {};
      return { name: str(s.name), transport: ['stdio', 'http', 'sse', 'streamable-http'].includes(str(s.transport)) ? str(s.transport) : 'unknown', enabled: s.enabled === true,
        source: s.source === 'plugin' ? 'plugin' : 'config', status: ['connected', 'disabled', 'connecting', 'failed', 'lazy', 'configured'].includes(str(state.status)) ? str(state.status) : 'unknown',
        tools: Number.isSafeInteger(state.tools) && Number(state.tools) >= 0 ? Number(state.tools) : null,
        envKeys: Array.isArray(s.env) ? s.env.filter(envKey).slice(0, 30) as string[] : [], hasOAuth: s.oauth_tokens_present === true };
    }),
    catalog: rows(catalog.servers).map(s => ({ name: str(s.name), transport: str(s.transport), installed: s.installed === true, requires: Array.isArray(s.requires) ? s.requires.filter(envKey).slice(0, 30) as string[] : [] })),
  };
}
export function probeSummary(result: RpcRecord) {
  return { ok: result.ok === true, oauthNeeded: result.oauth_needed === true,
    oauthTokensPresent: typeof result.oauth_tokens_present === 'boolean' ? result.oauth_tokens_present : null,
    tools: rows(result.tools).map(t => str(t.name)), prompts: Number.isSafeInteger(result.prompts) ? Number(result.prompts) : 0, resources: Number.isSafeInteger(result.resources) ? Number(result.resources) : 0 };
}
