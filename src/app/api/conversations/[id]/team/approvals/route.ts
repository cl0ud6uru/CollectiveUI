import { errorResponse, requirePrincipal } from '@/lib/session';
import { listCandidateApprovals } from '@/lib/hermes-team/candidate-tools';
export async function GET(_request:Request,ctx:RouteContext<'/api/conversations/[id]/team/approvals'>){
  try{return Response.json({approvals:await listCandidateApprovals(await requirePrincipal(),(await ctx.params).id)},{headers:{'Cache-Control':'private, no-store'}});}
  catch(error){return errorResponse(error);}
}
