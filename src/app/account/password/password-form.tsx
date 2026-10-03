"use client";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { changePassword } from "./actions";
export function PasswordForm() {
  const [error, action, pending] = useActionState(changePassword, null);
  return <form action={action} className="space-y-4">
    {error && <p role="alert" className="text-danger">{error}</p>}
    <div><Label htmlFor="currentPassword">Current or temporary password</Label><Input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required maxLength={256} /></div>
    <div><Label htmlFor="newPassword">New password</Label><Input id="newPassword" name="password" type="password" autoComplete="new-password" required minLength={15} maxLength={256} /></div>
    <div><Label htmlFor="confirmPassword">Confirm new password</Label><Input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" required minLength={15} maxLength={256} /></div>
    <Button disabled={pending} type="submit">{pending ? "Saving…" : "Change password and sign out"}</Button>
  </form>;
}
