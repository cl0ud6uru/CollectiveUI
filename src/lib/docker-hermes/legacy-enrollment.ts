import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { auditLog, dockerHermesEnrollments, users } from '@/db/schema';
import type { Principal } from '@/lib/auth/groups';
import { ownerId } from '@/docker-hermes/types';
import { HttpError } from '@/lib/authz';
import { freshEnrollmentAdmin, lockDockerOwner } from './enrollment';
/** Only the explicit operator command reads the retired allowlist. No normal request imports it. */
export function legacyEnrollmentIds(raw: string) {
  const ids = [...new Set(raw.split(/[\s,;]+/).filter(Boolean))];
  return { ids: ids.filter(id => ownerId.safeParse(id).success), invalid: ids.filter(id => !ownerId.safeParse(id).success).map(legacyFingerprint) };
}
export function legacyFingerprint(id: string) { return createHash('sha256').update(id).digest('hex').slice(0, 12); }
export async function importLegacyEnrollment(p: Principal, raw: string, apply: boolean) {
  const parsed = legacyEnrollmentIds(raw);
  return db.transaction(async tx => {
    await freshEnrollmentAdmin(p, tx);
    const missing: string[] = [], disabled: string[] = [], existing: string[] = [], eligible: string[] = [];
    // Stable lock order keeps two simultaneous imports from deadlocking.
    for (const id of [...parsed.ids].sort()) {
      await lockDockerOwner(tx, id);
      const [user] = await tx.select({ disabled: users.disabled }).from(users).where(eq(users.id, id)).for('share');
      if (!user) { missing.push(legacyFingerprint(id)); continue; }
      const [row] = await tx.select().from(dockerHermesEnrollments).where(eq(dockerHermesEnrollments.userId, id));
      if (row) existing.push(legacyFingerprint(id));
      else if (user.disabled) disabled.push(legacyFingerprint(id));
      else eligible.push(id);
    }
    if (apply && (parsed.invalid.length || missing.length || disabled.length)) throw new HttpError(400, 'Legacy import refused: preview and correct invalid, unknown or disabled user IDs first. No permissions changed.');
    if (apply) for (const id of eligible) {
      await tx.insert(dockerHermesEnrollments).values({ userId: id, enabled: true, changedBy: p.user.id });
      await tx.insert(auditLog).values({ actorId: p.user.id, action: 'hermes.docker.enroll', target: id, details: { enabled: true, source: 'explicit-legacy-import' } });
    }
    return { applied: apply, eligible: eligible.length, existingUnchanged: existing, invalid: parsed.invalid, unknown: missing, disabled };
  });
}
