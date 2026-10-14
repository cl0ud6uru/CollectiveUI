import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, chmod, lstat, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SbxPersonalCodexDriver } from '@/personal-codex/sbx';
import { SandboxAdminController } from '@/personal-codex/admin';

const TEMPLATE_A = `registry.example/team/codex@sha256:${'a'.repeat(64)}`;
const TEMPLATE_B = `registry.example/team/desktop@sha256:${'b'.repeat(64)}`;
const homes: string[] = [];
const tempHome = async () => {
  const path = await mkdtemp(join(tmpdir(), 'cui-admin-test-'));
  await chmod(path, 0o700);
  homes.push(path);
  return path;
};
afterEach(async () => { await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function fixture(options: { home: string; lifecycle?: (owner: string, operation: string) => Promise<void>; siwcSandboxVerified?: boolean }) {
  const inventory: { ownerId: string; state: 'running' | 'stopped' | 'missing' | 'unavailable'; cpus: number; memoryMb: number; template: string; activeSessions: number | null }[] =
    [{ ownerId: 'alice', state: 'missing', cpus: 2, memoryMb: 4096, template: TEMPLATE_A, activeSessions: null }];
  const networkRules: { effect: 'allow' | 'deny'; destination: string; cliRuleId: string }[] = [];
  const driver = {
    config: { sbxHome: options.home, owners: ['alice'], template: TEMPLATE_A, cpus: 2, memoryMb: 4096, namespace: 'cui-codex-test', adminEnabled: true,
      siwcSandboxVerified: options.siwcSandboxVerified ?? false },
    adminConfigure: vi.fn(async (input: { cpus: number; memoryMb: number; defaultTemplate: string; knownOwners: string[]; admittedOwners: string[]; maxRunning: number }) => { void input; }),
    adminHealth: vi.fn(async () => ({ version: 'v0.48.0', checks: [{ id: 'home', label: 'Protected runtime home', state: 'passed' as const, detail: '/secret/path and access-token' }] })),
    adminInventory: vi.fn(async () => inventory),
    adminTemplates: vi.fn(async (references: string[]) => references.map(reference => ({ reference, available: true }))),
    adminArchives: vi.fn(async () => [{ name: 'approved.tar', sizeBytes: 2048 }]),
    adminImportTemplate: vi.fn(async () => {}),
    adminNetworkRead: vi.fn(async () => ({ rules: networkRules, observed: true, note: 'private host path', events: [], eventsObserved: true })),
    adminNetworkAdd: vi.fn(async (_owner: string, effect: 'allow' | 'deny', destination: string) => {
      const cliRuleId = `cli-${networkRules.length + 1}`; networkRules.push({ effect, destination, cliRuleId }); return { cliRuleId };
    }),
    adminNetworkRemove: vi.fn(async (_owner: string, _effect: 'allow' | 'deny', _destination: string, cliRuleId: string) => {
      const index = networkRules.findIndex(rule => rule.cliRuleId === cliRuleId); if (index >= 0) networkRules.splice(index, 1);
    }),
    adminNetworkCheck: vi.fn(async () => ({ decision: 'unknown' as const, detail: '/host/private/path' })),
    adminDiagnose: vi.fn(async () => [{ id: 'host', label: 'Host', state: 'passed' as const, detail: 'secret credential path' }]),
  };
  const hooks = {
    runtimeState: vi.fn(async () => ({ credentialState: 'operator_unverified' as const,
      computer: { available: false, paused: false, control: 'unavailable' as const, lastFrameAt: null } })),
    lifecycle: vi.fn(options.lifecycle ?? (async () => {})),
  };
  return { driver, hooks, inventory, networkRules,
    controller: new SandboxAdminController(driver as unknown as SbxPersonalCodexDriver, hooks) };
}

describe('SBX sandbox admin controller', () => {
  it('seeds and stores private versioned state, then snapshots redacted runtime checks', async () => {
    const home = await tempHome();
    const { controller, driver } = fixture({ home });
    await controller.initialize();
    const statePath = join(home, 'collectiveui-admin.json');
    const file = await lstat(statePath);
    expect(file.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({ version: 1, revision: 0,
      settings: { cpus: 2, memoryMb: 4096, maxRunning: 1, defaultTemplate: TEMPLATE_A }, knownOwners: ['alice'], admittedOwners: ['alice'] });
    expect(driver.adminConfigure).toHaveBeenCalledWith({ cpus: 2, memoryMb: 4096, maxRunning: 1, defaultTemplate: TEMPLATE_A,
      knownOwners: ['alice'], admittedOwners: ['alice'] });
    const snapshot = await controller.snapshot();
    expect(snapshot.available).toBe(true);
    expect(snapshot.runtimes[0]).toMatchObject({ ownerId: 'alice', admitted: true, state: 'missing', credentialState: 'operator_unverified', computer: { available: false } });
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|access-token|\/host|\/private/);
    expect(snapshot.siwcSandboxVerified).toBe(false);
  });

  it('revokes admission before stopping and keeps revocation if stop fails so it can be retried', async () => {
    const home = await tempHome();
    let stopFails = true;
    let configuredAdmission: string[] = ['alice'];
    const driverRef: { current?: ReturnType<typeof fixture>['driver'] } = {};
    const setup = fixture({ home, lifecycle: async (_owner, operation) => {
      if (operation === 'stop') {
        configuredAdmission = driverRef.current?.adminConfigure.mock.calls.at(-1)?.[0].admittedOwners ?? [];
        if (stopFails) throw new Error('secret host failure');
      }
    } });
    driverRef.current = setup.driver;
    const { controller, hooks, driver } = setup;
    await controller.initialize();
    await expect(controller.act({ action: 'enrollment', revision: 2, ownerId: 'alice', admitted: false }, 'root'))
      .rejects.toMatchObject({ status: 409, code: 'revision_conflict' });
    await expect(controller.act({ action: 'enrollment', revision: 0, ownerId: 'alice', admitted: false }, 'root'))
      .rejects.toMatchObject({ status: 503, code: 'mutation_failed' });
    expect(driver.adminConfigure).toHaveBeenLastCalledWith(expect.objectContaining({ admittedOwners: [] }));
    expect(configuredAdmission).toEqual([]);
    expect((await controller.snapshot()).settings.admittedOwners).toEqual([]);
    stopFails = false;
    await controller.act({ action: 'enrollment', revision: 1, ownerId: 'alice', admitted: false }, 'root');
    expect(hooks.lifecycle).toHaveBeenCalledWith('alice', 'stop');
    expect((await controller.snapshot()).settings.admittedOwners).toEqual([]);
    expect(JSON.parse(await readFile(join(home, 'collectiveui-admin.json'), 'utf8'))).toMatchObject({ revision: 1, knownOwners: ['alice'], admittedOwners: [] });
  });

  it('admits valid new database-backed owners and permits stop/delete after revocation', async () => {
    const home = await tempHome();
    const { controller, hooks, driver } = fixture({ home });
    await controller.initialize();
    await controller.act({ action: 'enrollment', revision: 0, ownerId: 'new-user_2', admitted: true }, 'root');
    expect(JSON.parse(await readFile(join(home, 'collectiveui-admin.json'), 'utf8'))).toMatchObject({
      knownOwners: ['alice', 'new-user_2'], admittedOwners: ['alice', 'new-user_2'],
    });
    expect(driver.adminConfigure).toHaveBeenLastCalledWith(expect.objectContaining({ knownOwners: ['alice', 'new-user_2'] }));
    await controller.act({ action: 'enrollment', revision: 1, ownerId: 'new-user_2', admitted: false }, 'root');
    await controller.act({ action: 'lifecycle', ownerId: 'new-user_2', operation: 'stop' }, 'root');
    const deleted = await controller.act({ action: 'lifecycle', ownerId: 'new-user_2', operation: 'delete', confirmation: 'DELETE' }, 'root');
    expect(hooks.lifecycle).toHaveBeenCalledWith('new-user_2', 'stop');
    expect(hooks.lifecycle).toHaveBeenCalledWith('new-user_2', 'delete');
    expect(deleted.message).toContain('Guest files were removed');
    expect(JSON.parse(await readFile(join(home, 'collectiveui-admin.json'), 'utf8')).knownOwners).toContain('new-user_2');
  });

  it('allows known unenrolled owners to inspect policy and remove their managed rules', async () => {
    const home = await tempHome();
    const { controller } = fixture({ home });
    await controller.initialize();
    const added = await controller.act({ action: 'network-add', ownerId: 'alice', effect: 'deny', destination: 'blocked.example' }, 'root');
    const ruleId = added.network!.rules[0].id;
    await controller.act({ action: 'enrollment', revision: 1, ownerId: 'alice', admitted: false }, 'root');
    expect(await controller.act({ action: 'network-read', ownerId: 'alice' }, 'root')).toMatchObject({ network: { ownerId: 'alice' } });
    expect(await controller.act({ action: 'network-check', ownerId: 'alice', destination: 'blocked.example' }, 'root'))
      .toMatchObject({ networkCheck: { destination: 'blocked.example' } });
    await controller.act({ action: 'network-remove', ownerId: 'alice', ruleId }, 'root');
  });

  it('clears owner-scoped managed network handles only after sandbox deletion succeeds', async () => {
    const home = await tempHome();
    let deleteFails = true;
    const { controller } = fixture({ home, lifecycle: async (_owner, operation) => {
      if (operation === 'delete' && deleteFails) throw new Error('private runtime failure');
    } });
    await controller.initialize();
    await controller.act({ action: 'network-add', ownerId: 'alice', effect: 'deny', destination: 'removed.example' }, 'root');
    await expect(controller.act({ action: 'lifecycle', ownerId: 'alice', operation: 'delete', confirmation: 'DELETE' }, 'root'))
      .rejects.toMatchObject({ code: 'mutation_failed' });
    expect(JSON.parse(await readFile(join(home, 'collectiveui-admin.json'), 'utf8')).networkRules).toHaveLength(1);
    deleteFails = false;
    await controller.act({ action: 'lifecycle', ownerId: 'alice', operation: 'delete', confirmation: 'DELETE' }, 'root');
    const persisted = JSON.parse(await readFile(join(home, 'collectiveui-admin.json'), 'utf8'));
    expect(persisted.networkRules).toEqual([]);
    expect(persisted.revision).toBe(2);
  });

  it('does not persist settings when driver configuration fails', async () => {
    const home = await tempHome();
    const { controller, driver } = fixture({ home });
    await controller.initialize();
    driver.adminConfigure.mockRejectedValueOnce(new Error('credential path must not escape'));
    await expect(controller.act({ action: 'settings', revision: 0, cpus: 4, memoryMb: 8192, maxRunning: 2, defaultTemplate: TEMPLATE_A }, 'root'))
      .rejects.toMatchObject({ status: 503, code: 'mutation_failed' });
    expect(JSON.parse(await readFile(join(home, 'collectiveui-admin.json'), 'utf8')).revision).toBe(0);
  });

  it('approves only available digest templates, prevents default/in-use removal, and resets attestations on default change', async () => {
    const home = await tempHome();
    const { controller, inventory } = fixture({ home, siwcSandboxVerified: true });
    await controller.initialize();
    inventory[0].state = 'stopped';
    await controller.act({ action: 'validation', revision: 0, id: 'desktop', result: 'passed', reference: 'desktop-proof-1' }, 'root');
    await expect(controller.act({ action: 'template-add', revision: 1, reference: TEMPLATE_B, label: 'Desktop B' }, 'root')).resolves.toBeTruthy();
    await expect(controller.act({ action: 'template-remove', revision: 2, reference: TEMPLATE_A }, 'root'))
      .rejects.toMatchObject({ status: 409 });
    await controller.act({ action: 'settings', revision: 2, cpus: 2, memoryMb: 4096, maxRunning: 1, defaultTemplate: TEMPLATE_B }, 'root');
    const snapshot = await controller.snapshot();
    expect(snapshot.settings.defaultTemplate).toBe(TEMPLATE_B);
    expect(snapshot.siwcSandboxVerified).toBe(false);
    expect(snapshot.validation.find(item => item.id === 'desktop')).toMatchObject({ result: 'pending', template: TEMPLATE_B, checkedBy: null });
    inventory[0].template = TEMPLATE_B;
    await expect(controller.act({ action: 'template-remove', revision: 3, reference: TEMPLATE_A }, 'root'))
      .resolves.toMatchObject({ message: 'Template removed from the approved catalog.' });
  });

  it('uses only app-managed UUID handles for network edits and rejects injection', async () => {
    const home = await tempHome();
    const { controller, driver } = fixture({ home });
    await controller.initialize();
    await expect(controller.act({ action: 'network-add', ownerId: 'alice', effect: 'allow', destination: 'example.com; cat /etc/passwd' }, 'root'))
      .rejects.toMatchObject({ status: 400, code: 'invalid_action' });
    expect(driver.adminNetworkAdd).not.toHaveBeenCalled();
    const result = await controller.act({ action: 'network-add', ownerId: 'alice', effect: 'allow', destination: 'example.com:443' }, 'root');
    expect(JSON.stringify(result)).not.toContain('cli-1');
    expect(result.network?.rules).toHaveLength(1);
    const ruleId = result.network!.rules[0].id;
    expect(ruleId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await controller.act({ action: 'network-remove', ownerId: 'alice', ruleId }, 'root')).toMatchObject({ message: 'Network rule removed.' });
    expect(driver.adminNetworkRemove).toHaveBeenCalledWith('alice', 'allow', 'example.com:443', 'cli-1');
  });

  it('does not report stale managed rules as applied and distinguishes unavailable event logs', async () => {
    const home = await tempHome();
    const { controller, driver, networkRules } = fixture({ home });
    await controller.initialize();
    const added = await controller.act({ action: 'network-add', ownerId: 'alice', effect: 'deny', destination: 'stale.example' }, 'root');
    const ruleId = added.network!.rules[0].id;
    networkRules[0].destination = 'changed.example';
    driver.adminNetworkRead.mockResolvedValue({ rules: networkRules, observed: true, note: 'untrusted', events: [], eventsObserved: false });
    const result = await controller.act({ action: 'network-read', ownerId: 'alice' }, 'root');
    expect(result.network?.rules).toEqual([]);
    expect(result.network?.note).toContain('no longer match');
    expect(result.network?.eventsObserved).toBe(false);
    expect(result.network?.events).toEqual([]);
    expect(result.network?.rules.some(rule => rule.id === ruleId)).toBe(false);
  });

  it('leaves ambiguous matching network rules untouched during pending-operation recovery', async () => {
    const home = await tempHome();
    const { controller, driver, networkRules } = fixture({ home });
    await controller.initialize();
    networkRules.push({ effect: 'deny', destination: 'example.net:443', cliRuleId: 'existing-cli-rule' });
    driver.adminNetworkAdd.mockImplementationOnce(async (_owner, effect, destination) => {
      networkRules.push({ effect, destination, cliRuleId: 'cli-uncertain' });
      throw new Error('CLI disconnected after apply');
    });
    await expect(controller.act({ action: 'network-add', ownerId: 'alice', effect: 'deny', destination: 'example.net:443' }, 'root'))
      .rejects.toMatchObject({ status: 503, code: 'mutation_failed' });
    expect(JSON.parse(await readFile(join(home, 'collectiveui-admin.json'), 'utf8')).pending).toMatchObject({ kind: 'network-add', destination: 'example.net:443' });
    const blocked = await controller.snapshot();
    expect(blocked.available).toBe(false);
    expect(networkRules).toEqual([
      { effect: 'deny', destination: 'example.net:443', cliRuleId: 'existing-cli-rule' },
      { effect: 'deny', destination: 'example.net:443', cliRuleId: 'cli-uncertain' },
    ]);
    expect(driver.adminNetworkRemove).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(home, 'collectiveui-admin.json'), 'utf8')).pending)
      .toMatchObject({ kind: 'network-add', destination: 'example.net:443' });
  });

  it('imports only names from the fixed inbox and reports no false live-auth validation', async () => {
    const home = await tempHome();
    const { controller, driver } = fixture({ home });
    await controller.initialize();
    await expect(controller.act({ action: 'template-import', revision: 0, archive: '../outside.tar', reference: TEMPLATE_B }, 'root'))
      .rejects.toMatchObject({ status: 400 });
    expect(driver.adminImportTemplate).not.toHaveBeenCalled();
    await controller.act({ action: 'template-import', revision: 0, archive: 'approved.tar', reference: TEMPLATE_B }, 'root');
    expect(driver.adminImportTemplate).toHaveBeenCalledWith('approved.tar', TEMPLATE_B);
    const validation = await controller.act({ action: 'validation', revision: 1, id: 'inference', result: 'passed', reference: 'manual-result' }, 'root');
    expect(validation.message).toContain('attestation');
    expect((await controller.snapshot()).siwcSandboxVerified).toBe(false);
  });

  it('keeps the SIWC verification flag tied to immutable operator config, not manual attestations', async () => {
    const home = await tempHome();
    const { controller } = fixture({ home, siwcSandboxVerified: true });
    await controller.initialize();
    await controller.act({ action: 'validation', revision: 0, id: 'inference', result: 'passed', reference: 'operator-note' }, 'root');
    expect((await controller.snapshot()).siwcSandboxVerified).toBe(true);
  });

  it('fails closed on insecure, symlinked, or invalid state files', async () => {
    const home = await tempHome();
    const { controller } = fixture({ home });
    await controller.initialize();
    await chmod(join(home, 'collectiveui-admin.json'), 0o644);
    await expect(controller.snapshot()).resolves.toMatchObject({ available: false, reason: expect.any(String) });
    const secondHome = await tempHome();
    const second = fixture({ home: secondHome });
    await second.controller.initialize();
    await rm(join(secondHome, 'collectiveui-admin.json'));
    await symlink('/etc/passwd', join(secondHome, 'collectiveui-admin.json'));
    await expect(second.controller.snapshot()).resolves.toMatchObject({ available: false });
  });
});
