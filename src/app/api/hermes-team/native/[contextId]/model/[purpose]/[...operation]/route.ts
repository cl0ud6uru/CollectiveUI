import { candidateModelHttp } from '@/lib/hermes-team/candidate-http';
/** Authentication is an opaque, purpose-bound native run grant, followed by fresh server authorization. */
export async function POST(request:Request,ctx:RouteContext<'/api/hermes-team/native/[contextId]/model/[purpose]/[...operation]'>){
  return candidateModelHttp(request,await ctx.params);
}
