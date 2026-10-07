import { requirePrincipal } from '@/lib/session';
import { HttpError } from '@/lib/authz';
import { listTeamMemberMcpConnections } from '@/lib/mcp/member-connections';
import { teamPublicationResponse, teamPublicationFailure } from '@/lib/hermes-team/publication-http';
export async function GET(request: Request, context: RouteContext<'/api/bots/[id]/team/connections'>) {
  try {
    if (new URL(request.url).search) throw new HttpError(400, 'Unexpected connection parameters.');
    return teamPublicationResponse(await listTeamMemberMcpConnections(await requirePrincipal(), (await context.params).id));
  } catch (error) { return teamPublicationFailure(error); }
}
