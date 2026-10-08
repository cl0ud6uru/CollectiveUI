import { requireAdminPage } from '@/lib/session';
import { listBillingAccounts } from '@/lib/billing/store';
import { SpendingDashboard } from '@/components/admin/spending-dashboard';
export default async function SpendingPage() {
  const p = await requireAdminPage();
  return <SpendingDashboard initial={await listBillingAccounts(p)} />;
}
