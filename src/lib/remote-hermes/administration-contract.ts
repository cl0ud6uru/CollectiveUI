import { z } from 'zod';
import type { RpcRecord } from './socket';
const record = (value: unknown): RpcRecord => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RpcRecord : {};
const providerPoolId = z.string().regex(/^(?:custom:)?[a-z0-9][a-z0-9._-]{0,79}$/);
const providerPoolLabel = z.string().trim().min(1).max(80).refine(value => !/[\u0000-\u001f\u007f]/.test(value));

const customServerName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const customServerUrl = z.string().min(1).max(2048).url().refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}, 'Use an HTTPS endpoint without embedded credentials or query parameters.');

export const administrationInput = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('inspect') }).strict(),
  z.object({ operation: z.literal('setting'), requestId: z.string().uuid(), key: z.enum(['reasoning', 'fast']), value: z.string(), scope: z.enum(['session', 'profile']) }).strict(),
  z.object({ operation: z.literal('test'), name: z.string().min(1).max(200) }).strict(),
  z.object({ operation: z.literal('install'), requestId: z.string().uuid(), preset: z.string().min(1).max(200) }).strict(),
  z.object({ operation: z.literal('customServer'), requestId: z.string().uuid(), name: customServerName, url: customServerUrl, bearerToken: z.string().min(1).max(16000).optional(), confirmed: z.literal(true) }).strict(),
  z.object({ operation: z.literal('credential'), requestId: z.string().uuid(), name: z.string().min(1).max(200), envVar: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/), value: z.string().min(1).max(16000) }).strict(),
  z.object({ operation: z.literal('providerKey'), requestId: z.string().uuid(), provider: providerPoolId, label: providerPoolLabel, apiKey: z.string().trim().min(1).max(16000), confirmed: z.literal(true) }).strict(),
  z.object({ operation: z.literal('remove'), requestId: z.string().uuid(), name: z.string().min(1).max(200), confirmed: z.literal(true) }).strict(),
  z.object({ operation: z.literal('enabled'), requestId: z.string().uuid(), name: z.string().min(1).max(200), enabled: z.boolean(), confirmed: z.literal(true) }).strict(),
  z.object({ operation: z.literal('reload'), requestId: z.string().uuid(), confirmed: z.literal(true) }).strict(),
]);
export type AdministrationInput = z.infer<typeof administrationInput>;
export const settingValues = { reasoning: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'], fast: ['normal', 'fast', 'auto', 'cold', 'ultrafast'] } as const;
const str = (value: unknown, max = 200) => typeof value === 'string' ? value.slice(0, max) : '';
const rows = (value: unknown) => Array.isArray(value) ? value.slice(0, 100).map(record) : [];
const envKey = (value: unknown) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(value);
/** Mirrors pinned Hermes `_env_key_for_server` for ASCII names. Fail closed on
 * non-ASCII legacy names because its Unicode uppercasing cannot be matched safely.
 */
export function nativeMcpBearerEnvSlot(name: string): string | null {
  if (!name || !/^[\x00-\x7f]+$/.test(name)) return null;
  const suffix = name.toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  return suffix ? `MCP_${suffix}_API_KEY` : null;
}
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
        auth: ['header', 'oauth'].includes(str(s.auth)) ? str(s.auth) : null,
        source: s.source === 'plugin' ? 'plugin' : s.source === 'config' ? 'config' : 'unknown', status: ['connected', 'disabled', 'connecting', 'failed', 'lazy', 'configured'].includes(str(state.status)) ? str(state.status) : 'unknown',
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
