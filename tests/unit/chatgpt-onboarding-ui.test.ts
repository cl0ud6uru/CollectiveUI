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
const companionReady: ChatGPTAccountView = { ...initial, setup: { ...initial.setup!, authentication: { state: 'companion_ready', reason: 'Open the installed ChatGPT sign-in app to continue.' } } };
const render = (view = initial) => renderToStaticMarkup(createElement<{ initialView?: ChatGPTAccountView }>(ChatGPTConnection, { initialView: view }));

describe('truthful account setup UI', () => {
  it('keeps native sign-in independent and disabled without a companion', () => {
    const html = render();
    expect(html).toContain('Each connection has its own sign-in and status.');
    expect(html).not.toMatch(/<input[^>]*checked/);
    expect(html).not.toContain('Prepare private runtime');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="chatgpt-companion-status"[^>]*>Connect ChatGPT<\/button>/);
    expect(html).not.toMatch(/chatgpt-profile|chatgpt:import|chatgpt:sign-in|secure SSH|run:/);
  });

  it('does not present prepared infrastructure as an authenticated ChatGPT account', () => {
    const html = render({ ...initial, setup: { ...initial.setup!, canPrepareRuntime: true,
      runtime: { state: 'ready', selfEnrollment: true, enrolled: true, runtimeState: 'running' } } });
    expect(html).not.toContain('Private Codex runtime');
    expect(html).toContain('Local sign-in app required');
    expect(html).not.toContain('Prepare private runtime');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Connect ChatGPT<\/button>/);
  });

  it('offers explicit local companion consent only when the companion is ready', () => {
    const html = render(companionReady);
    expect(html).toContain('Local sign-in app ready');
    expect(html).toContain('I authorize this installation to use my ChatGPT account for Native CollectiveUI.');
    expect(html).not.toContain('Prepare and use my private stock Codex runtime');
    expect(html).not.toMatch(/chatgpt-profile|chatgpt:import|secure SSH|run:/);
  });

  it('shows sanitized waiting status and cancellation without exposing launch capabilities', () => {
    const html = render({ ...companionReady, signIn: { state: 'receiving', expiresAt: '2026-10-14T12:00:00.000Z' } });
    expect(html).toContain('The local app is returning your sign-in. This may take a moment.');
    expect(html).toContain('Cancel sign-in');
    expect(html).not.toMatch(/ticket|capability|launchUrl|attemptId/);
  });

  it('does not treat a completed historical transfer as a currently connected account', () => {
    const html = render({ ...companionReady, signIn: { state: 'complete', expiresAt: '2026-10-14T12:00:00.000Z' } });
    expect(html).toContain('<dd>Sign-in completed</dd>');
    expect(html).not.toContain('<dd>Connected</dd>');
  });

  it('preserves connected-state cleanup without offering repeated preparation', () => {
    const html = render({ ...initial, credential: { email: 'alice@test.invalid', planType: null, status: 'active', migrationRequired: false },
      backends: { native: { state: 'connected' }, codex: { state: 'connected' } },
      setup: { ...initial.setup!, runtime: { state: 'ready', selfEnrollment: true, enrolled: true, runtimeState: 'running' } } });
    expect(html).toContain('<dd>Connected</dd>');
    expect(html).toContain('Disconnect Native ChatGPT');
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
    expect(html).not.toContain('Private Codex runtime');
    expect(html).not.toContain('Prepare private runtime');
    expect(html).toContain('local sign-in app is required');
  });

  it('retains a distinct backend prerequisite while showing a policy reason once', () => {
    const reason = 'ChatGPT connections are disabled.';
    const html = render({ ...initial, allowed: false, reason,
      backends: { native: { state: 'disabled', reason }, codex: { state: 'unavailable', reason: 'Stock Codex requires an approved runtime installation.' } } });
    expect(html.split(reason).length - 1).toBe(1);
    expect(html).not.toContain('Stock Codex requires an approved runtime installation.');
  });
});
