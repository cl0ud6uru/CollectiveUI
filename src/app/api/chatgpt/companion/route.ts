import { z } from 'zod';
import { HttpError } from '@/lib/authz';
import { redeemCompanion, challengeCompanion, receiveCompanion, recoverCompanion, companionNativeStatus, cancelNativeCompanion } from '@/lib/llm/chatgpt/companion';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const reply = (value: unknown, status = 200) => Response.json(value, { status, headers });
const action = z.discriminatedUnion('action', [
  z.object({ action: z.literal('redeem'), attemptId: z.string().uuid(), launchToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    sourceHostId: z.string().min(1).max(256), sourceSigningPublicKey: z.string().min(1).max(8000), signature: z.string().max(256) }).strict(),
  z.object({ action: z.enum(['challenge', 'receive', 'recover']), attemptId: z.string().uuid(), input: z.unknown() }).strict(),
  z.object({ action: z.literal('status'), attemptId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('cancel'), attemptId: z.string().uuid() }).strict(),
]);
/** Native client transport, never an OpenAI HTTPS callback or a browser credential-upload route. */
export async function POST(request: Request) {
  try {
    if (request.headers.has('origin') || request.headers.has('cookie') || request.headers.has('sec-fetch-site')) throw new HttpError(403, 'Use the installed local sign-in app.');
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'JSON required.');
    const reader = request.body?.getReader(); if (!reader) throw new HttpError(400, 'JSON required.');
    const chunks: Uint8Array[] = []; let total = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.length; if (total > 128000) { await reader.cancel(); throw new HttpError(413, 'Request too large.'); } chunks.push(value); } }
    finally { reader.releaseLock(); }
    const body = action.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
    if (body.action === 'redeem') return reply(await redeemCompanion(body));
    const authorization = request.headers.get('authorization');
    if (body.action === 'status') return reply(await companionNativeStatus(body.attemptId, authorization));
    if (body.action === 'cancel') return reply(await cancelNativeCompanion(body.attemptId, authorization));
    if (body.action === 'challenge') return reply(await challengeCompanion(body.attemptId, authorization, body.input));
    if (body.action === 'receive') return reply(await receiveCompanion(body.attemptId, authorization, body.input));
    return reply(await recoverCompanion(body.attemptId, authorization, body.input));
  } catch (error) {
    return reply({ error: error instanceof HttpError ? error.message : 'The local sign-in request was not confirmed. Check account status before retrying.' },
      error instanceof HttpError ? error.status : 400);
  }
}
