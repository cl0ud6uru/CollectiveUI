import type { AiApp, Bot } from '@/db/schema';
import type { CodexPolicy } from './config';
import { createHash } from 'node:crypto';

/** An execution target, never a provider connection or a company-credential fallback. */
export function codexRuntimeApp(bot: Bot, policy: CodexPolicy): AiApp {
  const now = new Date();
  const revision = createHash('sha256').update(JSON.stringify({ policy, revision: bot.revision })).digest('hex').slice(0, 16);
  return { id: `codex:${bot.id}:${revision}`, name: bot.name, description: null, icon: bot.avatar, kind: 'runtime',
    provider: policy.funding === 'api' ? 'openai' : 'chatgpt', providerConfig: { codexHarness: true, ...policy },
    credentialMode: 'user', baseUrl: null, apiKeyEnc: null, providerConnectionId: null, model: policy.model,
    systemPrompt: null, temperature: null, maxTokens: null, contextWindowTokens: null, supportsVision: false, supportsTools: false,
    embeddingModel: null, isPublic: false, enabled: true, sortOrder: 0, createdAt: now, updatedAt: now };
}
export const isCodexApp = (app: Pick<AiApp, 'providerConfig'>) => app.providerConfig?.codexHarness === true;
