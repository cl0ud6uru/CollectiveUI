"use server";

import { requireAdmin } from "@/lib/session";
import { findLdapGroupMember } from "@/lib/admin/groups";
import { saveGroup, type GroupInput } from "@/app/admin/actions";
import { HttpError } from "@/lib/authz";
import { z } from "zod";

export type LdapGroupMember = Awaited<ReturnType<typeof findLdapGroupMember>>;

function groupFailure(err: unknown) {
  if (err instanceof HttpError) return { ok: false as const, error: err.message };
  if (err instanceof z.ZodError) return { ok: false as const, error: "Check the group fields and enter an exact LDAP username or UPN (at most 254 characters)." };
  // Unexpected failures still use Next's production error masking.
  throw err;
}

export async function findLdapUserForGroup(username: string) {
  await requireAdmin();
  try { return { ok: true as const, member: await findLdapGroupMember(username) }; }
  catch (err) { return groupFailure(err); }
}

/** Preserve the existing authorized save/audit/revalidation path while returning expected errors as data. */
export async function saveGroupWithFeedback(input: GroupInput) {
  await requireAdmin();
  try { await saveGroup(input); return { ok: true as const }; }
  catch (err) { return groupFailure(err); }
}
