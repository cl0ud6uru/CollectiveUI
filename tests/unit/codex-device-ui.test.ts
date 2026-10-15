import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PersonalCodexConnection, type DeviceSetupView } from '@/components/settings/personal-codex-connection';
import type { ConnectionView } from '@/personal-codex/contracts';
const setup: DeviceSetupView = { eligible: true, reason: null, canPrepareRuntime: true, runtime: { state: 'ready', selfEnrollment: true, enrolled: false, runtimeState: 'not_started' } };
const render = (initialView: ConnectionView, deviceSetup = setup) => renderToStaticMarkup(createElement<{ initialView?: ConnectionView; setup?: DeviceSetupView }>(PersonalCodexConnection, { initialView, setup: deviceSetup }));
describe('stock Codex browser device connection UI', () => {
  it('offers device sign-in with explicit consent and no native companion dependency', () => {
    const html = render({ state: 'not_started' });
    expect(html).toContain('use my ChatGPT account for stock Codex');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Connect stock Codex<\/button>/);
    expect(html).not.toMatch(/local sign-in app|legacy|collectiveui-chatgpt/);
  });
  it('shows only the exact official OpenAI device page and browser-safe code', () => {
    const html = render({ state: 'pending', login: { verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH', expiresAt: '2026-10-16T12:00:00.000Z' } });
    expect(html).toContain('ABCD-EFGH');
    expect(html).toContain('href="https://auth.openai.com/codex/device"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('Cancel Codex sign-in');
    expect(html).not.toContain('Confirm stock Codex account');
  });
  it('does not render unexpected verification origins', () => {
    const html = render({ state: 'pending', login: { verificationUrl: 'https://other.example.test', userCode: 'ABCD-EFGH', expiresAt: '2026-10-16T12:00:00.000Z' } });
    expect(html).not.toContain('https://other.example.test');
    expect(html).not.toContain('ABCD-EFGH');
  });
  it('shows verified identity and requires a separate confirmation before binding', () => {
    const html = render({ state: 'confirm', email: 'personal@example.test', workspaceId: 'account-42', planType: 'plus' });
    expect(html).toContain('personal@example.test'); expect(html).toContain('account-42');
    expect(html).toContain('this verified OpenAI account belongs to me');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Confirm stock Codex account<\/button>/);
    expect(html).not.toContain('Connect stock Codex');
  });
  it('offers expiry recovery with a new code', () => {
    const html = render({ state: 'expired' });
    expect(html).toContain('device code expired'); expect(html).toContain('Retry stock Codex sign-in');
  });
  it('offers reconnect and disconnect while explaining native independence', () => {
    const html = render({ state: 'connected', email: 'personal@example.test', workspaceId: 'account-42' });
    expect(html).toContain('Reconnect stock Codex'); expect(html).toContain('Disconnect stock Codex');
    expect(html).toContain('Native CollectiveUI sign-in is managed separately');
  });
  it('offers disconnect rather than silently binding a changed account', () => {
    const html = render({ state: 'changed', email: 'changed@example.test', workspaceId: 'other-account' });
    expect(html).toContain('Disconnect stock Codex'); expect(html).not.toContain('Confirm stock Codex account'); expect(html).not.toContain('Reconnect stock Codex');
  });
  it('explains eligibility or runtime blockers without enabling connect', () => {
    const html = render({ state: 'not_started', canConnect: false }, { ...setup, eligible: false, reason: 'ChatGPT access is disabled.' });
    expect(html).toContain('ChatGPT access is disabled.'); expect(html).not.toContain('Connect stock Codex</button>');
  });
});
