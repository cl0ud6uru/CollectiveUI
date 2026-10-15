import { z } from 'zod';
import { requirePrincipal } from '@/lib/session';
import { HttpError } from '@/lib/authz';
import { changeUnifiedAccount, unifiedAccountView } from '@/lib/llm/chatgpt/account';
import { prepareAccountRuntime } from '@/lib/llm/chatgpt/onboarding';
import { beginCompanionSignIn, cancelCompanionSignIn } from '@/lib/llm/chatgpt/companion';

const action = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['start', 'disconnect', 'disconnect-native', 'sync-token']) }).strict(),
  z.object({ action: z.literal('prepare-runtime'), accepted: z.literal(true), consentVersion: z.literal(1) }).strict(),
  z.object({ action: z.literal('begin-sign-in'), accepted: z.literal(true), consentVersion: z.literal(1), enableCodex: z.boolean() }).strict(),
  z.object({ action: z.literal('cancel-sign-in') }).strict(),
]);
const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const failed = (error: unknown) => reply({ error: error instanceof HttpError ? error.message : 'The ChatGPT account service is unavailable. Retry to check the current state.' }, error instanceof HttpError ? error.status : 503);
export async function GET() { try { return reply(await unifiedAccountView(await requirePrincipal())); } catch (error) { return failed(error); } }
export async function POST(request: Request) {
  try {
    const p = await requirePrincipal();
    if (request.headers.get('origin') !== new URL(process.env.AUTH_URL || request.url).origin) throw new HttpError(403, 'Invalid request origin.');
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw new HttpError(415, 'JSON required.');
    const reader = request.body?.getReader();
    if (!reader) throw new HttpError(400, 'JSON required.');
    const chunks: Uint8Array[] = []; let bytes = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 1024) { await reader.cancel(); throw new HttpError(413, 'Request too large.'); } chunks.push(value); } }
    finally { reader.releaseLock(); }
    let raw: unknown;
    try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid ChatGPT account action.'); }
    const parsed = action.safeParse(raw);
    if (!parsed.success) throw new HttpError(400, 'Invalid ChatGPT account action.');
    if (parsed.data.action === 'begin-sign-in') return reply(await beginCompanionSignIn(p, { accepted: true, consentVersion: 1, enableCodex: parsed.data.enableCodex }));
    if (parsed.data.action === 'cancel-sign-in') return reply(await cancelCompanionSignIn(p));
    if (parsed.data.action === 'prepare-runtime') return reply(await prepareAccountRuntime(p, { accepted: parsed.data.accepted, consentVersion: parsed.data.consentVersion }));
    return reply(await changeUnifiedAccount(p, parsed.data.action));
  } catch (error) { return failed(error); }
}
