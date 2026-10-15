import { sql, and, eq, inArray } from 'drizzle-orm';
import { pgTable, text, jsonb, timestamp, uniqueIndex, check } from 'drizzle-orm/pg-core';
import type { DbOrTx } from '@/db';
import type { RecoveryBinding } from '@/lib/remote-hermes/recovery-contract';
import type { NativeDrainReceipt } from '@/lib/remote-hermes/recovery-protocol';
import { users, remoteHermesConnections, remoteHermesSessions } from './schema';

export const remoteHermesRecoveries = pgTable('remote_hermes_recoveries', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  connectionId: text('connection_id').notNull().references(() => remoteHermesConnections.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull().references(() => remoteHermesSessions.id, { onDelete: 'cascade' }),
  binding: jsonb('binding').$type<RecoveryBinding>().notNull(),
  state: text('state').$type<'prepared' | 'pending' | 'uncertain' | 'applied' | 'superseded'>().notNull(),
  receipt: jsonb('receipt').$type<NativeDrainReceipt>(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('remote_hermes_recovery_active_idx').on(t.sessionId).where(sql`${t.state} in ('prepared','pending','uncertain')`),
  check('remote_hermes_recovery_state_check', sql`${t.state} in ('prepared','pending','uncertain','applied','superseded')`),
  check('remote_hermes_recovery_binding_bound', sql`jsonb_typeof(${t.binding}) = 'object' and octet_length(${t.binding}::text) <= 16000`),
  check('remote_hermes_recovery_receipt_bound', sql`${t.receipt} is null or (jsonb_typeof(${t.receipt}) = 'object' and octet_length(${t.receipt}::text) <= 24000)`),
]);

/** A confirmed intent fences ordinary event/snapshot reconciliation until exact terminal CAS. */
export async function remoteRecoveryFenceActive(q: DbOrTx, sessionId: string): Promise<boolean> {
  const [intent] = await q.select({ id: remoteHermesRecoveries.id }).from(remoteHermesRecoveries)
    .where(and(eq(remoteHermesRecoveries.sessionId, sessionId), inArray(remoteHermesRecoveries.state, ['pending', 'uncertain']))).limit(1);
  return !!intent;
}
