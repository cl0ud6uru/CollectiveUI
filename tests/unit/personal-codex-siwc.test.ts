import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { BrokerConfig, PersonalCodexDriver, dockerEnv } from '@/personal-codex/docker';
import { tokenFingerprint, tokenSyncRequest } from '@/personal-codex/contracts';

const base = { socketPath: '/run/codex.sock', image: `collectiveui/personal-codex@sha256:${'a'.repeat(64)}`, namespace: 'cui-codex-test', owners: ['alice'] };

describe('bounded Codex SIWC adapter', () => {
  it('keeps the capability unavailable until an operator records the sandbox process and shell proof', async () => {
    const driver = new PersonalCodexDriver(BrokerConfig.parse(base));
    await expect(driver.synchronizeToken('alice', 'fixture-token', tokenFingerprint('fixture-token')))
      .rejects.toThrow(/SIWC sandbox environment.*\/proc isolation proof.*operator/i);
    expect(dockerEnv).not.toHaveProperty('ACCESS_TOKEN');
  });

  it('accepts only bounded server-side credential bindings and fingerprints the token without storing it', () => {
    const token = 'fixture-access-token';
    const request = tokenSyncRequest.parse({ accessToken: token, credentialBinding: tokenFingerprint(token) });
    expect(request).toEqual({ accessToken: token, credentialBinding: tokenFingerprint(token) });
    expect(() => tokenSyncRequest.parse({ accessToken: 'x'.repeat(16_385), credentialBinding: 'a'.repeat(64) })).toThrow();
    expect(() => tokenSyncRequest.parse({ accessToken: token, credentialBinding: 'wrong' })).not.toThrow(); // Structural parsing is separate from binding verification.
  });

  it('selects the Responses provider only for SIWC and excludes ACCESS_TOKEN from shell inheritance', async () => {
    const requirements = await readFile('docker/personal-codex/requirements.toml', 'utf8');
    const wrapper = await readFile('docker/personal-codex/server.mjs', 'utf8');
    const broker = await readFile('src/personal-codex/server.ts', 'utf8');
    expect(requirements).not.toMatch(/^model_provider\s*=/m);
    expect(wrapper).toContain("'-c', 'forced_login_method=\"chatgpt\"'");
    expect(wrapper).toContain('accessToken ? [...siwcProviderArgs, ...codexArgs]');
    expect(BrokerConfig.parse(base).authenticationMode).toBe('native');
    expect(requirements).toContain('shell_environment_policy = { inherit = "none", filters = { ACCESS_TOKEN = "exclude" } }');
    expect(wrapper).toContain("'-c', 'model_providers.openai_chatgpt_plan.env_key=\"ACCESS_TOKEN\"'");
    expect(wrapper).toContain("'-c', 'shell_environment_policy.inherit=\"none\"'");
    expect(wrapper).toContain("'-c', 'shell_environment_policy.filters.ACCESS_TOKEN=\"exclude\"'");
    expect(wrapper).toContain('...(accessToken ? { ACCESS_TOKEN: accessToken } : {})');
    expect(wrapper).toContain("'/codex-home/.collective-codex-siwc.sock'");
    expect(wrapper).not.toMatch(/--env[^\n]*ACCESS_TOKEN|\bACCESS_TOKEN=[^\n]*spawn/);
    expect(broker).toContain('sync.credentialBinding !== tokenFingerprint(sync.accessToken)');
    // Readiness intentionally remains false until the real stock sandbox proof is run.
    expect(BrokerConfig.parse(base).siwcSandboxVerified).toBe(false);
  });
});
