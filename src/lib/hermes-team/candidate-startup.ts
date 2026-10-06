import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { hermesTeamCandidateContexts } from '@/db/schema';
import { HttpError } from '@/lib/authz';
import type { Principal } from '@/lib/auth/groups';
import { dockerControl,dockerFetch } from '@/lib/docker-hermes/client';
import { LOCAL_ORIGIN } from '@/lib/local-hermes/client';
import { candidateRun,issueTeamCandidateContext } from './candidate-context';
import { TEAM_MODEL_PURPOSES,VERIFIED_TEAM_MODEL_ROUTES,type VerifiedTeamModelRoute } from './model-policy';

/** Concrete trusted startup caller. Browser responses never contain native bearer grants or profile identities. */
export async function prepareTeamCandidateRun(p:Principal,botId:string,runId:string,choice:'default'|'personal',routes:readonly VerifiedTeamModelRoute[]=VERIFIED_TEAM_MODEL_ROUTES){
  const current=await candidateRun(p,runId);
  if(current.bot.id!==botId)throw new HttpError(404,'Team run not found.');
  const url=process.env.HERMES_TEAM_GATEWAY_ORIGIN;
  if(!url)throw new HttpError(409,'The server native model gateway is not configured.');
  const origin=new URL(url);
  if(origin.protocol!=='https:' || origin.username || origin.password || origin.pathname!=='/' || origin.search || origin.hash)throw new HttpError(409,'The native gateway requires a fixed HTTPS origin.');
  const issued=await issueTeamCandidateContext(p,runId,choice,routes);
  try{
    const grant=await dockerControl<{grantId:string}>(p.user.id,'/team/authorize',{teamBotId:botId,mode:current.chat.mode,modelPolicy:current.definition.modelPolicy.mode});
    const base=`${origin.origin}/api/hermes-team/native/${issued.contextId}`;
    const binding=current.profile.binding as {bindingId?:string};
    const body={teamBotId:botId,mode:current.chat.mode,bindingId:binding.bindingId,runId,contextId:issued.contextId,expiresAt:issued.expiresAt,
      model:issued.model,adapterId:issued.adapterId,modelBaseUrls:Object.fromEntries(TEAM_MODEL_PURPOSES.map(purpose=>[purpose,`${base}/model/${purpose}`])),
      modelTokens:issued.modelTokens,toolUrl:`${base}/mcp`,toolToken:issued.toolToken};
    const response=await dockerFetch(p.user.id)(`${LOCAL_ORIGIN}/team/prepare-candidate`,{method:'POST',headers:{'Content-Type':'application/json','x-collective-team-grant':grant.grantId},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw new HttpError(409,'The native broker could not prepare this candidate adapter.');
    // Repeat permission checks after IPC. The native chat gate remains closed even for a prepared candidate.
    await candidateRun(p,runId);
    return {prepared:true,modelAccessAvailable:false};
  }catch(error){await db.update(hermesTeamCandidateContexts).set({revokedAt:new Date()}).where(eq(hermesTeamCandidateContexts.id,issued.contextId));throw error;}
}
