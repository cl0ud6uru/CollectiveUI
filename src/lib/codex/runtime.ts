import { HttpError } from '@/lib/authz';
import 'server-only';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
export { runtimeBinding } from './binding';
import { z } from 'zod';
import type { CodexPolicy } from './config';

const text = z.string().min(1).max(256);
const RuntimeSchema = z.object({
  id: text, ownerId: text, funding: z.enum(['api', 'chatgpt_subscription']),
  endpoint: z.string().max(2048).url().refine(value => {
    const u = new URL(value);
    return !u.username && !u.password && !u.search && !u.hash &&
      (u.protocol === 'wss:' || (u.protocol === 'ws:' && ['127.0.0.1', '[::1]'].includes(u.hostname)));
  }),
  tokenFile: z.string().refine(isAbsolute),
  // Provisioning must isolate the OS, home, workspace and native tool credentials per caller.
  isolationId: text, credentialBinding: text, cwd: z.string().refine(isAbsolute),
  isolated: z.literal(true), nativeMcpDisabled: z.literal(true),
  expectedEmail: z.string().email().optional(),
  expectedWorkspaceId: text.optional(),
  // Explicit deployment admission, not a claim that account/read verifies subscription entitlement.
  subscriptionAuthorization: z.object({ reference: text, expiresAt: z.number().int().positive() }).strict().optional(),
}).strict().superRefine((r, ctx) => {
  if (r.funding === 'chatgpt_subscription' && (!r.expectedEmail || !r.expectedWorkspaceId || !r.subscriptionAuthorization))
    ctx.addIssue({ code: 'custom', message: 'Subscription ownership and authorization are required' });
  if (r.funding === 'api' && (r.expectedEmail || r.expectedWorkspaceId || r.subscriptionAuthorization))
    ctx.addIssue({ code: 'custom', message: 'API and subscription bindings must be separate' });
});
export const RuntimeManifestSchema = z.object({ version: z.literal(1), runtimes: z.array(RuntimeSchema).max(10000) }).strict()
  .superRefine(({ runtimes }, ctx) => {
    for (const key of ['id', 'endpoint', 'isolationId', 'credentialBinding'] as const)
      if (new Set(runtimes.map(r => r[key])).size !== runtimes.length)
        ctx.addIssue({ code: 'custom', message: `Duplicate runtime ${key}` });
    if (new Set(runtimes.map(r => `${r.ownerId}:${r.funding}`)).size !== runtimes.length)
      ctx.addIssue({ code: 'custom', message: 'Ambiguous caller runtime' });
    const accounts = runtimes.filter(r => r.funding === 'chatgpt_subscription' && r.expectedEmail).map(r => r.expectedEmail!.toLowerCase());
    if (new Set(accounts).size !== accounts.length) ctx.addIssue({ code: 'custom', message: 'A subscription account cannot be assigned to multiple callers' });
  });
export type CodexRuntime = z.infer<typeof RuntimeSchema>;
const unavailable = () => new HttpError(409, 'Your Codex runtime is unavailable or needs administrator verification. No other account was selected.');

export function assertRuntimeOwner(runtime: CodexRuntime, user: { id: string; upn: string; email: string | null }) {
  if (runtime.ownerId !== user.id || (runtime.funding === 'chatgpt_subscription' &&
    ![user.upn, user.email].some(email => email?.toLowerCase() === runtime.expectedEmail?.toLowerCase())))
    throw new HttpError(403, 'The assigned Codex account does not match your signed-in identity. A different person’s account cannot be used.');
}

/** Server-installed manifest only. Never accept an endpoint, token or account from a browser or bot author. */
export async function callerRuntime(ownerId: string, funding: CodexPolicy['funding']): Promise<CodexRuntime> {
  try {
    const path = process.env.CODEX_RUNTIME_MANIFEST;
    if (!path || !isAbsolute(path)) throw unavailable();
    const raw = await readFile(path, 'utf8');
    if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw unavailable();
    const manifest = RuntimeManifestSchema.parse(JSON.parse(raw));
    const runtime = manifest.runtimes.find(r => r.ownerId === ownerId && r.funding === funding);
    if (!runtime || (runtime.subscriptionAuthorization && runtime.subscriptionAuthorization.expiresAt <= Date.now())) throw unavailable();
    return runtime;
  } catch { throw unavailable(); }
}
export async function runtimeToken(runtime: CodexRuntime) {
  try {
    const token = (await readFile(runtime.tokenFile, 'utf8')).trim();
    if (token.length < 32 || token.length > 8192 || /\s/.test(token)) throw unavailable();
    return token;
  } catch { throw unavailable(); }
}
