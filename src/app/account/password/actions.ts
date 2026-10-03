"use server";
import { headers } from "next/headers";
import { signOut } from "@/auth";
import { requirePasswordPrincipal } from "@/lib/session";
import { changeOwnPassword } from "@/lib/auth/local";
import { assertAuthOrigin } from "@/lib/auth/origin";
import { HttpError } from "@/lib/authz";
import { PASSWORD_GUIDANCE, PasswordBusy } from "@/lib/auth/password";
export async function changePassword(_prev: string | null, form: FormData): Promise<string | null> {
  const p = await requirePasswordPrincipal();
  const h = await headers();
  assertAuthOrigin(h);
  if (form.get("password") !== form.get("confirmPassword")) return "New passwords do not match.";
  try { await changeOwnPassword(p.user, form.get("currentPassword"), form.get("password"), h); }
  catch (err) {
    if (err instanceof HttpError || err instanceof PasswordBusy) return err.message;
    return `Unable to change password. ${PASSWORD_GUIDANCE}`;
  }
  await signOut({ redirectTo: "/login" });
  return null;
}
