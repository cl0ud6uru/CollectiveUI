import { z } from 'zod';
import { errorResponse, requirePrincipal } from '@/lib/session';
import { assertAuthOrigin } from '@/lib/auth/origin';
import { HttpError } from '@/lib/authz';
import { readTeamRequest } from '@/lib/hermes-team/request';
import { setTeamConversationModelChoice, teamConversationModelView } from '@/lib/hermes-team/candidate-availability';

const inputSchema = z.object({
  modelChoice: z.enum(['default', 'personal']),
  expectedChoice: z.enum(['default', 'personal']),
  expectedDefinitionVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict();
function checkParameters(request: Request) {
  if (new URL(request.url).searchParams.size) throw new HttpError(400, 'Unexpected model settings parameters.');
}
const noStore = { 'Cache-Control': 'private, no-store' };
function failure(error: unknown) {
  const response = errorResponse(error);
  response.headers.set('Cache-Control', noStore['Cache-Control']);
  return response;
}

export async function GET(request: Request, ctx: RouteContext<'/api/conversations/[id]/team/model'>) {
  try {
    const p = await requirePrincipal(); checkParameters(request);
    return Response.json(await teamConversationModelView(p, (await ctx.params).id), { headers: noStore });
  } catch (error) { return failure(error); }
}
export async function PUT(request: Request, ctx: RouteContext<'/api/conversations/[id]/team/model'>) {
  try {
    assertAuthOrigin(request.headers);
    const p = await requirePrincipal(); checkParameters(request);
    const input = inputSchema.parse(await readTeamRequest(request));
    return Response.json(await setTeamConversationModelChoice(p, (await ctx.params).id, input.modelChoice,
      { expectedChoice: input.expectedChoice, expectedDefinitionVersion: input.expectedDefinitionVersion }), { headers: noStore });
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: 'Invalid model choice.' }, { status: 400, headers: noStore });
    return failure(error);
  }
}
