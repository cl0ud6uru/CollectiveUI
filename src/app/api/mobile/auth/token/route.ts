import { exchangeAuthCode, MobileAuthError } from "@/lib/auth/mobile";

/**
 * Intentionally public: the native app redeems the one-time code from its sign-in callback, proving possession of the
 * PKCE verifier. Codes are random, single use and expire after two minutes.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as { code?: unknown; codeVerifier?: unknown } | null;
    const { token, expiresAt, principal: p } = await exchangeAuthCode(body?.code, body?.codeVerifier);
    return Response.json({
      token,
      expiresAt: expiresAt.toISOString(),
      user: { id: p.user.id, name: p.user.name, email: p.user.email, isAdmin: p.isAdmin, canCreateBots: p.canCreateBots },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof MobileAuthError) return Response.json({ error: err.message }, { status: 400 });
    console.error(err);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}
