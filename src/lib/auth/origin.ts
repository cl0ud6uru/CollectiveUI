import { HttpError } from "@/lib/authz";
/** Extra check for sensitive server actions: unlike Next's default, missing Origin fails closed. */
export function assertAuthOrigin(headers: Headers) {
  const configured = process.env.AUTH_URL;
  if (!configured || headers.get("origin") !== new URL(configured).origin) throw new HttpError(403, "Invalid request origin");
}
