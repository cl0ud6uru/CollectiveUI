import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';

const fixture = vi.hoisted(() => ({
  enabled: true,
  connections: [] as { id: string; name: string }[],
  recent: [] as { id: string; title: string; profile: string; connectionId: string; connectionName: string; status: string }[],
  listConnections: vi.fn(),
}));
vi.mock('@/lib/session', () => ({ requirePagePrincipal: async () => ({ user: { id: 'owner' } }) }));
vi.mock('@/lib/settings', () => ({ getSetting: async () => ({ enabled: fixture.enabled }) }));
vi.mock('@/lib/remote-hermes/store', () => ({ listRemoteConnections: fixture.listConnections }));
vi.mock('@/components/page-frame', () => ({ PageFrame: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/db', () => ({ db: { select: () => ({ from: () => ({ innerJoin: () => ({ where: () => ({ orderBy: () => ({ limit: async () => fixture.recent }) }) }) }) }) } }));

import HermesHome from '@/app/(chat)/hermes/page';

describe('Hermes navigation from existing deep links', () => {
  beforeEach(() => {
    fixture.enabled = true;
    fixture.connections = [];
    fixture.recent = [];
    fixture.listConnections.mockReset().mockImplementation(async () => fixture.connections);
  });

  it('takes connection management straight to the Remote Hermes section in Settings', async () => {
    const html = renderToStaticMarkup(await HermesHome());
    expect(html).toContain('href="/settings?tab=connected-accounts&amp;section=remote-hermes"');
    expect(html).toContain('Manage Hermes connections');
    expect(fixture.listConnections).toHaveBeenCalledWith('owner');
  });

  it('keeps saved connections reachable when new remote connections are disabled', async () => {
    fixture.enabled = false;
    fixture.connections = [{ id: 'saved connection', name: 'Saved server' }];
    const html = renderToStaticMarkup(await HermesHome());
    expect(html).toContain('href="/settings?tab=connected-accounts&amp;section=remote-hermes"');
    expect(html).toContain('href="/hermes/saved%20connection"');
  });

  it('omits management when the user has no Remote Hermes settings to open', async () => {
    fixture.enabled = false;
    const html = renderToStaticMarkup(await HermesHome());
    expect(html).not.toContain('Manage Hermes connections');
    expect(html).toContain('Personal remote Hermes is disabled.');
  });

  it('preserves the existing connection and session deep links', async () => {
    fixture.connections = [{ id: 'home/server', name: 'Home' }];
    fixture.recent = [{ id: 'saved session', title: 'Existing chat', profile: 'research', connectionId: 'home/server', connectionName: 'Home', status: 'idle' }];
    const html = renderToStaticMarkup(await HermesHome());
    expect(html).toContain('href="/hermes/home%2Fserver"');
    expect(html).toContain('href="/hermes/home%2Fserver?session=saved%20session"');
  });
});
