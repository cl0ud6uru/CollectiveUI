import { requireAdmin, errorResponse } from '@/lib/session';
import { listBillingAccounts } from '@/lib/billing/store';
export async function GET() {
  try { return Response.json(await listBillingAccounts(await requireAdmin()), { headers: { 'Cache-Control': 'private, no-store' } }); }
  catch (error) { return errorResponse(error); }
}
