import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, type DbOrTx } from '@/db';
import { aiApps, providerConnections, userCredentials } from '@/db/schema';
import { HttpError } from '@/lib/authz';
import type { Principal } from '@/lib/auth/groups';
import { chatgptBackendUrl } from '@/lib/llm/chatgpt/constants';
import type { VerifiedTeamModelRoute } from './model-policy';
import { canonicalTeamToolInput } from './tool-policy';

/** Hash server-owned routing and encrypted credential revision without decrypting any credential. */
export async function candidateWireMetadata(p:Principal,route:VerifiedTeamModelRoute,q:DbOrTx=db){
  let value:unknown;let providerKind:'openai'|'openai-compatible'|'chatgpt';
  if(route.integration==='hermes_native_codex'){
    const [row]=await q.select({id:userCredentials.id,userId:userCredentials.userId,provider:userCredentials.provider,status:userCredentials.status,
      accountId:userCredentials.accountId,expiresAt:userCredentials.expiresAt,credentialRevision:userCredentials.secretEnc})
      .from(userCredentials).where(and(eq(userCredentials.userId,p.user.id),eq(userCredentials.provider,'chatgpt'))).for('share');
    if(!row || row.status!=='active' || !row.expiresAt || row.expiresAt.getTime()<=Date.now())throw new HttpError(409,'The personal connection expired.');
    value={integration:route.integration,endpoint:chatgptBackendUrl(),model:route.model,credential:{...row,expiresAt:row.expiresAt.getTime()}};
    providerKind='chatgpt';
  }else{
    if(route.integration!=='admin_inference_gateway' || route.billing!=='admin' || !route.id.startsWith('app:'))throw new HttpError(409,'This native transport is unsupported.');
    const [app]=await q.select({id:aiApps.id,enabled:aiApps.enabled,provider:aiApps.provider,baseUrl:aiApps.baseUrl,model:aiApps.model,
      providerConfig:aiApps.providerConfig,credentialMode:aiApps.credentialMode,apiKeyEnc:aiApps.apiKeyEnc,providerConnectionId:aiApps.providerConnectionId})
      .from(aiApps).where(eq(aiApps.id,route.id.slice(4))).for('share');
    if(!app || !app.enabled || !['openai','openai-compatible'].includes(app.provider) || app.model!==route.model || app.credentialMode!=='org')throw new HttpError(409,'The fixed admin provider changed.');
    const [connection]=app.providerConnectionId ? await q.select({id:providerConnections.id,enabled:providerConnections.enabled,provider:providerConnections.provider,
      baseUrl:providerConnections.baseUrl,organization:providerConnections.organization,project:providerConnections.project,credentialEnc:providerConnections.credentialEnc})
      .from(providerConnections).where(eq(providerConnections.id,app.providerConnectionId)).for('share') : [];
    if(app.providerConnectionId && !connection?.enabled)throw new HttpError(409,'The fixed provider connection changed.');
    value={integration:route.integration,adapterId:route.adapterId,app,connection:connection??null};
    providerKind=app.provider as 'openai'|'openai-compatible';
  }
  return {hash:createHash('sha256').update(canonicalTeamToolInput(value)).digest('hex'),providerKind};
}
