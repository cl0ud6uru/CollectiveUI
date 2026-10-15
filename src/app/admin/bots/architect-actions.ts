"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { requireAdmin } from "@/lib/session";
import { HttpError } from "@/lib/authz";
import { installArchitectBot } from "@/lib/bots/architect-store";

export async function addArchitectBot(appId: string): Promise<{ ok: true; botId: string } | { ok: false; error: string }> {
  const p = await requireAdmin();
  try {
    const bot = await installArchitectBot(p, { appId });
    revalidatePath("/", "layout");
    return { ok: true, botId: bot.id };
  } catch (err) {
    if (err instanceof HttpError) return { ok: false, error: err.message };
    if (err instanceof ZodError) return { ok: false, error: "Choose a model for The Architect." };
    return { ok: false, error: "The Architect could not be installed. Try again." };
  }
}
