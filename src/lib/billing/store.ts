import 'server-only';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db';
import { providerBillingAccounts, providerConnections } from '@/db/schema';
import { assertAdmin, HttpError } from '@/lib/authz';
import type { Principal } from '@/lib/auth/groups';
import { decrypt, encrypt } from '@/lib/crypto';
import { newId } from '@/lib/ids';
import type { BillingAccountView } from './contracts';
import { readOpenAISpending } from './openai';

import { billingAad } from './secrets';
const Input = z.object({ id: z.string().min(1).max(100).optional(), name: z.string().trim().min(1).max(80), organization: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  adminKey: z.string().max(10000).optional(), enabled: z.boolean(), showHealthBar: z.boolean() }).strict();
export type BillingAccountInput = z.input<typeof Input>;
type Account = typeof providerBillingAccounts.$inferSelect;
export function billingView(row: Account): BillingAccountView {
  return { id: row.id, name: row.name, organization: row.organization, enabled: row.enabled, showHealthBar: row.showHealthBar,
    snapshot: row.snapshot, lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null, lastError: row.lastError };
}
export async function listBillingAccounts(p: Principal) {
  assertAdmin(p);
  return (await db.select().from(providerBillingAccounts).orderBy(providerBillingAccounts.name)).map(billingView);
}
export async function saveBillingAccount(p: Principal, raw: BillingAccountInput) {
  assertAdmin(p); const parsed = Input.safeParse(raw);
  // Validation failures must never contain raw secret input.
  if (!parsed.success) throw new HttpError(400, 'Invalid billing configuration.');
  const input = parsed.data; const id = input.id ?? newId();
  const key = input.adminKey?.trim();
  if (key && (!key.startsWith('sk-admin-') || /\s/.test(key))) throw new HttpError(400, 'Use a separate API Platform Admin key.');
  return db.transaction(async tx => {
    const [prior] = input.id ? await tx.select().from(providerBillingAccounts).where(eq(providerBillingAccounts.id, id)).for('update') : [];
    if (input.id && !prior) throw new HttpError(404, 'Billing account not found.');
    if (prior && input.organization !== prior.organization) throw new HttpError(400, 'Create a new billing account for a different organization.');
    if (!prior && !key) throw new HttpError(400, 'A separate billing Admin key is required.');
    const values = { name: input.name, enabled: input.enabled, showHealthBar: input.showHealthBar, revision: (prior?.revision ?? 0) + 1, updatedAt: new Date(),
      ...(key ? { adminKeyEnc: encrypt(key, billingAad(id, input.organization)), snapshot: null, lastAttemptAt: null, lastError: null } : {}) };
    const [row] = prior ? await tx.update(providerBillingAccounts).set(values).where(eq(providerBillingAccounts.id, id)).returning()
      : await tx.insert(providerBillingAccounts).values({ ...values, id, organization: input.organization, adminKeyEnc: encrypt(key!, billingAad(id, input.organization)), createdBy: p.user.id }).returning();
    return billingView(row);
  });
}
/** Cache reads and refreshes both authorize. CAS prevents publication after disable/key rotation. */
export async function refreshBillingAccount(p: Principal, id: string, now = new Date(), fetcher: typeof fetch = fetch) {
  assertAdmin(p);
  const [row] = await db.select().from(providerBillingAccounts).where(eq(providerBillingAccounts.id, id));
  if (!row) throw new HttpError(404, 'Billing account not found.');
  if (!row.enabled) throw new HttpError(409, 'Provider spending is disabled for this account.');
  // Claim a bounded refresh before provider I/O; concurrent tabs/workers cannot flood the provider.
  if (row.lastAttemptAt && now.getTime() - row.lastAttemptAt.getTime() < 60_000) throw new HttpError(429, 'Wait a minute before refreshing again.');
  const where = and(eq(providerBillingAccounts.id, id), eq(providerBillingAccounts.revision, row.revision), eq(providerBillingAccounts.enabled, true));
  const claimed = await db.update(providerBillingAccounts).set({ revision: row.revision + 1, lastAttemptAt: now }).where(where).returning({ id: providerBillingAccounts.id });
  if (!claimed.length) throw new HttpError(409, 'Billing configuration changed. Reload before refreshing.');
  const publish = and(eq(providerBillingAccounts.id, id), eq(providerBillingAccounts.revision, row.revision + 1), eq(providerBillingAccounts.enabled, true));
  let snapshot;
  try {
    const key = decrypt(row.adminKeyEnc, billingAad(row.id, row.organization));
    const connections = await db.select({ project: providerConnections.project }).from(providerConnections).where(eq(providerConnections.organization, row.organization));
    const projects = [...new Set(connections.flatMap(c => c.project ? [c.project] : []))];
    if (projects.length > 100) throw new Error('Project bound');
    snapshot = await readOpenAISpending(row.organization, key, projects, now, fetcher);
  } catch {
    // Keep last successful snapshot, including its original freshness, but never provider error text.
    await db.update(providerBillingAccounts).set({ lastError: 'Refresh failed. Check the billing key permissions and server configuration.' }).where(publish);
    return listBillingAccounts(p);
  }
  if (snapshot.costsStatus !== 'known') {
    await db.update(providerBillingAccounts).set({ lastError: `Costs ${snapshot.costsStatus.replaceAll('_', ' ')}. Last successful data is retained.` }).where(publish);
  } else {
    await db.update(providerBillingAccounts).set({ snapshot, lastError: null }).where(publish);
  }
  return listBillingAccounts(p);
}
