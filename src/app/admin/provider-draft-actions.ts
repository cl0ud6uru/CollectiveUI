"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireSecurityActor } from "@/lib/session";
import { assertAuthOrigin } from "@/lib/auth/origin";
import { completeArchitectProviderConnectionDraft } from "@/lib/admin/architect-connections";

/** The only API-key entry point for Architect-created connection drafts. Never log or echo the input. */
export async function saveArchitectProviderConnectionDraft(draftId: string, apiKey: string) {
  const actor = await requireSecurityActor();
  assertAuthOrigin(await headers());
  const result = await completeArchitectProviderConnectionDraft(actor.id, actor.sessionVersion, { draftId, apiKey });
  revalidatePath("/admin/apps");
  revalidatePath("/", "layout");
  return result;
}
