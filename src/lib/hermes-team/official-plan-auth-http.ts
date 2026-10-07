import { z } from 'zod';
import type { Principal } from '@/lib/auth/groups';
import { assertAuthOrigin } from '@/lib/auth/origin';
import { HttpError } from '@/lib/authz';
import { readCandidateJson } from './native-request';
import { officialAuthServices,officialPlanAuthStatus,operateOfficialPlanAuth,returnOfficialPlanAuth,startOfficialPlanAuth,cancelOfficialPlanAuth,OFFICIAL_AUTH_UNAVAILABLE,type OfficialAuthServices } from './official-plan-auth';
const headers={'Cache-Control':'private, no-store'};
const failure=(error:unknown)=>Response.json({error:error instanceof HttpError?error.message:'The official connection request is invalid.'},{status:error instanceof HttpError?error.status:400,headers});

/** Real route factory; its production services have no registered loopback transport. */
export function createOfficialPlanAuthHttp(getPrincipal:()=>Promise<Principal>,services:OfficialAuthServices=officialAuthServices()){
 return {
  async GET(){try{return Response.json(await officialPlanAuthStatus(await getPrincipal()),{headers});}catch(error){return failure(error);}},
  async POST(request:Request){try{
   assertAuthOrigin(request.headers);const p=await getPrincipal();
   const body=z.object({action:z.enum(['connect','reconnect','refresh','disconnect','cancel'])}).strict().parse(await readCandidateJson(request));
   if(body.action==='cancel')return Response.json(await cancelOfficialPlanAuth(p),{headers});
   // Auth protocol candidates are dormant as a whole, including refresh/revocation I/O.
   if(!services.transports.length)throw new HttpError(409,OFFICIAL_AUTH_UNAVAILABLE);
   const result=body.action==='connect'||body.action==='reconnect'?await startOfficialPlanAuth(p,body.action==='reconnect',services):await operateOfficialPlanAuth(p,body.action==='refresh'?'refresh':'revoke',services);
   return Response.json(result,{headers});
  }catch(error){return failure(error);}},
 };
}

/** Adapter ingress is opaque bearer-bound; this is not an OpenAI HTTPS OAuth redirect. */
export async function officialPlanReturnHttp(request:Request,attemptId:string,services:OfficialAuthServices=officialAuthServices()){
 try{
  if(!services.transports.length)throw new HttpError(409,OFFICIAL_AUTH_UNAVAILABLE);
  return Response.json(await returnOfficialPlanAuth(attemptId,request.headers.get('authorization'),await readCandidateJson(request),services),{headers});
 }catch(error){return failure(error);}
}
