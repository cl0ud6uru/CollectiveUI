import { requirePrincipal } from '@/lib/session';
import { assertAuthOrigin } from '@/lib/auth/origin';
import { HttpError } from '@/lib/authz';
import { readCandidateJson } from '@/lib/hermes-team/native-request';
import { teamPublicationResponse, teamPublicationFailure } from '@/lib/hermes-team/publication-http';
import { readTeamMemberMcpConnection, saveTeamMemberMcpConnection, revokeTeamMemberMcpConnection } from '@/lib/mcp/member-connections';

type Context = RouteContext<'/api/bots/[id]/team/connections/[capabilityId]'>;
export async function GET(request: Request, context: Context) {
  try {
    if (new URL(request.url).search) throw new HttpError(400, 'Unexpected connection parameters.');
    const principal = await requirePrincipal(), { id, capabilityId } = await context.params;
    return teamPublicationResponse(await readTeamMemberMcpConnection(principal, id, capabilityId));
  } catch (error) { return teamPublicationFailure(error); }
}
export async function PUT(request: Request, context: Context) {
  try {
    assertAuthOrigin(request.headers);
    const principal = await requirePrincipal(), { id, capabilityId } = await context.params;
    return teamPublicationResponse(await saveTeamMemberMcpConnection(principal, id, capabilityId, await readCandidateJson(request)));
  } catch (error) { return teamPublicationFailure(error); }
}
export async function DELETE(request: Request, context: Context) {
  try {
    assertAuthOrigin(request.headers);
    const principal = await requirePrincipal(), { id, capabilityId } = await context.params;
    return teamPublicationResponse(await revokeTeamMemberMcpConnection(principal, id, capabilityId, await readCandidateJson(request)));
  } catch (error) { return teamPublicationFailure(error); }
}
