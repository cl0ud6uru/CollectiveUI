import { describe, expect, it, vi } from 'vitest';
import type { Tx } from '@/db';
import type { CandidateContext } from '@/lib/hermes-team/candidate-context';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/llm/resolve', () => ({ providerContextFor: vi.fn() }));
vi.mock('@/lib/llm/chatgpt/store', () => ({ openCredentialSecret: () => ({ access: 'synthetic-shared-token', siwc: { clientId: 'issued-client', hostId: 'installation', scope: 'resource.invoke chatgpt.tokens.use.direct' } }) }));
import { loadCandidateModelWire } from '@/lib/hermes-team/candidate-model-transport';

describe('shared SIWC credential transport boundary', () => {
  it('refuses the retained private Hermes adapter before any network request', async () => {
    const baseFetch = vi.fn<typeof fetch>();
    const tx = { select: () => ({ from: () => ({ where: async () => [{ id: 'own-credential', userId: 'alice', status: 'active', expiresAt: new Date(Date.now() + 60_000) }] }) }) } as unknown as Tx;
    const context = { actorId: 'alice', runId: 'own-run', personalConnectionId: 'own-credential', modelRoute: {
      integration: 'hermes_native_codex', billing: 'personal', adapterId: 'collective-codex-responses-v1', model: 'gpt-test',
    } } as unknown as CandidateContext;
    await expect(loadCandidateModelWire(context, 'responses', tx, baseFetch)).rejects.toThrow(/retained Hermes route requires separate setup/);
    expect(baseFetch).not.toHaveBeenCalled();
  });
});
