import type { NativeSessionView } from './view';

export type NativeModelChoice = { provider: string; providerName: string; model: string };
const providerId = /^[a-z0-9][a-z0-9._:-]{0,99}$/i;
const modelId = /^[a-z0-9][a-z0-9._:/+-]{0,199}$/i;

/** Mutations are enabled only for the exact pinned runtime and matching profile identity. */
export function sessionModelCompatible(view: Pick<NativeSessionView, 'runtimeVersion' | 'desktopContract' | 'nativeProfile' | 'profile'>) {
  return view.runtimeVersion === '0.21.5' && view.desktopContract === 8 && view.nativeProfile === view.profile;
}

/** Project only explicitly authenticated inventory IDs; never accept a provider/model from free-form RPC input. */
export function nativeModelChoices(raw: unknown): NativeModelChoice[] {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const choices: NativeModelChoice[] = [];
  for (const item of Array.isArray(data.providers) ? data.providers.slice(0, 200) : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const provider = typeof row.slug === 'string' ? row.slug.trim() : '';
    if (!providerId.test(provider) || row.authenticated !== true) continue;
    const providerName = typeof row.name === 'string' ? row.name.slice(0, 200) : provider;
    const models = Array.isArray(row.models) ? row.models.slice(0, 2000) : [];
    for (const value of models) {
      if (typeof value !== 'string') continue;
      const model = value.trim();
      if (modelId.test(model)) choices.push({ provider, providerName, model });
    }
  }
  return choices;
}

export function resolveNativeModelChoice(choices: NativeModelChoice[], model: string, provider?: string): NativeModelChoice {
  const candidates = choices.filter(choice => choice.model === model && (!provider || choice.provider === provider));
  if (candidates.length !== 1) throw new Error(candidates.length ? 'Choose a provider for this model.' : 'Choose a model and provider from the authenticated Hermes inventory.');
  return candidates[0];
}
