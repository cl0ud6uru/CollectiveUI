import { z } from 'zod';
import { errorResponse, requirePrincipal } from '@/lib/session';
import { assertAuthOrigin } from '@/lib/auth/origin';
import { openTeamConversation } from '@/lib/hermes-team/conversations';
import { teamMode } from '@/lib/hermes-team/types';
import { ensureTeamPrivateInstance } from '@/lib/hermes-team/provisioning';
import { readTeamRequest } from '@/lib/hermes-team/request';
const input = z.object({ mode: teamMode }).strict();
export async function POST(request: Request, ctx: RouteContext<'/api/bots/[id]/team/open'>) {
  try {
    assertAuthOrigin(request.headers);
    const p = await requirePrincipal(), botId = (await ctx.params).id;
    const { mode } = input.parse(await readTeamRequest(request));
    const opened = await openTeamConversation(p, botId, mode);
    const profile = await ensureTeamPrivateInstance(p, botId, mode);
    return Response.json({ ...opened, state: profile.state }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { if (e instanceof z.ZodError) return Response.json({ error: 'Choose member or Admin mode.' }, { status: 400 }); return errorResponse(e); }
}
