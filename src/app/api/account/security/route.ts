import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@collective/webauthn-server";
import { requireSecurityActor } from "@/lib/session";
import { beginPasskey, finishPasskey, reauthenticatePassword, beginRegistration, finishRegistration, beginTotp, finishTotp, manageSecurity, securitySummary } from "@/lib/auth/security";
import { securityRequest, securityResponse, securityFailure, directoryUnavailable } from "@/lib/auth/security-request";
import { LdapUnavailableError } from "@/lib/auth/ldap";
import { SecurityError } from "@/lib/auth/factors";
export const runtime = "nodejs";
export async function GET() {
  try { return securityResponse(await securitySummary(await requireSecurityActor())); }
  catch (err) { return err instanceof LdapUnavailableError ? directoryUnavailable(err) : securityFailure(); }
}
export async function POST(request: Request) {
  try {
    const body = await securityRequest(request);
    const actor = await requireSecurityActor();
    if (body.action === "reauth-password") return securityResponse(await reauthenticatePassword(actor, body.op, body.password, body.code, body.recovery, request.headers));
    if (body.action === "reauth-passkey-begin") return securityResponse(await beginPasskey("", actor, body.op));
    if (body.action === "reauth-passkey-finish") return securityResponse(await finishPasskey(body.flow, body.response as AuthenticationResponseJSON, "", actor));
    if (body.action === "register-begin") return securityResponse(await beginRegistration(actor, body.proof, body.value));
    if (body.action === "register-finish") return securityResponse(await finishRegistration(actor, body.flow, body.response as RegistrationResponseJSON));
    if (body.action === "totp-begin") return securityResponse(await beginTotp(actor, body.proof));
    if (body.action === "totp-finish") return securityResponse(await finishTotp(actor, body.flow, body.code));
    if (body.action === "manage") return securityResponse(await manageSecurity(actor, body.op, body.proof, body.value));
    throw new SecurityError();
  } catch (err) { return err instanceof LdapUnavailableError ? directoryUnavailable(err) : securityFailure(); }
}
