import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/db',()=>({db:{}}));
import { mapUsage, newUsageScope, recordUsage, setUsageWriter } from '@/lib/llm/usage';
import type { UsageEvent } from '@/db/schema';
afterEach(()=>setUsageWriter(null));
describe('route-based subscription isolation',()=>{
 it.each(['chat','delegate','title','memory','draft','embedding'] as const)('preserves %s subscription activity without API dollars',async purpose=>{
  const rows:UsageEvent[]=[];setUsageWriter(async row=>{rows.push(row);});const scope=newUsageScope({runId:'background-or-delegated'});
  await recordUsage({purpose,billingSource:'chatgpt_plan',providerKind:'chatgpt',model:'api-looking-model',credentialId:'personal-owner',appId:'app',scope},mapUsage({inputTokens:{total:120},outputTokens:{total:40}}),{hostedSearchCalls:1,searchToolCostEstimateMicros:10000});
  expect(rows[0]).toMatchObject({inputTokens:120,outputTokens:40,costMicros:null,searchToolCostEstimateMicros:null,billingRoute:'subscription:chatgpt',credentialId:'personal-owner',runId:'background-or-delegated'});
 });
 it('never converts unverified Hermes activity or model names to API spend',async()=>{
  const rows:UsageEvent[]=[];setUsageWriter(async row=>{rows.push(row);});
  for(const billingSource of ['hermes','chatgpt_plan','org'] as const) await recordUsage({purpose:'delegate',billingSource,providerKind:'hermes',model:'gpt-api-model',appId:'bot'},mapUsage({inputTokens:{total:99}}),{searchToolCostEstimateMicros:10000});
  expect(rows.every(row=>row.costMicros===null && row.searchToolCostEstimateMicros===null)).toBe(true);
 });
 it('copies immutable routing facts per call; changing a connection cannot relabel history',async()=>{
  const rows:UsageEvent[]=[];setUsageWriter(async row=>{rows.push(row);});
  const context={purpose:'chat' as const,billingSource:'org' as const,providerKind:'openai' as const,model:'subscription-looking-model',appId:'app',providerConnectionId:'first',providerOrganization:'org-one',providerProject:'proj-one',billingRoute:'api:openai'};
  await recordUsage(context,mapUsage(undefined),{searchToolCostEstimateMicros:10000});context.providerConnectionId='second';context.providerOrganization='org-two';context.providerProject='proj-two';
  await recordUsage(context,mapUsage(undefined));expect(rows[0]).toMatchObject({providerConnectionId:'first',providerOrganization:'org-one',providerProject:'proj-one',searchToolCostEstimateMicros:10000});
 });
});
