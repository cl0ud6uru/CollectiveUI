import { requirePrincipal } from '@/lib/session';
import { teamRevisionHistory } from '@/lib/hermes-team/rollback';
import { teamPublicationFailure, teamPublicationResponse } from '@/lib/hermes-team/publication-http';
export async function GET(_request: Request, ctx: RouteContext<'/api/bots/[id]/team/revisions'>) {
  try { return teamPublicationResponse(await teamRevisionHistory(await requirePrincipal(), (await ctx.params).id)); }
  catch (e) { return teamPublicationFailure(e); }
}
