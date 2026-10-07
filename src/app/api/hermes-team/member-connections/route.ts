import { requirePrincipal } from '@/lib/session';
import { HttpError } from '@/lib/authz';
import { listOwnedMemberMcpConnections } from '@/lib/mcp/member-connections';
import { teamPublicationResponse, teamPublicationFailure } from '@/lib/hermes-team/publication-http';

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => key !== 'cursor') || params.getAll('cursor').length > 1)
      throw new HttpError(400, 'Unexpected account parameters.');
    return teamPublicationResponse(await listOwnedMemberMcpConnections(await requirePrincipal(), params.get('cursor') ?? undefined));
  } catch (error) { return teamPublicationFailure(error); }
}
