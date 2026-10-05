import { revokeMobileSession } from "@/lib/auth/mobile";
import { errorResponse, requireMobileSession, requirePrincipal } from "@/lib/session";

/** The app's own sign-in: who it is signed in as, and until when. */
export async function GET() {
  try {
    const p = await requirePrincipal();
    const { session } = await requireMobileSession();
    return Response.json({
      user: { id: p.user.id, name: p.user.name, email: p.user.email, isAdmin: p.isAdmin, canCreateBots: p.canCreateBots },
      deviceName: session.deviceName,
      expiresAt: session.expiresAt.toISOString(),
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Sign out: revokes this token only. */
export async function DELETE() {
  try {
    const p = await requirePrincipal();
    const { session } = await requireMobileSession();
    await revokeMobileSession(p.user.id, session.id);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
