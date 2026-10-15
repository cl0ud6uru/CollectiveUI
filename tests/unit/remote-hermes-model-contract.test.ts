import { describe, expect, it } from 'vitest';
import { nativeModelChoices, resolveNativeModelChoice, sessionModelCompatible } from '@/lib/remote-hermes/model-contract';

describe('pinned native model control contract', () => {
  it('requires the exact runtime and profile identity used by the inspected pin', () => {
    const base = { runtimeVersion: '0.21.5', desktopContract: 8, profile: 'work', nativeProfile: 'work' };
    expect(sessionModelCompatible(base)).toBe(true);
    expect(sessionModelCompatible({ ...base, runtimeVersion: '0.21.6' })).toBe(false);
    expect(sessionModelCompatible({ ...base, desktopContract: 9 })).toBe(false);
    expect(sessionModelCompatible({ ...base, nativeProfile: 'personal' })).toBe(false);
  });

  it('projects only explicitly authenticated, bounded provider and model IDs', () => {
    expect(nativeModelChoices({ providers: [
      { slug: 'openrouter', name: 'OpenRouter', authenticated: true, models: ['org/model-v1', ' bad model ', { id: 'injected' }] },
      { slug: 'provider\r\n--global', name: 'Injected provider', authenticated: true, models: ['model'] },
      { slug: 'safe-provider', name: 'Safe Provider', authenticated: true, models: ['model\n--global', 'model;--global', '--once'] },
      { slug: 'missing-auth', authenticated: false, models: ['model'] },
      { slug: 'bad provider', authenticated: true, models: ['model'] },
    ] })).toEqual([{ provider: 'openrouter', providerName: 'OpenRouter', model: 'org/model-v1' }]);
  });

  it('requires one exact current inventory match and rejects ambiguity', () => {
    const choices = [
      { provider: 'openai', providerName: 'OpenAI', model: 'model-a' },
      { provider: 'anthropic', providerName: 'Anthropic', model: 'model-a' },
    ];
    expect(resolveNativeModelChoice(choices, 'model-a', 'anthropic')).toEqual(choices[1]);
    expect(() => resolveNativeModelChoice(choices, 'model-a')).toThrow('Choose a provider');
    expect(() => resolveNativeModelChoice(choices, 'not-listed', 'openai')).toThrow('authenticated Hermes inventory');
  });
});
