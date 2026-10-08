import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/db',()=>({db:{}}));
const mocks=vi.hoisted(()=>({dispatch:vi.fn(),embed:vi.fn(),app:vi.fn()}));
vi.mock('ai',()=>({embed:mocks.embed,embedMany:vi.fn()}));
vi.mock('@/lib/llm/resolve',()=>({resolveEmbeddingDispatch:mocks.dispatch}));
vi.mock('@/lib/llm/apps',()=>({embeddingApp:mocks.app}));
import { embedTexts } from '@/lib/llm/embeddings';
import { setUsageWriter } from '@/lib/llm/usage';
import type { UsageEvent } from '@/db/schema';
afterEach(()=>{vi.resetAllMocks();setUsageWriter(null);});
it('retains the resolved connection selectors when disabled during embedding inference',async()=>{
 const rows:UsageEvent[]=[];setUsageWriter(async row=>{rows.push(row);});
 mocks.app.mockResolvedValue({id:'model',provider:'openai',embeddingModel:'embed'});
 mocks.dispatch.mockResolvedValue({model:{},attribution:{providerConnectionId:'one',providerOrganization:'org-one',providerProject:'project-one',billingRoute:'api:openai'}});
 mocks.embed.mockImplementation(async()=>{mocks.dispatch.mockRejectedValue(new Error('Connection disabled'));return{embedding:[1],usage:{tokens:12}};});
 await expect(embedTexts(['fixture'])).resolves.toEqual([[1]]);await Promise.resolve();
 expect(mocks.dispatch).toHaveBeenCalledTimes(1);expect(rows[0]).toMatchObject({inputTokens:12,providerConnectionId:'one',providerOrganization:'org-one',providerProject:'project-one'});
});
