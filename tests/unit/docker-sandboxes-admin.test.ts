import { beforeEach, describe, expect, it, vi } from 'vitest';
import { unavailableAdminSnapshot, type SandboxAdminSnapshot } from '@/personal-codex/admin-contracts';
import { HttpError } from '@/lib/authz';

const f = vi.hoisted(() => ({
  admin: true, adminVersion: 1, actorVersion: 1, disabled: false, ownerExists: true, ownerDisabled: false, activeWork: false, activateWorkAfterIntent: false, revokeAtOwnerLock: 0,
  rows: [{ id: 'alice', name: 'Alice', email: 'alice@example.test', upn: 'alice@example.test', disabled: false }],
  request: vi.fn(), auditValues: [] as Record<string, unknown>[], updateValues: [] as Record<string, unknown>[],
  locked: [] as string[], noWork: [] as string[],
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/session', () => ({ requireAdmin: async () => {
  if (!f.admin) throw new HttpError(403, 'Admin only');
  return { user: { id: 'admin', sessionVersion: f.actorVersion }, isAdmin: true };
} }));
vi.mock('@/lib/auth/groups', () => ({ loadPrincipal: async () => f.admin
  ? { user: { id: 'admin', sessionVersion: f.adminVersion, disabled: false }, isAdmin: true }
  : null }));
vi.mock('@/personal-codex/accounts', () => ({
  lockPersonalOwner: async (owner: string) => { f.locked.push(owner); if (f.locked.length === f.revokeAtOwnerLock) f.adminVersion++; if (!f.ownerExists) throw new HttpError(404, 'User unavailable'); return { id: owner, disabled: f.ownerDisabled }; },
  assertNoCodexWork: async (owner: string) => { f.noWork.push(owner); if (f.activeWork) throw new HttpError(409, 'Stop and confirm recovery of active Codex work first.'); },
}));
vi.mock('@/personal-codex/control', () => ({ personalSocket: () => '/tmp/personal-codex.sock' }));
vi.mock('@/lib/local-hermes/client', () => ({ LOCAL_ORIGIN: 'http://local-hermes.invalid', socketFetch: () => async (url: string, init?: RequestInit) => f.request(url, init) }));
vi.mock('@/db', () => {
  const makeTx = () => ({
    execute: vi.fn(async () => undefined),
    select: () => ({ from: () => ({ where: () => ({ for: async () => [{ id: 'admin' }] }) }) }),
    insert: () => ({ values: (value: Record<string, unknown>) => {
      f.auditValues.push(value);
      if (f.activateWorkAfterIntent) f.activeWork = true;
      return { returning: async () => [{ id: `audit-${f.auditValues.length}` }] };
    } }),
    update: () => ({ set: (value: Record<string, unknown>) => { f.updateValues.push(value); return { where: async () => undefined }; } }),
  });
  return { db: {
    transaction: async (run: (tx: ReturnType<typeof makeTx>) => unknown) => run(makeTx()),
    select: () => ({ from: () => ({ orderBy: () => ({ limit: async () => f.rows }) }) }),
    update: () => ({ set: (value: Record<string, unknown>) => { f.updateValues.push(value); return { where: async () => undefined }; } }),
  } };
});
vi.mock('@/db/schema', () => ({
  users: { id: 'user-id', name: 'user-name', email: 'user-email', upn: 'user-upn', disabled: 'user-disabled' },
  auditLog: { id: 'audit-id' },
}));

import { readDockerSandboxes, performDockerSandboxAction } from '@/lib/docker-sandboxes/admin';
const snapshot: SandboxAdminSnapshot = { ...unavailableAdminSnapshot(''), available: true, reason: null, backend: 'sbx', version: 'v0.48.0',
  checks: [], settings: { revision: 3, cpus: 4, memoryMb: 4096, maxRunning: 2, defaultTemplate: `registry.example/test@sha256:${'a'.repeat(64)}`, admittedOwners: ['alice'] },
  runtimes: [], templates: [], archives: [], validation: [], siwcSandboxVerified: false };
const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(JSON.stringify(value))) } });
const action = (request: unknown, result: unknown = { message: 'Action completed.' }) => {
  f.request.mockImplementation(async (url: string) => url.endsWith('/admin/snapshot') ? ok(snapshot) : ok(result));
  return performDockerSandboxAction(request);
};

