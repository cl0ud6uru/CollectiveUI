import { requirePrincipal, errorResponse } from '@/lib/session';
import { assertAuthOrigin } from '@/lib/auth/origin';
import { readCodexAllowance } from '@/lib/codex-allowance/bridge';
export async function GET() {
  try { return Response.json(await readCodexAllowance(await requirePrincipal()), { headers: { 'Cache-Control': 'private, no-store' } }); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    const p = await requirePrincipal(); assertAuthOrigin(request.headers);
    return Response.json(await readCodexAllowance(p, true), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return errorResponse(error); }
}
