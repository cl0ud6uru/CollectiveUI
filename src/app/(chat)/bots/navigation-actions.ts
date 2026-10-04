"use server";

import { revalidatePath } from "next/cache";
import { requirePrincipal } from "@/lib/session";
import { HttpError } from "@/lib/authz";
import { saveBotNavigation } from "@/lib/bots/navigation-store";
import type { BotNavigationChange } from "@/lib/bots/navigation";

export async function updateBotNavigation(change: BotNavigationChange) {
  const p = await requirePrincipal();
  try {
    await saveBotNavigation(p, change);
  } catch (error) {
    return { error: error instanceof HttpError ? error.message : "Could not save bot navigation. Your last saved arrangement has been restored. Please try again." };
  }
  revalidatePath("/", "layout");
  return { error: null };
}
