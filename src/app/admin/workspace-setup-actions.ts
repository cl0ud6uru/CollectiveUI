"use server";

import { readWorkspaceSetup } from "@/lib/sandbox/setup-server";
import { requireAdmin } from "@/lib/session";
import { getSetting } from "@/lib/settings";

export async function checkWorkspaceSetup() {
  await requireAdmin();
  return readWorkspaceSetup((await getSetting("sandbox")).allowRunc);
}
