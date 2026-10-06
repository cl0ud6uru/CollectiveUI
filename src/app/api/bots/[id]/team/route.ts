import { z } from 'zod';
import { errorResponse, requirePrincipal } from '@/lib/session';
import { assertAuthOrigin } from '@/lib/auth/origin';
import { configureTeam } from '@/lib/hermes-team/store';
import { teamChatStatus } from '@/lib/hermes-team/conversations';
import { readTeamRequest } from '@/lib/hermes-team/request';
export async function GET(request: Request, ctx: RouteContext<'/api/bots/[id]/team'>) {
  try {
    const conversationId = new URL(request.url).searchParams.get('conversationId') ?? undefined;
    return Response.json(await teamChatStatus(await requirePrincipal(), (await ctx.params).id, conversationId), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return errorResponse(e); }
}
export async function PUT(request: Request, ctx: RouteContext<'/api/bots/[id]/team'>) {
  try {
    assertAuthOrigin(request.headers);
    const p = await requirePrincipal();
    return Response.json(await configureTeam(p, (await ctx.params).id, await readTeamRequest(request)), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e) { if (e instanceof z.ZodError) return Response.json({ error: 'Invalid Team Bot settings.' }, { status: 400 }); return errorResponse(e); }
}
