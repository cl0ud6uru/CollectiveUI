import { z } from 'zod';
import { requirePrincipal } from '@/lib/session';
import { HttpError } from '@/lib/authz';
import { changeConnection, connectionView } from '@/personal-codex/accounts';
import { connectionAction } from '@/personal-codex/contracts';
import { prepareDeviceAccountRuntime } from '@/lib/llm/chatgpt/onboarding';

const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const failed = (e: unknown) => reply({ error: e instanceof HttpError ? e.message : 'Personal Codex connection is unavailable. Reload before retrying.' }, e instanceof HttpError ? e.status : 503);
export async function GET() {
  try { return reply(await connectionView(await requirePrincipal())); } catch (e) { return failed(e); }
}
export async function POST(request: Request) {
  try {
    const p = await requirePrincipal();
    if (request.headers.get('origin') !== new URL(process.env.AUTH_URL || request.url).origin) throw new HttpError(403, 'Invalid request origin.');
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw new HttpError(415, 'JSON required.');
    const reader = request.body?.getReader();
    if (!reader) throw new HttpError(400, 'JSON required.');
    let bytes = 0; const chunks: Uint8Array[] = [];
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 1024) { await reader.cancel(); throw new HttpError(413, 'Request too large.'); } chunks.push(value); } }
    finally { reader.releaseLock(); }
    let input: z.infer<typeof connectionAction>;
    try { input = connectionAction.parse(JSON.parse(Buffer.concat(chunks).toString())); } catch { throw new HttpError(400, 'Invalid connection action.'); }
    if (input.action === 'connect') {
      await prepareDeviceAccountRuntime(p, { accepted: input.accepted, consentVersion: input.consentVersion });
      return reply(await changeConnection(p, 'connect'));
    }
    if (input.action === 'confirm') return reply(await changeConnection(p, 'confirm', input.expected));
    return reply(await changeConnection(p, input.action));
  } catch (e) { return failed(e); }
}
