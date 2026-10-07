import { z } from 'zod';
import { assertAuthOrigin } from '@/lib/auth/origin';
import { errorResponse,requirePrincipal } from '@/lib/session';
import { readTeamRequest } from '@/lib/hermes-team/request';
import { prepareTeamCandidateRun } from '@/lib/hermes-team/candidate-startup';
export async function POST(request:Request,ctx:RouteContext<'/api/bots/[id]/team/runtime-candidate'>){
  try{assertAuthOrigin(request.headers);const p=await requirePrincipal();const input=z.object({runId:z.string().min(1).max(100),choice:z.enum(['default','personal']).default('default')}).strict().parse(await readTeamRequest(request));
    return Response.json(await prepareTeamCandidateRun(p,(await ctx.params).id,input.runId,input.choice),{headers:{'Cache-Control':'private, no-store'}});
  }catch(error){return errorResponse(error);}
}
