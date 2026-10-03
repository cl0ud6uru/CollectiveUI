/**
 * Paths reachable without a signed-in session. Everything else is guarded by proxy.ts, and each public
 * route must authenticate on its own (e.g. the routine webhook's HMAC/bearer check).
 * tests/unit/authz-coverage.test.ts keeps this list, proxy.ts and the route handlers in sync.
 */
export const PUBLIC_PREFIXES = ["/login", "/api/auth", "/api/routines/webhook", "/api/health"] as const;

export const PUBLIC_PATHS = ["/api/branding/logo", "/api/branding/login-pet"] as const;

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "?")) || PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p + "?"));
}
