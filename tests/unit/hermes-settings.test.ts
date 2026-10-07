import { describe, expect, it } from 'vitest';
import { currentProfileTest, profileConnectionVerified, providerBlocker, type ProfileSettings } from '@/docker-hermes/settings';

const saved = (): ProfileSettings => ({
  revision: 'a'.repeat(64), provider: null, model: 'anthropic/claude-opus-4.6',
  reasoningEffort: '', maxTurns: null, advancedSupported: true,
  credentials: { 'openai-api': false, anthropic: false, openrouter: false, 'openai-codex': false },
  editableProviders: { 'openai-api': true, anthropic: true, openrouter: true, 'openai-codex': true },
});

describe('Hermes setup compatibility diagnostics', () => {
  it('requires an explicit successful test of the current API-key profile before starting chat', () => {
    const profile = saved();
    profile.provider = 'openai-api'; profile.model = 'fixture-model';
    profile.credentials['openai-api'] = true;
    expect(profileConnectionVerified(profile)).toBe(false);
    profile.lastTest = { code: 'verified', revision: 'b'.repeat(64), checkedAt: '2026-10-07T00:00:00Z' };
    expect(currentProfileTest(profile)).toBeNull();
    expect(profileConnectionVerified(profile)).toBe(false);
    profile.lastTest.revision = profile.revision;
    expect(profileConnectionVerified(profile)).toBe(true);
    profile.credentials['openai-api'] = false;
    expect(profileConnectionVerified(profile)).toBe(false);
    profile.credentials['openai-api'] = true; profile.editableProviders['openai-api'] = false;
    expect(profileConnectionVerified(profile)).toBe(false);
  });

  it('does not turn failed tests or stored native subscription sign-in into verified API-key setup', () => {
    const profile = saved(); profile.provider = 'openai-api'; profile.model = 'fixture-model'; profile.credentials['openai-api'] = true;
    for (const code of ['authentication_failed', 'model_rejected', 'connection_failed', 'not_configured', 'unsupported', 'uncertain', 'network_blocked'] as const) {
      profile.lastTest = { code, revision: profile.revision, checkedAt: '2026-10-07T00:00:00Z' };
      expect(profileConnectionVerified(profile), code).toBe(false);
    }
    profile.provider = 'openai-codex'; profile.credentials['openai-codex'] = true;
    profile.lastTest = { code: 'verified', revision: profile.revision, checkedAt: '2026-10-07T00:00:00Z' };
    expect(profileConnectionVerified(profile)).toBe(false);
  });

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
