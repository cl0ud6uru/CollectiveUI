import { z } from 'zod';
import { HttpError } from '@/lib/authz';
import { TeamModelPolicyError, TEAM_MODEL_PURPOSES, type TeamModelPurpose, type VerifiedTeamModelRoute } from './model-policy';
import { TeamToolPolicyError, type VerifiedTeamToolAdapter } from './tool-policy';
import { executeCandidateModel } from './candidate-model';
import { executeCandidateTool, listCandidateTools } from './candidate-tools';
import { readCandidateJson } from './native-request';

const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
function failure(error:unknown){
  const status=error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : error instanceof TeamModelPolicyError || error instanceof TeamToolPolicyError ? 403 : 503;
  // No upstream messages, request payloads, bearer grants or credentials in error responses.
  return Response.json({error:status===503?'The native Team adapter is unavailable.':'The native Team request is not currently authorized.'},{status,headers});
}
export async function candidateModelHttp(request:Request,params:{contextId:string;purpose:string;operation:string[]},dependencies:{routes?:readonly VerifiedTeamModelRoute[];fetch?:typeof fetch}={}){
  try{
    if(!TEAM_MODEL_PURPOSES.includes(params.purpose as TeamModelPurpose))throw new HttpError(404,'Unknown purpose.');
    const operation=params.operation.join('/');
    if(!['responses','chat/completions'].includes(operation))throw new HttpError(404,'Unknown native operation.');
    const result=await executeCandidateModel(request,params.contextId,params.purpose as TeamModelPurpose,operation==='responses'?'responses':'chat_completions',await readCandidateJson(request),dependencies);
    return new Response(result.body,{status:result.status,headers:{...headers,'Content-Type':result.contentType}});
  }catch(error){return failure(error);}
}
const rpc=z.object({jsonrpc:z.literal('2.0'),id:z.union([z.string().max(200),z.number().finite()]).optional(),method:z.string().max(100),params:z.record(z.string(),z.unknown()).optional()}).strict();
export async function candidateMcpHttp(request:Request,contextId:string,dependencies:{routes?:readonly VerifiedTeamModelRoute[];adapters?:readonly VerifiedTeamToolAdapter[];connect?:typeof import('@/lib/mcp/client').connectMcp}={}){
  try{
    const message=rpc.parse(await readCandidateJson(request));
    // Even initialize/notifications must check an opaque grant, current audience and current model route.
    const {loadCandidateContext}=await import('./candidate-context');
    await loadCandidateContext(contextId,request.headers.get('authorization'),'tool',dependencies.routes);
    if(message.method==='notifications/initialized' && message.id===undefined)return new Response(null,{status:202,headers});
    if(message.id===undefined)throw new HttpError(400,'Unsupported native notification.');
    let result:unknown;
    if(message.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{listChanged:false}},serverInfo:{name:'collective-team-candidate',version:'1'}};
    else if(message.method==='ping')result={};
    else if(message.method==='tools/list')result={tools:await listCandidateTools(contextId,request.headers.get('authorization'),dependencies)};
    else if(message.method==='tools/call'){
      const params=z.object({name:z.string().min(1).max(100),arguments:z.record(z.string(),z.unknown()).default({}),_meta:z.record(z.string(),z.unknown()).optional()}).strict().parse(message.params);
      const response=await executeCandidateTool(request,contextId,params.name,params.arguments,request.headers.get('x-collective-approval-id')??undefined,dependencies);
      result=JSON.parse(response.body);
    }else return Response.json({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'This native MCP method is unsupported.'}},{headers});
    return Response.json({jsonrpc:'2.0',id:message.id,result},{headers});
  }catch(error){return failure(error);}
}
