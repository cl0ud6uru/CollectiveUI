"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { requireAdmin } from "@/lib/session";
import { HttpError } from "@/lib/authz";
import { installOfficeBot } from "@/lib/bots/office-store";
import { SandboxError } from "@/lib/sandbox/client";

export async function addOfficeBot(appId: string): Promise<{ ok: true; botId: string } | { ok: false; error: string }> {
  const p = await requireAdmin();
  try {
    const bot = await installOfficeBot(p, { appId });
    revalidatePath("/", "layout");
    return { ok: true, botId: bot.id };
  } catch (err) {
    if (err instanceof HttpError || err instanceof SandboxError) return { ok: false, error: err.message };
    if (err instanceof ZodError) return { ok: false, error: "Choose a model for Office Bot." };
    return { ok: false, error: "Office Bot could not be installed. Check the workspace service and try again." };
  }
}
