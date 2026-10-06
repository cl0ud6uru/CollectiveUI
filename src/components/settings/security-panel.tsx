import { db } from "@/db";
import { localSecurity } from "@/db/schema";
import { eq } from "drizzle-orm";
import { ldapEnabled } from "@/lib/auth/config";
import { auth } from "@/auth";
import { SecurityForm } from "@/app/account/security/security-form";
import { signOutAction } from "@/components/sidebar/sign-out";
import { securitySummary } from "@/lib/auth/security";
import { MobileDevices } from "@/components/settings/mobile-devices";
import { requirePagePrincipal, requireSecurityActor } from "@/lib/session";

/** Server-rendered account facts; factor secrets never enter the Settings payload. */
export async function SecurityPanel() {
  const principal = await requirePagePrincipal();
  const local = principal.user.identityRealm === "local";
  const [profile] = local ? [] : await db.select({ identity: localSecurity.ldapIdentity }).from(localSecurity).where(eq(localSecurity.userId, principal.user.id));
  const ldap = !local && ldapEnabled() && (principal.user.authSource === "ldap" || !!profile?.identity);
  const session = local || ldap ? await auth() : null;

  return <section className="space-y-5" aria-labelledby="security-heading">
    <h2 id="security-heading" className="text-xl font-semibold">Security</h2>
    {!local && !ldap ? <div className="space-y-3 rounded-xl border border-border p-4 text-sm">
      <h3 className="font-medium">Company-managed sign-in</h3>
      <p>Your organization manages Microsoft Entra ID sign-in, passkeys and MFA. Entra passkeys are enrolled separately from CollectiveUI passkeys.</p>
      <p className="text-muted">Contact your IT team for help with your sign-in methods or password.</p>
    </div> : !session?.user.sessionId ? <div className="space-y-3 rounded-xl border border-border p-4 text-sm">
      <p>Sign out and sign in again to manage passkeys, your authenticator app and password.</p>
      <form action={signOutAction}><button className="min-h-11 underline">Sign out</button></form>
    </div> : <SecurityForm initial={await securitySummary(await requireSecurityActor())} />}
    <MobileDevices />
  </section>;
}
