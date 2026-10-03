import { requirePrincipal, errorResponse } from '@/lib/session';
import { nativeResources } from '@/lib/docker-hermes/store';
export async function GET(_request: Request, ctx: RouteContext<'/api/bots/[id]/native'>) {
  try { return Response.json(await nativeResources(await requirePrincipal(), (await ctx.params).id), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (e) { return errorResponse(e); }
}
