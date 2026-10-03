import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { loadPrincipal, type Principal } from "@/lib/auth/groups";
import { HttpError } from "@/lib/authz";

/** The signed-in principal for this request (memoised per request). */
export const getPrincipal = cache(async (): Promise<Principal | null> => {
  const session = await auth();
  if (!session?.user?.id || session.user.mustChangePassword) return null;
  const p = await loadPrincipal(session.user.id);
  return p?.user.sessionVersion === session.user.sessionVersion ? p : null;
});

/** For pages/layouts: redirect to /login if not signed in. */
export async function requirePagePrincipal(): Promise<Principal> {
  const p = await getPrincipal();
  if (!p) {
    const session = await auth();
    if (session?.user?.mustChangePassword) redirect("/account/password");
    redirect("/login");
  }
  return p;
}

export async function requireAdminPage(): Promise<Principal> {
  const p = await requirePagePrincipal();
  if (!p.isAdmin) redirect("/");
  return p;
}

/** For route handlers & server actions. */
export async function requirePrincipal(): Promise<Principal> {
  const p = await getPrincipal();
  if (!p) throw new HttpError(401, "Unauthorized");
  return p;
}

export async function requireAdmin(): Promise<Principal> {
  const p = await requirePrincipal();
  if (!p.isAdmin) throw new HttpError(403, "Admin only");
  return p;
}

export function errorResponse(err: unknown) {
  if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status });
  console.error(err);
  return Response.json({ error: "Internal error" }, { status: 500 });
}

/** Only the password screen/action can use a restricted first-login session. */
export async function requirePasswordPrincipal() {
  const session = await auth();
  if (!session?.user?.id) throw new HttpError(401, "Unauthorized");
  const p = await loadPrincipal(session.user.id);
  if (!p || p.user.sessionVersion !== session.user.sessionVersion || p.user.identityRealm !== "local") throw new HttpError(403, "Local account required");
  return p;
}

/** Factor management needs a specific current Auth.js session, never an account-wide version alone. */
export async function requireSecurityActor() {
  const p = await requirePasswordPrincipal();
  const session = await auth();
  if (!session?.user.sessionId) throw new HttpError(401, "Sign in again before changing security settings");
  return { id: p.user.id, sessionVersion: session.user.sessionVersion, sessionId: session.user.sessionId };
}
