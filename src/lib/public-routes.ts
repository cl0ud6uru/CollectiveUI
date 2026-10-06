/**
 * Paths reachable without a signed-in session. Everything else is guarded by proxy.ts, and each public
 * route must authenticate on its own (e.g. the routine webhook's HMAC/bearer check).
 * tests/unit/authz-coverage.test.ts keeps this list, proxy.ts and the route handlers in sync.
 */
export const PUBLIC_PREFIXES = ["/login", "/api/auth", "/api/routines/webhook", "/api/health"] as const;

export const PUBLIC_PATHS = ["/api/branding/logo", "/api/branding/login-pet", "/api/mobile/info", "/api/mobile/auth/token"] as const;

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "?")) || PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p + "?"));
}

/**
 * The only paths a native app bearer token may call (src/lib/auth/mobile.ts). Each still authorizes through
 * session.ts, which judges a Bearer request by its token alone. /api/mobile/v1 accepts nothing but such tokens.
 */
const MOBILE_API = [
  /^\/api\/mobile\/v1\/[A-Za-z0-9_/-]+$/,
  /^\/api\/chat$/,
  /^\/api\/chat\/[A-Za-z0-9_-]+(?:\/(?:stream|stop|approvals))?$/,
  /^\/api\/files(?:\/[A-Za-z0-9]+)?$/,
  /^\/api\/workspace\/files$/,
  /^\/api\/search$/,
];
export const MOBILE_ONLY_PREFIX = "/api/mobile/v1/";

export function isMobileApiPath(pathname: string): boolean {
  return MOBILE_API.some((re) => re.test(pathname));
}

/** Matches bearerToken() in src/lib/auth/mobile.ts: only the Bearer scheme marks a native app request. */
export const hasBearer = (authorization: string | null) => !!authorization && /^\s*Bearer(\s|$)/i.test(authorization);
