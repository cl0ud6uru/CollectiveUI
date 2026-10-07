import type { AiApp, Bot } from '@/db/schema';
import { LOCAL_ORIGIN } from '@/lib/local-hermes/client';

/** Ephemeral target metadata, never a provider connection or a browser-supplied profile. */
export function teamRuntimeApp(bot: Bot, model: string, attributionId = bot.appId ?? bot.id): AiApp {
  const now = new Date();
  return { id: attributionId, name: bot.name, description: null, icon: bot.avatar, kind: 'runtime', provider: 'hermes',
    providerConfig: { teamNative: true }, credentialMode: 'org', baseUrl: LOCAL_ORIGIN, apiKeyEnc: null, providerConnectionId: null,
    model, systemPrompt: null, temperature: null, maxTokens: null, supportsVision: true, supportsTools: true, embeddingModel: null,
    isPublic: false, enabled: true, sortOrder: 0, createdAt: now, updatedAt: now };
}
export const isTeamRuntimeApp = (app: Pick<AiApp, 'provider'|'providerConfig'>) =>
  app.provider === 'hermes' && app.providerConfig?.teamNative === true;
