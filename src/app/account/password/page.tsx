import { hasLocalFactors } from "@/lib/auth/factor-state";
import { securitySummary } from "@/lib/auth/security";
import { requireSecurityActor } from "@/lib/session";
import { SecurityForm } from "../security/security-form";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { requirePasswordPrincipal } from "@/lib/session";
import { PasswordForm } from "./password-form";
import { signOutAction } from "@/components/sidebar/sign-out";
export default async function PasswordPage() {
  if (!(await auth())?.user?.id) redirect("/login");
  const principal = await requirePasswordPrincipal();
  if (await hasLocalFactors(principal.user.id)) return <main className="mx-auto max-w-2xl px-4 py-10"><h1 className="mb-6 text-2xl font-semibold">Change your local password</h1><SecurityForm passwordOnly initial={await securitySummary(await requireSecurityActor())} /></main>;
  return <main className="mx-auto max-w-lg space-y-6 px-6 py-16">
    <h1 className="text-2xl font-semibold">Change your local password</h1>
    <p className="text-muted">Use a unique passphrase of 15–128 characters, up to 512 UTF-8 bytes. Temporary passwords must be changed before you can use the workspace. All your sessions will be signed out.</p>
    <PasswordForm />
    <form action={signOutAction}><button className="text-sm underline">Sign out</button></form>
  </main>;
}
