import { cookies } from "next/headers";
import type { AuthenticationResponseJSON } from "@collective/webauthn-server";
import { randomToken } from "@/lib/crypto";
import { beginPasswordLogin, finishPasswordLogin, beginPasskey, finishPasskey } from "@/lib/auth/security";
import { bindingCookieName, readBinding, securityConfig, SecurityError } from "@/lib/auth/factors";
import { securityRequest, securityResponse, securityFailure } from "@/lib/auth/security-request";
export const runtime = "nodejs";
/** Public preauthentication only. No Auth.js session is issued by this handler. */
export async function POST(request: Request) {
  try {
    const body = await securityRequest(request);
    let binding = readBinding(request.headers);
    if (body.action === "password-begin" || body.action === "passkey-begin") {
      binding = randomToken();
      (await cookies()).set(bindingCookieName(), binding, { httpOnly: true, secure: securityConfig().secure, sameSite: "strict", path: "/", maxAge: 300 });
    }
    if (!binding) throw new SecurityError();
    if (body.action === "password-begin") return securityResponse(await beginPasswordLogin(body.username, body.password, request.headers, binding, "ldap"));
    if (body.action === "password-finish") return securityResponse(await finishPasswordLogin(body.flow, body.code, body.recovery, binding, "ldap"));
    if (body.action === "passkey-begin") return securityResponse(await beginPasskey(binding, undefined, undefined, "ldap"));
    if (body.action === "passkey-finish") return securityResponse(await finishPasskey(body.flow, body.response as AuthenticationResponseJSON, binding, undefined, "ldap"));
    throw new SecurityError();
  } catch { return securityFailure(); }
}
