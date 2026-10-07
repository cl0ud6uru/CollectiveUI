import { z } from 'zod';
import { assertAuthOrigin } from '@/lib/auth/origin';
import { errorResponse,requirePrincipal } from '@/lib/session';
import { readTeamRequest } from '@/lib/hermes-team/request';
import { answerCandidateApproval } from '@/lib/hermes-team/candidate-tools';
export async function PUT(request:Request,ctx:RouteContext<'/api/hermes-team/approvals/[id]'>){
  try{assertAuthOrigin(request.headers);const p=await requirePrincipal();const body=z.object({decision:z.enum(['approved','rejected'])}).strict().parse(await readTeamRequest(request));
    return Response.json(await answerCandidateApproval(p,(await ctx.params).id,body.decision),{headers:{'Cache-Control':'private, no-store'}});
  }catch(error){return errorResponse(error);}
}
