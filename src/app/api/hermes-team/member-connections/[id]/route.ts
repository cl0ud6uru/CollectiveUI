import { requirePrincipal } from '@/lib/session';
import { assertAuthOrigin } from '@/lib/auth/origin';
import { readCandidateJson } from '@/lib/hermes-team/native-request';
import { revokeOwnedMemberMcpConnection } from '@/lib/mcp/member-connections';
import { teamPublicationResponse, teamPublicationFailure } from '@/lib/hermes-team/publication-http';
export async function DELETE(request: Request, context: RouteContext<'/api/hermes-team/member-connections/[id]'>) {
  try {
    assertAuthOrigin(request.headers);
    return teamPublicationResponse(await revokeOwnedMemberMcpConnection(await requirePrincipal(), (await context.params).id, await readCandidateJson(request)));
  } catch (error) { return teamPublicationFailure(error); }
}
