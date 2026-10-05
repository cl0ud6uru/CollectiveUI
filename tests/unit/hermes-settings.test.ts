import { describe, expect, it } from 'vitest';
import { providerBlocker, type ProfileSettings } from '@/docker-hermes/settings';

const saved = (): ProfileSettings => ({
  revision: 'a'.repeat(64), provider: null, model: 'anthropic/claude-opus-4.6',
  reasoningEffort: '', maxTurns: null, advancedSupported: true,
  credentials: { 'openai-api': false, anthropic: false, openrouter: false, 'openai-codex': false },
  editableProviders: { 'openai-api': true, anthropic: true, openrouter: true, 'openai-codex': true },
});

describe('Hermes setup compatibility diagnostics', () => {
  it('distinguishes a missing bridge capability from a protected native route', () => {
    const oldBridge = saved();
    delete (oldBridge.editableProviders as Partial<ProfileSettings['editableProviders']>)['openai-codex'];
    expect(providerBlocker(oldBridge, 'openai-codex')).toContain('update the Hermes bridge');
    const guarded = saved(); guarded.editableProviders['openai-codex'] = false;
    expect(providerBlocker(guarded, 'openai-codex')).toContain('endpoint, authentication mode and credential pool');
  });

  it('uses only safe known reason codes and tolerates old or newer bridges', () => {
    const guarded = saved(); guarded.editableProviders['openai-codex'] = false;
    guarded.providerBlockers = { 'openai-codex': 'custom_endpoint' };
    expect(providerBlocker(guarded, 'openai-codex')).toContain('custom provider endpoint');
    guarded.providerBlockers = { 'openai-codex': 'secret-value' } as unknown as ProfileSettings['providerBlockers'];
    expect(providerBlocker(guarded, 'openai-codex')).not.toContain('secret-value');
    guarded.providerBlockers = { 'openai-codex': '__proto__' } as unknown as ProfileSettings['providerBlockers'];
    expect(providerBlocker(guarded, 'openai-codex')).toContain('endpoint, authentication mode and credential pool');
    expect(providerBlocker(saved(), 'openai-codex')).toBeNull();
  });
});
