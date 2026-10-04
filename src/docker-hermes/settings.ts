import { z } from 'zod';

/** API-key routes verified against the pinned Hermes release; no browser-selected endpoints. */
export const profileProviders = [
  { id: 'openai-api', label: 'OpenAI API', example: 'Your OpenAI model ID' },
  { id: 'anthropic', label: 'Anthropic', example: 'Your Claude model ID' },
  { id: 'openrouter', label: 'OpenRouter', example: 'provider/model' },
] as const;
export const providerId = z.enum(['openai-api', 'anthropic', 'openrouter']);
export const reasoningLevels = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export const profileValues = z.object({
  provider: providerId,
  model: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/),
  reasoningEffort: z.enum(reasoningLevels),
  maxTurns: z.number().int().min(1).max(1000).nullable(),
}).strict();
export const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const profileUpdate = profileValues.extend({
  revision,
  credential: z.discriminatedUnion('action', [
    z.object({ action: z.literal('keep') }).strict(),
    z.object({ action: z.literal('clear') }).strict(),
    z.object({ action: z.literal('replace'), value: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/) }).strict(),
  ]),
}).strict();
export const profileTest = z.object({ revision, requestId: z.string().uuid(), consent: z.literal(true) }).strict();
export type ProfileValues = z.infer<typeof profileValues>;
export type ProfileUpdate = z.infer<typeof profileUpdate>;
export const testCodes = ['verified', 'authentication_failed', 'model_rejected', 'network_blocked', 'connection_failed', 'not_configured', 'unsupported', 'uncertain'] as const;
export type ProfileTestResult = { code: typeof testCodes[number]; checkedAt: string; revision: string };
export type ProfileSettings = {
  revision: string;
  provider: ProfileValues['provider'] | null;
  model: string;
  reasoningEffort: ProfileValues['reasoningEffort'];
  maxTurns: number | null;
  credentials: Record<ProfileValues['provider'], boolean>;
  advancedSupported: boolean;
  editableProviders: Record<ProfileValues['provider'], boolean>;
  lastTest?: ProfileTestResult | null;
};
export const testMessages: Record<ProfileTestResult['code'], string> = {
  verified: 'Connection verified for this saved model and API key.',
  authentication_failed: 'The provider rejected the API key. Replace it and test again.',
  model_rejected: 'The provider rejected this model or request. Check the model ID and your account access.',
  network_blocked: 'This runtime is offline. An operator must configure reviewed provider egress before a connection test can run. No inference request was sent.',
  connection_failed: 'The provider could not be reached. This may be DNS, proxy policy, a timeout, or provider availability; it does not prove that the key is invalid.',
  not_configured: 'Save a provider, model and API key for this profile before testing.',
  unsupported: 'This profile uses native routing or authentication settings outside this API-key editor. Use native maintenance to reconcile them first.',
  uncertain: 'The test outcome is unknown. It was not automatically retried and may have incurred a charge. Reload before starting a new test.',
};
