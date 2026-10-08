'use server';
import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/session';
import { saveBillingAccount, type BillingAccountInput } from '@/lib/billing/store';
import { HttpError } from '@/lib/authz';
import { audit } from '@/lib/audit';

export async function saveBillingConfiguration(input: BillingAccountInput) {
  const p = await requireAdmin();
  let view;
  try { view = await saveBillingAccount(p, input); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(500, 'Billing configuration could not be saved.'); }
  await audit(p.user.id, 'billing_account.configure', view.id, { enabled: view.enabled, showHealthBar: view.showHealthBar });
  revalidatePath('/admin/spending');
  return view;
}
