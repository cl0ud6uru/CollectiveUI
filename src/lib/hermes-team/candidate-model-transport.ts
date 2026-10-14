import { and, eq } from 'drizzle-orm';
import { aiApps, officialPlanConnections } from '@/db/schema';
import type { Tx } from '@/db';
import { HttpError } from '@/lib/authz';
import { providerContextFor } from '@/lib/llm/resolve';
import { apiKeyOf } from '@/lib/llm/providers/shared';
import { OFFICIAL_PLAN_ORIGIN,OFFICIAL_PLAN_ADAPTER,openOfficialPlanSecret,officialPlanMetadata } from './official-plan';
import type { CandidateContext } from './candidate-context';
import type { TeamNativeModelProtocol } from './native-request';

export const CANDIDATE_MODEL_ADAPTERS = Object.freeze({
  'collective-openai-chat-v1': 'chat_completions',
  'collective-openai-responses-v1': 'responses',
  'collective-codex-responses-v1': 'responses',
  [OFFICIAL_PLAN_ADAPTER]:'responses',
} satisfies Record<string,TeamNativeModelProtocol>);
export type CandidateModelWire = { attribution?: import("@/lib/llm/resolve").ApiUsageAttribution; send(body: Record<string,unknown>, signal: AbortSignal): Promise<Response>; secrets: string[] };

/** Server-only transport. No ambient provider key, native auth pool, alternate model or redirect fallback. */
export async function loadCandidateModelWire(context: CandidateContext, protocol: TeamNativeModelProtocol, tx: Tx, baseFetch: typeof fetch = fetch): Promise<CandidateModelWire> {
  const route = context.modelRoute;
  if (CANDIDATE_MODEL_ADAPTERS[route.adapterId as keyof typeof CANDIDATE_MODEL_ADAPTERS] !== protocol) throw new HttpError(409, 'Unsupported native model transport.');
  if(route.integration==='openai_chatgpt_plan_usage'){
    if(route.billing!=='personal' || route.adapterId!==OFFICIAL_PLAN_ADAPTER || route.limitContract!=='local_only' || !context.personalConnectionId)throw new HttpError(409,'Unsupported official personal route.');
    const metadata=await officialPlanMetadata(context.actorId,route.model,tx);
    if(!metadata || metadata.id!==context.personalConnectionId || metadata.bindingHash!==context.personalBindingHash)throw new HttpError(409,'The official personal account changed.');
    const [row]=await tx.select().from(officialPlanConnections).where(and(eq(officialPlanConnections.id,metadata.id),eq(officialPlanConnections.userId,context.actorId)));
    const secret=openOfficialPlanSecret(row);
    return {secrets:[secret.access,secret.refresh??'',secret.idToken??''],send:(body,signal)=>baseFetch(`${OFFICIAL_PLAN_ORIGIN}/responses`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${secret.access}`},body:JSON.stringify(body),signal,redirect:'error'})};
  }
  if (route.integration === 'hermes_native_codex') {
    // Retained private-backend grants are incompatible with the unified supported SIWC transport.
    // Fail before loading/decrypting credentials; other Hermes routes keep their separate setup.
    throw new HttpError(409, 'The retained Hermes route requires separate setup. Use your unified SIWC account with the native CollectiveUI harness or stock Codex.');
  }
  if (route.billing !== 'admin' || !route.id.startsWith('app:')) throw new HttpError(409, 'The admin gateway needs a fixed server provider connection.');
  const [app] = await tx.select().from(aiApps).where(eq(aiApps.id,route.id.slice(4)));
  if (!app || !app.enabled || !['openai','openai-compatible'].includes(app.provider) || app.credentialMode !== 'org' || app.model !== route.model) throw new HttpError(409, 'The fixed admin provider changed.');
  const provider = await providerContextFor(app,{},tx);
  const key = apiKeyOf(provider);
  const base = provider.baseUrl ?? (app.provider === 'openai' ? 'https://api.openai.com/v1' : null);
  if (!base) throw new HttpError(409, 'The admin provider needs a fixed endpoint.');
  const url = new URL(`${base.replace(/\/$/,'')}/${protocol === 'responses' ? 'responses' : 'chat/completions'}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new HttpError(409, 'Unsupported admin provider endpoint.');
  const config = provider.config as { organization?: string; project?: string };
  const headers = { 'Content-Type':'application/json',Authorization:`Bearer ${key}`,
    ...(config.organization ? { 'OpenAI-Organization':config.organization } : {}), ...(config.project ? { 'OpenAI-Project':config.project } : {}) };
  return { attribution:provider.usageAttribution,secrets:[key],send:(body,signal)=>baseFetch(url,{ method:'POST',headers,body:JSON.stringify(body),signal,redirect:'error' }) };
}
