import { z } from 'zod';
import { requirePrincipal, errorResponse } from '@/lib/session';
import { inspectNative } from '@/lib/remote-hermes/operations';

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
