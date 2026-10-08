'use server';
import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/session';
import { saveBillingAccount, type BillingAccountInput } from '@/lib/billing/store';
import { audit } from '@/lib/audit';

export async function saveBillingConfiguration(input: BillingAccountInput) {
  const p = await requireAdmin();
  const view = await saveBillingAccount(p, input);
  await audit(p.user.id, 'billing_account.configure', view.id, { enabled: view.enabled, showHealthBar: view.showHealthBar });
  revalidatePath('/admin/spending');
  return view;
}
