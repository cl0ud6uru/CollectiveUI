import { NextResponse, type NextFetchEvent, type NextRequest, type NextMiddleware } from "next/server";
import { auth, authSessionCookieName, guardedHttpLogout } from "@/auth";
import { webSessionRegistryEnabled } from "@/lib/auth/web-sessions";
import { hasBearer, isMobileApiPath, isPublicPath, MOBILE_ONLY_PREFIX } from "@/lib/public-routes";

const authenticatedProxy = auth((req) => {
  const { pathname: path } = req.nextUrl;
  // Native app tokens reach only the mobile API, where session.ts checks the token (never the cookies); the
  // mobile-only API never takes a browser session.
  if (!isPublicPath(path) && hasBearer(req.headers.get("authorization")))
    return isMobileApiPath(path) ? NextResponse.next() : NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (path.startsWith(MOBILE_ONLY_PREFIX)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!req.auth?.user) {
    const { pathname, search } = req.nextUrl;
    if (!isPublicPath(pathname)) {
      if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      const url = new URL("/login", req.nextUrl.origin);
      url.searchParams.set("callbackUrl", pathname + search);
      return NextResponse.redirect(url);
    }
  }
  if (req.auth?.user?.mustChangePassword && !isPublicPath(req.nextUrl.pathname) && req.nextUrl.pathname !== "/account/password" && req.nextUrl.pathname !== "/api/account/security") {
    if (req.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: "Password change required" }, { status: 403 });
    return NextResponse.redirect(new URL("/account/password", req.nextUrl.origin));
  }
  return NextResponse.next();
}) as unknown as NextMiddleware; // Auth.js overload types this shared proxy/route wrapper as a route handler.

/** Proxy cannot commit logout: retain cookies on callback failures so HTTP/server-action logout can retry. */
export async function proxy(req: NextRequest, event: NextFetchEvent) {
  if (guardedHttpLogout(req)) return NextResponse.next();
  const response = await authenticatedProxy(req, event);
  if (!response || !webSessionRegistryEnabled()) return response;
  const name = authSessionCookieName(req);
  const cookies = response.headers.getSetCookie();
  const isSessionCookie = (cookie: string) => {
    const key = cookie.slice(0, cookie.indexOf("="));
    return key === name || key.startsWith(`${name}.`);
  };
  // Renewal cleans old chunks before setting the new bundle; preserve that bundle in full.
  if (cookies.some(cookie => isSessionCookie(cookie) && cookie.split(";", 1)[0].slice(cookie.indexOf("=") + 1) !== "" && !/(?:^|;)\s*Max-Age=0(?:;|$)/i.test(cookie))) return response;
  const retained = cookies.filter(cookie => {
    return !(isSessionCookie(cookie) && /(?:^|;)\s*Max-Age=0(?:;|$)/i.test(cookie));
  });
  if (retained.length === cookies.length) return response;
  const headers = new Headers(response.headers); headers.delete("set-cookie");
  for (const cookie of retained) headers.append("set-cookie", cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|svg|ico|webp)$).*)"],
};
