import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decrypt } from '@/lib/crypto';

const fixture = vi.hoisted(() => ({
  getSetting: vi.fn(), transaction: vi.fn(), insert: vi.fn(), profiles: vi.fn(), login: vi.fn(),
  values: null as null | Record<string, unknown>,
}));
vi.mock('@/lib/settings', () => ({ getSetting: fixture.getSetting }));
vi.mock('@/db', () => ({ db: { transaction: fixture.transaction } }));
vi.mock('@/lib/remote-hermes/transport', () => ({ dashboardFetch: () => vi.fn() }));
vi.mock('@/lib/remote-hermes/client', async original => {
  const actual = await original<typeof import('@/lib/remote-hermes/client')>();
  return { ...actual, DashboardClient: class {
    status = async () => ({ version: 'native-fixture', authRequired: true });
    passwordLogin = fixture.login;
    profiles = fixture.profiles;
  } };
});
import { connectRemoteHermes } from '@/lib/remote-hermes/store';

const input = { name: 'Home', baseUrl: 'https://hermes.example.com', mode: 'password' as const, username: 'alice', password: 'never-persist-password' };
const enabled = { enabled: true, privateGateways: [] };
describe('remote Hermes credential admission', () => {
  beforeEach(() => {
    vi.clearAllMocks(); fixture.values = null;
    fixture.getSetting.mockReset().mockResolvedValue(enabled);
    fixture.login.mockReset().mockResolvedValue({ mode: 'password', accessToken: 'fixture-access', refreshToken: 'fixture-refresh' });
    fixture.profiles.mockReset().mockResolvedValue([{ name: 'alice' }]);
    fixture.transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => run({
      select: () => ({ from: () => ({ where: () => ({ for: async () => [] }) }) }),
      insert: fixture.insert,
    }));
    fixture.insert.mockImplementation(() => ({ values: (values: Record<string, unknown>) => {
      fixture.values = values;
      return { returning: async () => [{ id: values.id, name: values.name, baseUrl: values.baseUrl, authMode: values.authMode, version: values.version }] };
    } }));
  });
  it('retires the old connection identity when account B replaces account A at the same URL', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    fixture.transaction.mockImplementation(async run => run({
      select: () => ({ from: (table: Record<symbol, unknown>) => ({ where: () => ({ for: async () => table[Symbol.for('drizzle:Name')] === 'settings' ? [] : [{ id: 'account-a-connection' }] }) }) }),
      delete: () => ({ where: remove }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: 'account-a-connection' }] }) }) }),
      insert: fixture.insert,
    }));
    fixture.login.mockResolvedValue({ mode: 'password', accessToken: 'account-b', userId: 'account-b' });
    fixture.profiles.mockResolvedValue([{ name: 'default' }]);
    const result = await connectRemoteHermes('owner-1', input);
    expect(result.connection.id).not.toBe('account-a-connection');
    expect(remove).toHaveBeenCalledOnce();
    expect(fixture.values?.userId).toBe('owner-1');
  });
  it('rejects sign-in before credentials are sent when organization access is off', async () => {
    fixture.getSetting.mockResolvedValue({ enabled: false, privateGateways: [] });
    await expect(connectRemoteHermes('owner-1', input)).rejects.toThrow('disabled');
    expect(fixture.login).not.toHaveBeenCalled(); expect(fixture.transaction).not.toHaveBeenCalled();
  });
  it('rechecks policy after remote sign-in so disabling during the handshake prevents storage', async () => {
    fixture.getSetting.mockResolvedValueOnce(enabled).mockResolvedValue({ enabled: false, privateGateways: [] });
    await expect(connectRemoteHermes('owner-1', input)).rejects.toThrow('disabled');
    expect(fixture.login).toHaveBeenCalledOnce(); expect(fixture.insert).not.toHaveBeenCalled();
  });
  it('does not save credentials when the authenticated profile check fails', async () => {
    fixture.profiles.mockRejectedValue(new Error('credential rejected'));
    await expect(connectRemoteHermes('owner-1', input)).rejects.toThrow('credential rejected');
    expect(fixture.transaction).not.toHaveBeenCalled();
  });
  it('seals tokens to the row and owner, discards passwords and returns only connection metadata', async () => {
    const result = await connectRemoteHermes('owner-1', input);
    const row = fixture.values!;
    const aad = `remote_hermes_connections.secret_enc|${row.id}|owner-1`;
    expect(JSON.parse(decrypt(String(row.secretEnc), aad))).toMatchObject({ accessToken: 'fixture-access', refreshToken: 'fixture-refresh' });
    expect(() => decrypt(String(row.secretEnc), aad.replace('owner-1', 'owner-2'))).toThrow();
    expect(JSON.stringify(row)).not.toMatch(/never-persist-password|fixture-access|fixture-refresh/);
    expect(JSON.stringify(result)).not.toMatch(/secretEnc|fixture-access|fixture-refresh|never-persist-password/);
    expect(row.userId).toBe('owner-1');
  });
});
