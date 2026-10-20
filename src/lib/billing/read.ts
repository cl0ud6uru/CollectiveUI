import { asc } from 'drizzle-orm';
import { db } from '@/db';
import { providerBillingAccounts } from '@/db/schema';
import { assertAdmin } from '@/lib/authz';
import type { Principal } from '@/lib/auth/groups';
import type { BillingAccountView } from './contracts';

/** Shared, credential-free billing metadata projection for Admin UI and worker diagnostics. */
export async function readBillingAccounts(p: Principal): Promise<BillingAccountView[]> {
  assertAdmin(p);
  const rows = await db.select({
    id: providerBillingAccounts.id,
    name: providerBillingAccounts.name,
    organization: providerBillingAccounts.organization,
    enabled: providerBillingAccounts.enabled,
    showHealthBar: providerBillingAccounts.showHealthBar,
    snapshot: providerBillingAccounts.snapshot,
    lastAttemptAt: providerBillingAccounts.lastAttemptAt,
    lastError: providerBillingAccounts.lastError,
  }).from(providerBillingAccounts).orderBy(asc(providerBillingAccounts.name));
  return rows.map(row => ({
    ...row,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
  }));
}
