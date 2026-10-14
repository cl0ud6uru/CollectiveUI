import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ComputerController, COMPUTER_LEASE_MS } from '@/personal-codex/computer';
import type { PersonalCodexRuntimeDriver } from '@/personal-codex/driver';

const session = 'a'.repeat(64), other = 'b'.repeat(64);
let dir: string, now: number, driver: PersonalCodexRuntimeDriver, controller: ComputerController;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'computer-control-'));
  now = Date.now();
  driver = {
    config: { socketPath: join(dir, 'broker.sock'), owners: ['alice', 'bob'] },
    name: vi.fn(owner => { if (!['alice', 'bob'].includes(owner)) throw Error('Denied'); return owner; }),
    inspect: vi.fn(), ensure: vi.fn(), startRetained: vi.fn(), bridge: vi.fn(),
    synchronizeToken: vi.fn(), clearToken: vi.fn(),
    computerStatus: vi.fn(async () => ({ available: true, running: true, width: 1280 as const, height: 800 as const })),
    computerPause: vi.fn(async () => {}), computerInput: vi.fn(async () => {}),
    computerFrame: vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
  };
  controller = new ComputerController(driver, () => now);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('computer broker ownership and takeover', () => {
  it('admin metadata reports human control without exposing a viewer session or frame', async () => {
    await controller.control('alice', session, { action: 'takeover' });
    const metadata = await controller.adminStatus('alice');
    expect(metadata).toEqual({ available: true, paused: true, control: 'human', lastFrameAt: null });
    expect(JSON.stringify(metadata)).not.toContain(session);
    expect(driver.computerFrame).not.toHaveBeenCalled();
    now += COMPUTER_LEASE_MS + 1;
    expect((await controller.adminStatus('alice')).control).toBe('paused');
  });
  it('administrative stop revokes human input and clears the pause only after confirmed stop', async () => {
    await controller.control('alice', session, { action: 'takeover' });
    let finish!: () => void;
    const work = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    vi.mocked(driver.inspect).mockResolvedValue({ State: { Running: false } });
    const stop = controller.stopRuntime('alice', work);
    await vi.waitFor(() => expect(work).toHaveBeenCalledOnce());
    const input = controller.input('alice', session, { kind: 'key', key: 'Enter' });
    finish();
    await stop;
    await expect(input).rejects.toThrow('Take over');
    expect(driver.computerInput).not.toHaveBeenCalled();
    expect(driver.computerPause).toHaveBeenCalledExactlyOnceWith('alice', true);
    await expect(new ComputerController(driver).assertAgentControl('alice')).resolves.toBeUndefined();
  });
  it('an unconfirmed administrative stop reapplies suspension and retains the durable fence', async () => {
    vi.mocked(driver.inspect).mockResolvedValue({ State: { Running: true } });
    await expect(controller.stopRuntime('alice', async () => {})).rejects.toThrow('could not be stopped');
    expect(driver.computerPause).toHaveBeenCalledExactlyOnceWith('alice', true);
    await expect(new ComputerController(driver).assertAgentControl('alice')).rejects.toThrow('Return computer control');
  });
  it('reapplies a persisted pause before admitting runtime access after a broker crash', async () => {
    const record = join(dir, `computer-${createHash('sha256').update('alice').digest('hex')}.json`);
    await writeFile(record, JSON.stringify({ version: 1, paused: true }), { mode: 0o600 });
    vi.mocked(driver.inspect).mockResolvedValue({ State: { Running: true } });
    controller = new ComputerController(driver, () => now);

    await controller.reconcilePersistedPauses(['alice', 'bob']);
    expect(driver.computerPause).toHaveBeenCalledExactlyOnceWith('alice', true);
    expect(await controller.status('alice', session)).toMatchObject({ paused: true, control: 'other' });
    await expect(controller.agentBridge('alice')).rejects.toThrow('Return computer control');
    expect(JSON.parse(await readFile(record, 'utf8'))).toEqual({ version: 1, paused: true });
  });
  it('does not grant human control when durable pause persistence fails', async () => {
    const record = join(dir, `computer-${createHash('sha256').update('alice').digest('hex')}.json`);
    await controller.status('alice', session);
    // A directory at the record path makes the atomic rename fail after the temporary record is synced.
    await mkdir(record);

    await expect(controller.control('alice', session, { action: 'takeover' })).rejects.toThrow();
    expect(driver.computerPause).not.toHaveBeenCalled();
    expect(await controller.status('alice', session)).toMatchObject({ paused: true, control: 'other' });
    await expect(controller.input('alice', session, { kind: 'key', key: 'Enter' })).rejects.toThrow();
  });
  it('stops and verifies a running runtime if persisted pause recovery fails, retaining the fence', async () => {
    const record = join(dir, `computer-${createHash('sha256').update('alice').digest('hex')}.json`);
    await writeFile(record, JSON.stringify({ version: 1, paused: true }), { mode: 0o600 });
    vi.mocked(driver.inspect).mockResolvedValueOnce({ State: { Running: true } }).mockResolvedValueOnce({ State: { Running: false } });
    vi.mocked(driver.computerPause).mockRejectedValueOnce(new Error('pause failed'));
    driver.stop = vi.fn(async () => {});
    controller = new ComputerController(driver, () => now);

    await controller.reconcilePersistedPauses(['alice']);
    expect(driver.stop).toHaveBeenCalledWith('alice');
    expect(driver.inspect).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(record, 'utf8'))).toEqual({ version: 1, paused: true });
    await expect(controller.agentBridge('alice')).rejects.toThrow('Return computer control');
  });
  it('does no runtime inspection for configured owners without a pause record', async () => {
    await controller.reconcilePersistedPauses(['alice', 'bob']);
    expect(driver.inspect).not.toHaveBeenCalled();
    expect(driver.computerPause).not.toHaveBeenCalled();
  });
  it('viewing never provisions, starts or resumes a computer', async () => {
    expect((await controller.status('alice', session)).control).toBe('agent');
    await controller.frame('alice', session);
    expect(driver.ensure).not.toHaveBeenCalled(); expect(driver.startRetained).not.toHaveBeenCalled();
    expect(driver.computerPause).not.toHaveBeenCalled(); expect(driver.bridge).not.toHaveBeenCalled();
  });
  it('denies unknown owners and malformed view sessions before reaching the driver', async () => {
    await expect(controller.status('mallory', session)).rejects.toThrow();
    await expect(controller.frame('alice', 'spoof')).rejects.toThrow();
    expect(driver.computerStatus).not.toHaveBeenCalled(); expect(driver.computerFrame).not.toHaveBeenCalled();
  });
  it('suspends the agent before granting an exclusive owner/session input lease', async () => {
    await expect(controller.input('alice', session, { kind: 'type', text: 'private input' })).rejects.toThrow();
    const status = await controller.control('alice', session, { action: 'takeover' });
    expect(status).toMatchObject({ paused: true, control: 'you' });
    expect(driver.computerPause).toHaveBeenCalledWith('alice', true);
    await expect(controller.assertAgentControl('alice')).rejects.toThrow();
    await expect(controller.control('alice', other, { action: 'takeover' })).rejects.toThrow();
    await expect(controller.input('alice', other, { kind: 'click', x: 1, y: 1 })).rejects.toThrow();
    await controller.input('alice', session, { kind: 'type', text: 'private input' });
    expect(driver.computerInput).toHaveBeenCalledExactlyOnceWith('alice', { kind: 'type', text: 'private input' });
    expect((await controller.status('bob', other)).control).toBe('agent');
    const state = await readFile(join(dir, `computer-${createHash('sha256').update('alice').digest('hex')}.json`), 'utf8');
    expect(state).not.toContain('private input'); expect(state).not.toContain(session);
  });
  it('expires input without resuming automation and recovers paused state after broker restart', async () => {
    await controller.control('alice', session, { action: 'takeover' });
    now += COMPUTER_LEASE_MS + 1;
    await expect(controller.input('alice', session, { kind: 'key', key: 'Enter' })).rejects.toThrow();
    expect((await controller.status('alice', session))).toMatchObject({ control: 'other', paused: true });
    expect(driver.computerPause).toHaveBeenCalledTimes(1);
    controller = new ComputerController(driver, () => now);
    await expect(controller.assertAgentControl('alice')).rejects.toThrow();
    await controller.control('alice', other, { action: 'takeover' });
    await controller.control('alice', other, { action: 'release' });
    expect(driver.computerPause).toHaveBeenLastCalledWith('alice', false);
    await expect(controller.assertAgentControl('alice')).resolves.toBeUndefined();
  });
  it('extends only the holder lease and rejects hidden input fields and out-of-range coordinates', async () => {
    await controller.control('alice', session, { action: 'takeover' });
    now += 20_000;
    await expect(controller.control('alice', other, { action: 'heartbeat' })).rejects.toThrow();
    await controller.control('alice', session, { action: 'heartbeat' });
    now += 20_000;
    expect((await controller.status('alice', session)).control).toBe('you');
    for (const value of [{ kind: 'click', x: 1280, y: 0 }, { kind: 'type', text: 'ok', command: 'bad' }, { kind: 'key', key: 'Alt+F2' }, { kind: 'scroll', direction: 'up', amount: 11 }])
      await expect(controller.input('alice', session, value)).rejects.toThrow();
    expect(driver.computerInput).not.toHaveBeenCalled();
  });
  it('failed suspension never grants human input or new app-server bridges', async () => {
    vi.mocked(driver.computerPause).mockRejectedValueOnce(new Error('native output must not escape'));
    await expect(controller.control('alice', session, { action: 'takeover' })).rejects.toThrow();
    await expect(controller.input('alice', session, { kind: 'key', key: 'Enter' })).rejects.toThrow();
    await expect(controller.assertAgentControl('alice')).rejects.toThrow();
    expect((await controller.status('alice', session)).control).toBe('other');
  });
  it('rejects corrupt/oversized frames and never stores frame pixels on disk', async () => {
    vi.mocked(driver.computerFrame).mockResolvedValueOnce(Buffer.from('not a JPEG'));
    await expect(controller.frame('alice', session)).rejects.toThrow();
    vi.mocked(driver.computerFrame).mockResolvedValueOnce(Buffer.alloc(512 * 1024 + 1));
    await expect(controller.frame('alice', session)).rejects.toThrow();
  });
  it('refuses a symlink control record rather than following or overwriting it', async () => {
    await symlink('/dev/null', join(dir, `computer-${createHash('sha256').update('alice').digest('hex')}.json`));
    await expect(controller.status('alice', session)).rejects.toThrow('reconciliation');
    expect(driver.computerStatus).not.toHaveBeenCalled();
  });
  it('shares an in-flight capture across the two allowed viewers', async () => {
    let complete!: (bytes: Buffer) => void;
    vi.mocked(driver.computerFrame).mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const first = controller.frame('alice', session);
    await vi.waitFor(() => expect(driver.computerFrame).toHaveBeenCalledTimes(1));
    const second = controller.frame('alice', other);
    await new Promise(resolve => setTimeout(resolve, 10));
    complete(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    expect(await first).toEqual(await second);
    expect(driver.computerFrame).toHaveBeenCalledTimes(1);
  });
  it('serializes takeover with app-server bridge admission', async () => {
    let complete!: () => void;
    vi.mocked(driver.bridge).mockImplementation(() => new Promise(resolve => { complete = () => resolve({} as never); }));
    const bridge = controller.agentBridge('alice');
    await vi.waitFor(() => expect(driver.bridge).toHaveBeenCalledTimes(1));
    const takeover = controller.control('alice', session, { action: 'takeover' });
    expect(driver.computerPause).not.toHaveBeenCalled();
    complete(); await bridge; await takeover;
    await expect(controller.agentBridge('alice')).rejects.toThrow();
    expect(driver.bridge).toHaveBeenCalledTimes(1);
  });
  it('fences agent computer tools during human takeover', async () => {
    await controller.agentInput('alice', { kind: 'click', x: 42, y: 24 });
    await controller.agentFrame('alice');
    await controller.control('alice', session, { action: 'takeover' });
    await expect(controller.agentInput('alice', { kind: 'click', x: 0, y: 0 })).rejects.toThrow('user');
    await expect(controller.agentFrame('alice')).rejects.toThrow('user');
    expect(driver.computerInput).toHaveBeenCalledTimes(1);
    expect(driver.computerFrame).toHaveBeenCalledTimes(1);
  });
  it('rejects takeover during an account operation without deadlocking nested bridges', async () => {
    let finish!: () => void;
    const operation = controller.agentOperation('alice', async () => {
      await controller.agentBridge('alice');
      await new Promise<void>(resolve => { finish = resolve; });
    });
    await vi.waitFor(() => expect(driver.bridge).toHaveBeenCalledTimes(1));
    await expect(controller.control('alice', session, { action: 'takeover' })).rejects.toThrow('account operation');
    finish(); await operation;
    await controller.control('alice', session, { action: 'takeover' });
    await expect(controller.agentOperation('alice', async () => {})).rejects.toThrow('Return');
  });
  it('stops a paused runtime for revocation without resuming automation', async () => {
    await controller.control('alice', session, { action: 'takeover' });
    driver.stop = vi.fn(async () => {});
    vi.mocked(driver.inspect).mockResolvedValue({ State: { Running: false } });
    const revoke = vi.fn(async () => {});
    await controller.agentOperation('alice', revoke, { revokePaused: true });
    expect(driver.stop).toHaveBeenCalledWith('alice');
    expect(revoke).toHaveBeenCalledOnce();
    expect(driver.computerPause).toHaveBeenCalledExactlyOnceWith('alice', true);
    await expect(controller.input('alice', session, { kind: 'key', key: 'Enter' })).rejects.toThrow();
    controller = new ComputerController(driver, () => now);
    await expect(controller.assertAgentControl('alice')).resolves.toBeUndefined();
  });
  it('keeps the fence closed if a paused runtime cannot be stopped for revocation', async () => {
    await controller.control('alice', session, { action: 'takeover' });
    driver.stop = vi.fn(async () => {});
    vi.mocked(driver.inspect).mockResolvedValue({ State: { Running: true } });
    const revoke = vi.fn(async () => {});
    await expect(controller.agentOperation('alice', revoke, { revokePaused: true })).rejects.toThrow('could not be stopped');
    expect(revoke).not.toHaveBeenCalled();
    await expect(controller.agentBridge('alice')).rejects.toThrow('Return');
    await expect(controller.input('alice', session, { kind: 'key', key: 'Enter' })).rejects.toThrow();
  });
});
