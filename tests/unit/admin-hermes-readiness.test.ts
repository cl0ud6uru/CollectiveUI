import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DockerHermesEnrollment } from '@/components/admin/docker-hermes-enrollment';
import { HermesNetworkControl } from '@/components/admin/hermes-network-control';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/app/admin/hermes/enrollment-actions', () => ({ updateDockerEnrollment: vi.fn() }));

const people = [{ id: 'fixture', name: 'Fixture User', upn: 'fixture@example.test', enabled: true,
  cleanup: 'none', error: null, changedBy: null, changedAt: null }];

describe('admin Hermes network readiness', () => {
  it.each(['not-configured', 'unavailable'] as const)('does not claim to be checking a %s broker', status => {
    const html = renderToStaticMarkup(createElement(DockerHermesEnrollment, {
      people, readiness: { status, message: 'Broker not ready.' }, legacyConfigured: false,
    }));
    expect(html).toContain('Network unavailable · broker not ready');
    expect(html).not.toContain('Checking network');
    expect(html).toMatch(/disabled=""[^>]*aria-label="Internet access for Fixture User"/);
  });

  it('uses the loading label only while an available broker has no result', () => {
    const html = renderToStaticMarkup(createElement(DockerHermesEnrollment, {
      people, readiness: { status: 'ready', message: 'Ready.' }, legacyConfigured: false,
    }));
    expect(html).toContain('Checking network');
  });

  it('keeps network changes disabled after a failed status request', () => {
    const html = renderToStaticMarkup(createElement(HermesNetworkControl, {
      owner: 'fixture', name: 'Fixture User', enabled: true, status: null,
      unavailable: 'Network status unavailable', reload: async () => {},
    }));
    expect(html).toContain('Network status unavailable');
    expect(html).not.toContain('Checking network');
    expect(html).toMatch(/disabled=""[^>]*aria-label="Internet access for Fixture User"/);
  });
});
