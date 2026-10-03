import { auth } from "@/auth";
import { SecurityForm } from "@/app/account/security/security-form";
import { signOutAction } from "@/components/sidebar/sign-out";
import { securitySummary } from "@/lib/auth/security";
import { requirePagePrincipal, requireSecurityActor } from "@/lib/session";

/** Server-rendered account facts; factor secrets never enter the Settings payload. */
export async function SecurityPanel() {
  const principal = await requirePagePrincipal();
  const local = principal.user.identityRealm === "local";
  const session = local ? await auth() : null;

  return <section className="space-y-5" aria-labelledby="security-heading">
    <h2 id="security-heading" className="text-xl font-semibold">Security</h2>
    {!local ? <div className="space-y-3 rounded-xl border border-border p-4 text-sm">
      <h3 className="font-medium">Company-managed sign-in</h3>
      <p>Your organization manages authentication for this account. Microsoft Entra ID security settings are managed by your identity provider; LDAP sign-in uses your company password.</p>
      <p className="text-muted">Contact your IT team for help with your sign-in methods or password.</p>
    </div> : !session?.user.sessionId ? <div className="space-y-3 rounded-xl border border-border p-4 text-sm">
      <p>Sign out and sign in again to manage passkeys, your authenticator app and password.</p>
      <form action={signOutAction}><button className="min-h-11 underline">Sign out</button></form>
    </div> : <SecurityForm initial={await securitySummary(await requireSecurityActor())} />}
  </section>;
}
