import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { providerBillingAccounts } from '@/db/schema';
import { rewrap } from '@/lib/crypto';
export const billingAad = (id: string, organization: string) => `provider_billing_accounts.admin_key_enc|${id}|${organization}`;
/** Worker key rotation only. Row/organization AAD and CAS preserve concurrent credential changes. */
export async function rewrapBillingSecrets() {
  let count = 0;
  for (const row of await db.select().from(providerBillingAccounts)) {
    const next = rewrap(row.adminKeyEnc, billingAad(row.id, row.organization));
    if (next) count += (await db.update(providerBillingAccounts).set({ adminKeyEnc: next }).where(and(eq(providerBillingAccounts.id, row.id), eq(providerBillingAccounts.adminKeyEnc, row.adminKeyEnc))).returning({ id: providerBillingAccounts.id })).length;
  }
  return count;
}
