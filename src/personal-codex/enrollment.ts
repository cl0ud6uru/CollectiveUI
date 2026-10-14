import { constants } from 'node:fs';
import { lstat, open, rename, unlink, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ownerId, enrollmentRequest, type EnrollmentReadiness } from './contracts';
import { runtimeKey, type PersonalCodexDriver } from './docker';

const receipt = enrollmentRequest.extend({ version: z.literal(1), admission: z.enum(['pending', 'admitted']), owner: ownerId, namespace: z.string(), image: z.string() }).strict();
/** Infrastructure consent only. Never contains or restores token readiness. */
export class EnrollmentJournal {
  constructor(private readonly driver: PersonalCodexDriver, private readonly removeReceipt: typeof unlink = unlink) {}
  private path(owner: string) { return join(dirname(this.driver.config.socketPath), `codex-enrollment-${runtimeKey(owner)}.json`); }
  private async parent() {
    const s = await lstat(dirname(this.driver.config.socketPath));
    if (!s.isDirectory() || s.isSymbolicLink() || s.mode & 0o027) throw new Error('Protected enrollment directory required');
  }
  async load() {
    await this.parent();
    for (const file of await readdir(dirname(this.driver.config.socketPath))) {
      if (!/^codex-enrollment-[a-f0-9]{64}\.json$/.test(file)) continue;
      const path = join(dirname(this.driver.config.socketPath), file);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const s = await handle.stat();
        if (!s.isFile() || (s.mode & 0o777) !== 0o600 || s.nlink !== 1 || s.size > 4096 || s.uid !== process.getuid?.()) throw new Error('Invalid receipt');
        const r = receipt.parse(JSON.parse(await handle.readFile('utf8')));
        if (this.path(r.owner) !== path || r.namespace !== this.driver.config.namespace || r.image !== this.driver.config.image) throw new Error('Enrollment installation changed');
        if (this.driver.config.allowSelfEnrollment && r.admission === 'admitted') this.driver.admit(r.owner);
      } finally { await handle.close(); }
    }
  }
  async record(owner: string, consent: z.infer<typeof enrollmentRequest>, admission: 'pending' | 'admitted' = 'pending') {
    await this.parent();
    const target = this.path(owner);
    const existing = await lstat(target).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (existing && (!existing.isFile() || (existing.mode & 0o777) !== 0o600 || existing.nlink !== 1 || existing.uid !== process.getuid?.())) throw new Error('Invalid receipt');
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(JSON.stringify({ ...enrollmentRequest.parse(consent), version: 1, admission, owner: ownerId.parse(owner), namespace: this.driver.config.namespace, image: this.driver.config.image }));
      await handle.sync(); await handle.close(); await rename(temporary, target);
      const directory = await open(dirname(target), constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
    } finally { await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
  }
  async rollback(owner: string) {
    // The pending receipt is a durable denial even if cleanup cannot unlink it.
    this.driver.revokeAdmission(owner);
    await this.removeReceipt(this.path(owner));
  }
}
export async function enrollmentReadiness(driver: PersonalCodexDriver, owner: string): Promise<EnrollmentReadiness> {
  ownerId.parse(owner);
  const base = { selfEnrollment: driver.config.allowSelfEnrollment, enrolled: driver.admitted(owner) };
  if (!base.enrolled && !base.selfEnrollment) return { ...base, state: 'operator_setup_required', reason: 'An operator must enable enrollment for this installation.' };
  if (!driver.config.siwcSandboxVerified) return { ...base, state: 'verification_required', reason: 'An operator must verify the stock sandbox before enrollment.' };
  try { const runtimeState = await driver.preflight(owner); return { ...base, state: 'ready', runtimeState }; }
  catch { return { ...base, state: 'unavailable', reason: 'Installed runtime resources require operator reconciliation.' }; }
}
