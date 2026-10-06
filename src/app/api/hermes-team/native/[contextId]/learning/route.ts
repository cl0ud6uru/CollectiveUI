import { nativeLearningHandoffHttp } from '@/lib/hermes-team/candidate-learning';
/** Separate native one-use snapshot grant; never accepts a model token or browser-selected profile. */
export async function POST(request:Request,ctx:RouteContext<'/api/hermes-team/native/[contextId]/learning'>){return nativeLearningHandoffHttp(request,(await ctx.params).contextId);}
