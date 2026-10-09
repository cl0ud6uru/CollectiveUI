"use server";

import { requireAdmin } from "@/lib/session";
import { findLdapGroupMember } from "@/lib/admin/groups";

export async function findLdapUserForGroup(username: string) {
  await requireAdmin();
  return findLdapGroupMember(username);
}
