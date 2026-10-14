import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat, symlink, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrokerConfig, PersonalCodexDriver, runtimeKey } from '@/personal-codex/docker';
import { EnrollmentJournal, enrollmentReadiness } from '@/personal-codex/enrollment';
import { enrollmentRequest } from '@/personal-codex/contracts';
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function fixture(enabled = true) {
  const dir = await mkdtemp(join(tmpdir(), 'enrollment-')); dirs.push(dir);
  const config = BrokerConfig.parse({ socketPath: join(dir, 'broker.sock'), owners: [], namespace: 'cui-codex-test', image: `sha256:${'a'.repeat(64)}`, allowSelfEnrollment: enabled, siwcSandboxVerified: true });
  class Driver extends PersonalCodexDriver { calls = 0; fail = false; async preflight() { this.calls++; if (this.fail) throw new Error('private detail'); return 'not_started' as const; } }
  const driver = new Driver(config); return { driver, dir, journal: new EnrollmentJournal(driver), config };
}
describe('infrastructure enrollment', () => {
  it('defaults to operator enrollment and strictly validates consent', async () => {
    const { config } = await fixture();
    expect(BrokerConfig.parse({ ...config, allowSelfEnrollment: undefined }).allowSelfEnrollment).toBe(false);
    expect(enrollmentRequest.safeParse({ consentVersion: 1, sessionVersion: 0, owner: 'other' }).success).toBe(false);
    expect(enrollmentRequest.safeParse({ consentVersion: 1, sessionVersion: -1 }).success).toBe(false);
  });
  it('readiness never admits or writes and hides preflight failures', async () => {
    const { driver, journal, dir } = await fixture();
    expect(await enrollmentReadiness(driver, 'alice')).toEqual({ state: 'ready', selfEnrollment: true, enrolled: false, runtimeState: 'not_started' });
    expect(driver.admitted('alice')).toBe(false);
    await expect(stat(join(dir, `codex-enrollment-${runtimeKey('alice')}.json`))).rejects.toThrow();
    driver.fail = true; expect(JSON.stringify(await enrollmentReadiness(driver, 'alice'))).not.toContain('private detail');
    await journal.load(); expect(driver.admitted('alice')).toBe(false);
  });
  it('restores owner-specific admission bound to immutable installation, without credentials', async () => {
    const { driver, journal, config, dir } = await fixture();
    for (const owner of ['alice', 'bob']) await journal.record(owner, { consentVersion: 1, sessionVersion: 4 }, 'admitted');
    const file = join(dir, `codex-enrollment-${runtimeKey('alice')}.json`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, 'utf8')).not.toMatch(/token|fingerprint/);
    const restarted = new PersonalCodexDriver(config); await new EnrollmentJournal(restarted).load();
    expect(restarted.admitted('alice')).toBe(true); expect(restarted.admitted('bob')).toBe(true); expect(restarted.admitted('eve')).toBe(false);
    expect(() => restarted.name('eve')).toThrow();
    await expect(new EnrollmentJournal(new PersonalCodexDriver({ ...config, image: `sha256:${'b'.repeat(64)}` })).load()).rejects.toThrow();
    await expect(new EnrollmentJournal(new PersonalCodexDriver({ ...config, namespace: 'cui-codex-other' })).load()).rejects.toThrow();
    await journal.load(); await journal.rollback('alice'); expect(driver.admitted('alice')).toBe(false); expect(driver.admitted('bob')).toBe(true);
    const disabled = new PersonalCodexDriver({ ...config, allowSelfEnrollment: false }); await new EnrollmentJournal(disabled).load(); expect(disabled.admitted('bob')).toBe(false);
  });
  it('rejects symlink receipts and permissive permissions', async () => {
    const { journal, dir } = await fixture();
    const file = join(dir, `codex-enrollment-${runtimeKey('alice')}.json`);
    await symlink('/nonexistent', file); await expect(journal.record('alice', { consentVersion: 1, sessionVersion: 0 })).rejects.toThrow(); await expect(journal.load()).rejects.toThrow();
    await rm(file); await journal.record('alice', { consentVersion: 1, sessionVersion: 0 }); await chmod(file, 0o640); await expect(journal.load()).rejects.toThrow();
  });
});

it('failed cleanup fences current admission and pending receipt cannot restore it', async () => {
  const { driver, config, journal, dir } = await fixture();
  await journal.record('alice', { consentVersion: 1, sessionVersion: 8 }); driver.admit('alice');
  const failedCleanup = new EnrollmentJournal(driver, async () => { throw new Error('injected unlink failure'); });
  await expect(failedCleanup.rollback('alice')).rejects.toThrow();
  expect(driver.admitted('alice')).toBe(false); expect(() => driver.name('alice')).toThrow();
  expect(JSON.parse(await readFile(join(dir, `codex-enrollment-${runtimeKey('alice')}.json`), 'utf8')).admission).toBe('pending');
  const restarted = new PersonalCodexDriver(config); await new EnrollmentJournal(restarted).load();
  expect(restarted.admitted('alice')).toBe(false);
});
