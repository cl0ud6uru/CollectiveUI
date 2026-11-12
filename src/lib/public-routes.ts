/**
 * Paths reachable without a signed-in session. Everything else is guarded by proxy.ts, and each public
 * route must authenticate on its own (e.g. the routine webhook's HMAC/bearer check).
 * tests/unit/authz-coverage.test.ts keeps this list, proxy.ts and the route handlers in sync.
 */
export const PUBLIC_PREFIXES = ["/login", "/api/auth", "/api/routines/webhook", "/api/health", "/api/hermes-team/native"] as const;

export const PUBLIC_PATHS = ["/api/branding/logo", "/api/branding/login-pet", "/api/mobile/info", "/api/mobile/auth/token", "/api/chatgpt/companion"] as const;

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

/** Server-owned request context. proxy.ts overwrites it on EVERY path, including static assets. */
export const MOBILE_API_PATH_HEADER = "x-collectiveui-mobile-api-path";

function allowsMobileTransport(headers: Pick<Headers, "get" | "has">, pathname: string): boolean {
  if (!isMobileApiPath(pathname) || headers.has("next-action")) return false;
  // Progressive form actions have no Next-Action header. Only the concrete upload route needs multipart;
  // no native endpoint accepts URL-encoded forms. Do not authorize a form action on an unmatched API path.
  // Match at least as broadly as Next's startsWith("multipart/form-data") action detector. Malformed or
  // duplicate media types must not fall between our parser and the framework's progressive-action parser.
  const type = (headers.get("content-type") ?? "").trim().toLowerCase();
  return !type.startsWith("application/x-www-form-urlencoded") && (!type.startsWith("multipart/form-data") || pathname === "/api/files");
}

export function mobileApiRequestHeaders(headers: Headers, pathname: string): Headers {
  const forwarded = new Headers(headers);
  forwarded.delete(MOBILE_API_PATH_HEADER);
  if (allowsMobileTransport(headers, pathname)) forwarded.set(MOBILE_API_PATH_HEADER, pathname);
  return forwarded;
}

/** Requires the path context that the proxy overwrites on every request, never a caller's claimed URL. */
export function isMobileApiRequest(headers: Pick<Headers, "get" | "has">): boolean {
  return allowsMobileTransport(headers, headers.get(MOBILE_API_PATH_HEADER) ?? "");
}

/** Matches bearerToken() in src/lib/auth/mobile.ts: only the Bearer scheme marks a native app request. */
export const hasBearer = (authorization: string | null) => !!authorization && /^\s*Bearer(\s|$)/i.test(authorization);
