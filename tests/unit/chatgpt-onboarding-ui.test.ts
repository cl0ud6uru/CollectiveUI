import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { ChatGPTConnection, type ChatGPTAccountView } from '@/components/settings/chatgpt-connection';
vi.mock('@/components/settings/personal-codex-connection', () => ({ PersonalCodexConnection: () => null }));

const initial: ChatGPTAccountView = {
  allowed: true, reason: null, credential: null,
  backends: { native: { state: 'not_connected' }, codex: { state: 'not_started' } },
  onboarding: { state: 'ready', reason: null },
  setup: { eligible: true, reason: null, canPrepareRuntime: true,
    runtime: { state: 'ready', selfEnrollment: true, enrolled: false, runtimeState: 'not_started' },
    authentication: { state: 'companion_required', reason: 'A local sign-in app is required and is not available yet.' } },
};
const render = (view = initial) => renderToStaticMarkup(createElement<{ initialView?: ChatGPTAccountView }>(ChatGPTConnection, { initialView: view }));

describe('truthful account setup UI', () => {
  it('requires resource consent and leaves sign-in disabled without a companion', () => {
    const html = render();
    expect(html).toContain('ChatGPT plan usage is authorized separately when I sign in.');
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*>/);
    expect(html).not.toMatch(/<input[^>]*checked/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Prepare private runtime<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="chatgpt-companion-status"[^>]*>Connect ChatGPT<\/button>/);
    expect(html).not.toMatch(/chatgpt-profile|chatgpt:import|chatgpt:sign-in|secure SSH|run:/);
  });

  it('does not present prepared infrastructure as an authenticated ChatGPT account', () => {
    const html = render({ ...initial, setup: { ...initial.setup!, canPrepareRuntime: true,
      runtime: { state: 'ready', selfEnrollment: true, enrolled: true, runtimeState: 'running' } } });
    expect(html).toContain('<dd>Prepared</dd>');
    expect(html).toContain('Local sign-in app required');
    expect(html).not.toContain('Prepare private runtime');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Connect ChatGPT<\/button>/);
  });

  it('preserves connected-state cleanup without offering repeated preparation', () => {
    const html = render({ ...initial, credential: { email: 'alice@test.invalid', planType: null, status: 'active', migrationRequired: false },
      backends: { native: { state: 'connected' }, codex: { state: 'connected' } },
      setup: { ...initial.setup!, runtime: { state: 'ready', selfEnrollment: true, enrolled: true, runtimeState: 'running' } } });
    expect(html).toContain('<dd>Connected</dd>');
    expect(html).toContain('Disconnect ChatGPT');
    expect(html).not.toContain('Connect ChatGPT');
    expect(html).not.toContain('Prepare private runtime');
  });

  it('shows policy denial once and never offers preparation', () => {
    const reason = 'An administrator must enable ChatGPT access.';
    const html = render({ ...initial, allowed: false, reason });
    expect(html.split(reason).length - 1).toBe(1);
    expect(html).not.toContain('Prepare private runtime');
    expect(html).not.toContain('Connect ChatGPT');
  });

  it('shows an actionable runtime failure while retaining the companion prerequisite', () => {
    const html = render({ ...initial, setup: { ...initial.setup!, canPrepareRuntime: false,
      runtime: { state: 'unavailable', selfEnrollment: false, enrolled: false, reason: 'Retry, or ask the operator to check the runtime service.' } } });
    expect(html).toContain('Could not verify setup');
    expect(html).toContain('Retry, or ask the operator');
    expect(html).not.toContain('Prepare private runtime');
    expect(html).toContain('local sign-in app is required');
  });
});
