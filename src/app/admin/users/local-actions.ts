"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { changeUserAccess, createLocalUser, resetLocalPassword } from "@/lib/auth/local";
import { assertAuthOrigin } from "@/lib/auth/origin";
import { HttpError } from "@/lib/authz";
import { PASSWORD_GUIDANCE, PasswordBusy } from "@/lib/auth/password";
function message(err: unknown) {
  return err instanceof HttpError || err instanceof PasswordBusy ? err.message : `Unable to save account. ${PASSWORD_GUIDANCE}`;
}
export async function createLocalAccount(_prev: string | null, form: FormData) {
  const p = await requireAdmin();
  assertAuthOrigin(await headers());
  try {
    await createLocalUser({ username: form.get("username"), name: form.get("name"), email: form.get("email"), password: form.get("password"), isAdmin: form.get("isAdmin") === "on" }, p.user);
    revalidatePath("/admin/users");
    return "Account created. Deliver the temporary password privately; it expires in 24 hours.";
  } catch (err) { return message(err); }
}
export async function resetLocalAccount(_prev: string | null, form: FormData) {
  const p = await requireAdmin();
  assertAuthOrigin(await headers());
  const userId = form.get("userId");
  const password = form.get("password");
  if (typeof userId !== "string" || userId.length > 100 || typeof password !== "string") return "Invalid input";
  try {
    await resetLocalPassword(p.user, userId, password);
    revalidatePath("/admin/users");
    return "Password reset. Sessions revoked; the temporary password expires in 24 hours.";
  } catch (err) { return message(err); }
}
export async function revokeUserSessions(userId: string) {
  const p = await requireAdmin();
  assertAuthOrigin(await headers());
  if (typeof userId !== "string" || userId.length > 100) throw new HttpError(400, "Invalid input");
  await changeUserAccess(p.user, userId, { revoke: true });
  revalidatePath("/admin/users");
}
