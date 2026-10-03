"use client";
import { useActionState } from "react";
import { createLocalAccount, resetLocalAccount } from "@/app/admin/users/local-actions";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
export function CreateLocalUser() {
  const [status, action, pending] = useActionState(createLocalAccount, null);
  return <details className="mb-6 rounded-xl border border-border p-4"><summary className="cursor-pointer font-medium">Create local account</summary>
    <form action={action} className="mt-4 grid max-w-xl gap-4">
      {status && <p role="status" className="text-sm">{status}</p>}
      <div><Label htmlFor="create-username">Username</Label><Input id="create-username" name="username" required minLength={3} maxLength={64} autoComplete="off" /></div>
      <div><Label htmlFor="create-name">Display name</Label><Input id="create-name" name="name" required maxLength={100} /></div>
      <div><Label htmlFor="create-email">Email (optional login alias)</Label><Input id="create-email" name="email" type="email" maxLength={254} autoComplete="off" /></div>
      <div><Label htmlFor="create-password">Temporary password</Label><Input id="create-password" name="password" type="password" required minLength={15} maxLength={256} autoComplete="new-password" /></div>
      <p className="text-xs text-muted">Use 15–128 characters, up to 512 UTF-8 bytes. Deliver it privately after verifying the person’s identity. It expires in 24 hours and must be changed at first sign-in.</p>
      <label className="flex gap-2 text-sm"><input name="isAdmin" type="checkbox" /> Administrator</label>
      <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create account"}</Button>
    </form>
  </details>;
}
export function ResetLocalPassword({ userId }: { userId: string }) {
  const [status, action, pending] = useActionState(resetLocalAccount, null);
  return <details className="mt-2 text-xs"><summary className="cursor-pointer">Reset local password</summary>
    <form action={action} className="mt-2 space-y-2">
      <input type="hidden" name="userId" value={userId} />
      {status && <p role="status">{status}</p>}
      <Label htmlFor={`reset-${userId}`}>New temporary password</Label><Input id={`reset-${userId}`} name="password" type="password" autoComplete="new-password" required minLength={15} maxLength={256} />
      <Button type="submit" disabled={pending}>Reset password</Button>
    </form>
  </details>;
}
