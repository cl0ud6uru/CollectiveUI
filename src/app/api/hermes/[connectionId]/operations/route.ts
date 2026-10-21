import { z } from 'zod';
import { requirePrincipal, errorResponse } from '@/lib/session';
import { assertAuthOrigin } from '@/lib/auth/origin';
import { HttpError } from '@/lib/authz';
import { inspectNative } from '@/lib/remote-hermes/operations';
import { nativeProjectOperation, projectOperationInput } from '@/lib/remote-hermes/projects';
import { nativeWorkspaceFileEdit, workspaceFileEditInput } from '@/lib/remote-hermes/workspace-edit';

const envelope = z.object({ sessionId: z.string().min(1).max(200), input: z.union([projectOperationInput, workspaceFileEditInput]) }).strict();
const headers = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request, context: { params: Promise<{ connectionId: string }> }) {
  try {
    const principal = await requirePrincipal();
    const { connectionId } = await context.params;
    return Response.json(await inspectNative(principal.user.id, connectionId, Object.fromEntries(new URL(request.url).searchParams)), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: 'Invalid Hermes panel request.' }, { status: 400 });
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ connectionId: string }> }) {
  try {
    const principal = await requirePrincipal(); assertAuthOrigin(request.headers);
    const reader = request.body?.getReader(); if (!reader) throw new HttpError(400, 'Missing Hermes operation request.');
    let size = 0; const chunks: Uint8Array[] = [];
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 1_100_000) throw new HttpError(413, 'Hermes operation request is too large.'); chunks.push(value); } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    let raw: unknown; try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid Hermes operation request.'); }
    const input = envelope.parse(raw);
    const { connectionId } = await context.params;
    const result = input.input.operation === 'confirm-file-edit' || input.input.operation === 'prepare' && 'action' in input.input && input.input.action === 'file-edit'
      ? await nativeWorkspaceFileEdit(principal.user.id, connectionId, input.sessionId, input.input)
      : await nativeProjectOperation(principal.user.id, connectionId, input.sessionId, input.input);
    return Response.json(result, { headers });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : 502;
    return Response.json({ error: error instanceof HttpError ? error.message : status === 400 ? 'Invalid Hermes operation request.' : 'Hermes could not confirm this operation. Refresh the panel and verify its outcome before continuing.' }, { status, headers });
  }
}
