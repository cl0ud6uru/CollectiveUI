import { candidateMcpHttp } from '@/lib/hermes-team/candidate-http';
/** Every MCP method authenticates its native run grant and the current member's scope. */
export async function POST(request:Request,ctx:RouteContext<'/api/hermes-team/native/[contextId]/mcp'>){return candidateMcpHttp(request,(await ctx.params).contextId);}
