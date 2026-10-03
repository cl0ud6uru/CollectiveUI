import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isPublicPath } from "@/lib/public-routes";

export const proxy = auth((req) => {
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
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|svg|ico|webp)$).*)"],
};
