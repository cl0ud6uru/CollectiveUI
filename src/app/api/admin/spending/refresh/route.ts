import { requireAdmin, errorResponse } from '@/lib/session';
import { assertAuthOrigin } from '@/lib/auth/origin';
import { HttpError } from '@/lib/authz';
import { refreshBillingAccount } from '@/lib/billing/store';
export async function POST(request: Request) {
  try {
    const p = await requireAdmin(); assertAuthOrigin(request.headers);
    const body = await request.text(); if (body.length > 1000) throw new HttpError(400, 'Invalid refresh request.');
    const value = JSON.parse(body);
    if (typeof value.id !== 'string' || value.id.length > 100) throw new HttpError(400, 'Invalid refresh request.');
    return Response.json(await refreshBillingAccount(p, value.id), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return errorResponse(error instanceof SyntaxError ? new HttpError(400, 'Invalid refresh request.') : error); }
}
