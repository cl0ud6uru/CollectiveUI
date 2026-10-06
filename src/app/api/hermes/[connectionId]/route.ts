import { z } from 'zod';
import { errorResponse, requirePrincipal } from '@/lib/session';
import { assertAuthOrigin } from '@/lib/auth/origin';
import { getSetting } from '@/lib/settings';
import { HttpError } from '@/lib/authz';
import { browseNativeSessions, nativeHistory, nativeControl, nativeSnapshot, openNativeSession, profileName, submitNativePrompt, type NativeUpload } from '@/lib/remote-hermes/sessions';

const id = z.string().min(1).max(200);
const query = z.object({ operation: z.enum(['browse', 'snapshot', 'history', 'catalog', 'context']), profile: profileName.optional(), sessionId: id.optional(), offset: z.coerce.number().int().min(0).max(100000).default(0) });
const command = z.object({ operation: z.enum(['open', 'submit', 'stop', 'steer', 'answer', 'command', 'queue']), profile: profileName.optional(), storedId: id.optional(), offset: z.number().int().min(0).max(100000).optional(), sessionId: id.optional(), requestId: z.string().max(200).optional(), text: z.string().max(64000).optional(), answer: z.unknown().optional() }).strict();
const fail = (e: unknown) => e instanceof z.ZodError ? Response.json({ error: 'Invalid Hermes request.' }, { status: 400 }) : errorResponse(e);
const headers = { 'Cache-Control': 'private, no-store' };
async function boundedBytes(req: Request, max: number) {
  const reader = req.body?.getReader();
  if (!reader) throw new HttpError(400, 'Missing request body.');
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > max) throw new HttpError(413, 'This Hermes upload is too large.'); chunks.push(value); }
    return new Uint8Array(Buffer.concat(chunks)).buffer;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function GET(req: Request, ctx: RouteContext<'/api/hermes/[connectionId]'>) {
  try {
    const p = await requirePrincipal();
    const { connectionId } = await ctx.params;
    const input = query.parse(Object.fromEntries(new URL(req.url).searchParams));
    if (input.operation === 'browse') return Response.json(await browseNativeSessions(p.user.id, connectionId, profileName.parse(input.profile), input.offset), { headers });
    const sessionId = id.parse(input.sessionId);
    if (input.operation === 'history') return Response.json(await nativeHistory(p.user.id, connectionId, sessionId, input.offset), { headers });
    const result = input.operation === 'snapshot' ? await nativeSnapshot(p.user.id, connectionId, sessionId)
      : await nativeControl(p.user.id, connectionId, sessionId, input.operation);
    return Response.json(result, { headers });
  } catch (e) { return fail(e); }
}
export async function POST(req: Request, ctx: RouteContext<'/api/hermes/[connectionId]'>) {
  try {
    const p = await requirePrincipal(); assertAuthOrigin(req.headers);
    const { connectionId } = await ctx.params;
    let raw: unknown; const uploads: NativeUpload[] = [];
    const contentType = req.headers.get('content-type') ?? '';
    if (contentType.startsWith('multipart/form-data')) {
      const data = await new Response(await boundedBytes(req, 25 * 1024 * 1024), { headers: { 'Content-Type': contentType } }).formData();
      try { raw = JSON.parse(String(data.get('request'))); }
      catch { throw new HttpError(400, 'Invalid request JSON.'); }
      const limits = await getSetting('limits');
      const files = data.getAll('files');
      if (files.length > limits.maxAttachmentsPerMessage) throw new HttpError(400, 'Too many attachments.');
      for (const file of files) {
        if (!(file instanceof File) || file.size > Math.min(20, limits.uploadMaxMb) * 1024 * 1024) throw new HttpError(413, 'A Hermes attachment exceeds the allowed size.');
        const name = file.name.split(/[\\/]/).at(-1)!.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
        if (!name || name === '.' || name === '..') throw new HttpError(400, 'Invalid attachment filename.');
        uploads.push({ name, type: file.type.replace(/[^a-zA-Z0-9.+/-]/g, '').slice(0, 100), bytes: Buffer.from(await file.arrayBuffer()) });
      }
    } else {
      try { raw = JSON.parse(Buffer.from(await boundedBytes(req, 256 * 1024)).toString('utf8')); }
      catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'Invalid request JSON.'); }
    }
    const input = command.parse(raw);
    if (uploads.length && input.operation !== 'submit') throw new HttpError(400, 'Attach files to a message.');
    if (input.operation === 'open') return Response.json(await openNativeSession(p.user.id, connectionId, profileName.parse(input.profile), input.storedId, input.offset), { headers });
    const sessionId = id.parse(input.sessionId);
    const result = input.operation === 'submit'
      ? await submitNativePrompt(p.user.id, connectionId, sessionId, z.string().uuid().parse(input.requestId), input.text ?? '', uploads)
      : await nativeControl(p.user.id, connectionId, sessionId, input.operation, input);
    return Response.json(result, { headers });
  } catch (e) { return fail(e); }
}