describe('Docker Sandboxes admin service', () => {
  beforeEach(() => {
    vi.clearAllMocks(); f.admin = true; f.adminVersion = 1; f.actorVersion = 1; f.disabled = false;
    f.ownerExists = true; f.ownerDisabled = false; f.activeWork = false; f.activateWorkAfterIntent = false; f.revokeAtOwnerLock = 0; f.rows = [{ id: 'alice', name: 'Alice', email: 'alice@example.test', upn: 'alice@example.test', disabled: false }];
    f.auditValues = []; f.updateValues = []; f.locked = []; f.noWork = [];
    f.request.mockReset();
  });

  it('reads a schema-validated snapshot and a bounded identity-only people list', async () => {
    f.request.mockResolvedValue(ok(snapshot));
    const data = await readDockerSandboxes();
    expect(data.backend).toBe('sbx'); expect(data.people).toEqual([{ id: 'alice', name: 'Alice', email: 'alice@example.test', disabled: false }]);
  });

  it('withholds a broker snapshot if admin authority expires while the fetch is in flight', async () => {
    f.request.mockImplementation(async () => {
      f.adminVersion++;
      return ok(snapshot);
    });
    await expect(readDockerSandboxes()).rejects.toMatchObject({ status: 403 });
  });

  it('returns unavailable snapshot when the protected broker cannot be reached', async () => {
    f.request.mockRejectedValue(new Error('synthetic host path/secret'));
    const data = await readDockerSandboxes();
    expect(data.available).toBe(false); expect(data.reason).not.toContain('synthetic');
    expect(data.backend).toBe('unconfigured');
  });

  it('does not infer SBX from a configured socket when the broker is unreachable', async () => {
    vi.stubEnv('PERSONAL_CODEX_SOCKET', '/tmp/configured-socket');
    try {
      f.request.mockRejectedValue(new Error('unreachable'));
      expect((await readDockerSandboxes()).backend).toBe('unconfigured');
    } finally { vi.unstubAllEnvs(); }
  });

  it('bounds protected broker response bytes before parsing JSON', async () => {
    f.request.mockResolvedValue(new Response('{"available":true}', { status: 200, headers: { 'content-length': String(3 * 1024 * 1024) } }));
    const data = await readDockerSandboxes();
    expect(data.available).toBe(false);
  });

  it('rejects non-admin and stale-admin requests before audit or broker effects', async () => {
    f.admin = false;
    await expect(performDockerSandboxAction({ action: 'diagnose' })).rejects.toMatchObject({ status: 403 });
    f.admin = true; f.adminVersion = 2;
    await expect(performDockerSandboxAction({ action: 'diagnose' })).rejects.toMatchObject({ status: 403 });
    expect(f.auditValues).toEqual([]); expect(f.request).not.toHaveBeenCalled();
  });

  it('rejects extra browser fields and invalid action schemas before audit or broker effects', async () => {
    await expect(performDockerSandboxAction({ action: 'diagnose', actorId: 'admin', cli: ['sbx', 'delete'] })).rejects.toMatchObject({ status: 400 });
    await expect(performDockerSandboxAction({ action: 'settings', revision: 3, cpus: 100, memoryMb: 4096, maxRunning: 2, defaultTemplate: snapshot.settings.defaultTemplate })).rejects.toMatchObject({ status: 400 });
    expect(f.auditValues).toEqual([]); expect(f.request).not.toHaveBeenCalled();
  });

  it('serializes owner actions on the exact owner lock and forwards only the typed owner action', async () => {
    const result = await action({ action: 'lifecycle', ownerId: 'alice', operation: 'stop' });
    expect(result.result.message).toBe('Action completed.');
    expect(f.locked).toEqual(['alice', 'alice']);
    const brokerCall = f.request.mock.calls.find(([url]) => String(url).endsWith('/admin/action'))!;
    expect(JSON.parse(String(brokerCall[1]?.body))).toEqual({ actorId: 'admin', request: { action: 'lifecycle', ownerId: 'alice', operation: 'stop' } });
  });

  it('rechecks admin authority after waiting for the owner lock and before broker dispatch', async () => {
    f.revokeAtOwnerLock = 2; // revoke the admin grant while the dispatch phase waits for Alice's lock
    await expect(action({ action: 'lifecycle', ownerId: 'alice', operation: 'stop' })).rejects.toMatchObject({ status: 403 });
    expect(f.locked).toEqual(['alice', 'alice']);
    expect(f.auditValues).toHaveLength(1); // the already-authorized durable intent remains reviewable
    expect(f.request).not.toHaveBeenCalled();
    expect(f.updateValues).toContainEqual({ details: { status: 'failed', request: { action: 'lifecycle', ownerId: 'alice', operation: 'stop' }, failure: 'authorization_changed' } });
  });

  it('rechecks disabled-owner policy and idle work before provisioning, starting, deleting or revoking admission', async () => {
    f.ownerDisabled = true;
    await expect(action({ action: 'lifecycle', ownerId: 'alice', operation: 'start' })).rejects.toMatchObject({ status: 403 });
    expect(f.request).not.toHaveBeenCalled();
    await action({ action: 'lifecycle', ownerId: 'alice', operation: 'stop' });
    expect(f.request).toHaveBeenCalled();
    f.request.mockClear();
    await action({ action: 'enrollment', revision: 3, ownerId: 'alice', admitted: false });
    expect(f.noWork).toContain('alice'); expect(f.request).toHaveBeenCalled();
  });

  it('requires an existing owner and prevents any broker action for a foreign or missing owner row', async () => {
    f.ownerExists = false;
    await expect(action({ action: 'network-add', ownerId: 'mallory', effect: 'allow', destination: 'example.test' })).rejects.toMatchObject({ status: 404 });
    expect(f.request).not.toHaveBeenCalled();
  });

  it('requires DELETE confirmation and an idle owner before deleting the sandbox VM', async () => {
    await expect(performDockerSandboxAction({ action: 'lifecycle', ownerId: 'alice', operation: 'delete' })).rejects.toMatchObject({ status: 400, message: 'Confirm sandbox deletion by typing DELETE.' });
    expect(f.auditValues).toEqual([]); expect(f.request).not.toHaveBeenCalled();
    await action({ action: 'lifecycle', ownerId: 'alice', operation: 'delete', confirmation: 'DELETE' });
    expect(f.noWork).toContain('alice');
  });

  it('rechecks active Codex work under the owner lock before deleting or removing admission', async () => {
    f.activeWork = true;
    await expect(action({ action: 'lifecycle', ownerId: 'alice', operation: 'delete', confirmation: 'DELETE' })).rejects.toMatchObject({ status: 409 });
    await expect(action({ action: 'enrollment', revision: 3, ownerId: 'alice', admitted: false })).rejects.toMatchObject({ status: 409 });
    expect(f.request).not.toHaveBeenCalled();
  });

  it('rechecks the owner under lock after the audit intent, catching a concurrent Codex reservation', async () => {
    f.activateWorkAfterIntent = true;
    await expect(action({ action: 'lifecycle', ownerId: 'alice', operation: 'delete', confirmation: 'DELETE' })).rejects.toMatchObject({ status: 409 });
    expect(f.auditValues[0]).toMatchObject({ details: { status: 'requested' } });
    expect(f.updateValues).toContainEqual({ details: { status: 'failed', request: { action: 'lifecycle', ownerId: 'alice', operation: 'delete' }, failure: 'conflict' } });
    expect(f.locked).toEqual(['alice', 'alice']); expect(f.request).not.toHaveBeenCalled();
  });

  it('records bounded high-level audit fields and never stores operator validation reference text', async () => {
    const privateReference = 'synthetic-private-ticket-value';
    await action({ action: 'validation', revision: 3, id: 'containment', result: 'passed', reference: privateReference });
    expect(f.auditValues).toHaveLength(1);
    expect(JSON.stringify(f.auditValues[0])).not.toContain(privateReference);
    expect(f.auditValues[0]).toMatchObject({ action: 'personal_codex.sbx.admin', details: { status: 'requested', request: { action: 'validation', referencePresent: true } } });
    expect(JSON.stringify(f.updateValues)).not.toContain(privateReference);
  });

  it('accepts and validates the current network observation contract', async () => {
    const network = { ownerId: 'alice', rules: [], observed: true, eventsObserved: false, note: 'No network events were observed.', events: [] };
    const { result } = await action({ action: 'network-read', ownerId: 'alice' }, { message: 'Network policy read.', network });
    expect(result.network).toEqual(network);
  });

  it.each([
    ['revision_conflict', 'SBX administration changed. Refresh and retry.'],
    ['admin_operation_failed', 'The SBX administration request could not be completed.'],
    ['template_not_approved', 'Approve this template before using it for a runtime.'],
    ['template_unavailable', 'The pinned template is unavailable in the host catalog.'],
    ['template_exists', 'This pinned template is already approved.'],
    ['template_in_use', 'This template is still used by a retained runtime.'],
    ['confirmation_required', 'Confirm sandbox deletion by typing DELETE.'],
    ['archive_not_found', 'Choose an archive from the current host inbox.'],
    ['template_not_found', 'This template is not in the approved catalog.'],
    ['network_rule_not_found', 'This network rule is no longer available.'],
  ])('maps broker code %s to preset text and ignores broker-provided error messages', async (code, message) => {
    f.request.mockImplementation(async (url: string) => url.endsWith('/admin/action')
      ? new Response(JSON.stringify({ code, error: 'synthetic host path/token' }), { status: 409 }) : ok(snapshot));
    await expect(performDockerSandboxAction({ action: 'diagnose' })).rejects.toMatchObject({ status: 409, message });
  });
});
