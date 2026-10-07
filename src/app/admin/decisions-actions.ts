"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { assertAdmin, getAccessibleModel, HttpError } from "@/lib/authz";
import { loadPrincipal } from "@/lib/auth/groups";
import { decisionsCapability, decisionsSettingsSchema } from "@/lib/decisions-policy";
import { providerContextFor } from "@/lib/llm/resolve";
import { setSetting } from "@/lib/settings";
import { audit } from "@/lib/audit";

export async function saveDecisionsSettings(raw: unknown) {
  const principal = await requireAdmin();
  const value = decisionsSettingsSchema.parse(raw);
  const fresh = await loadPrincipal(principal.user.id);
  if (!fresh || fresh.user.sessionVersion !== principal.user.sessionVersion) throw new HttpError(403, "Your access changed. Sign in again.");
  assertAdmin(fresh);
  if (value.queenRouting && !value.providerAppId) throw new HttpError(400, "Choose a company OpenAI API connection first.");
  if (value.queenRouting && value.providerAppId) {
    const app = await getAccessibleModel(fresh, value.providerAppId);
    if (!decisionsCapability(app)) throw new HttpError(400, "Decisions requires a company OpenAI API connection at the official endpoint. Hermes and ChatGPT plans are unsupported.");
    const provider = await providerContextFor(app);
    if (!decisionsCapability({ ...app, baseUrl: provider.baseUrl })) throw new HttpError(400, "This saved provider endpoint does not support Decisions.");
  }
  await setSetting("decisions", value);
  await audit(fresh.user.id, "settings.decisions", undefined, value);
  revalidatePath("/admin/tools");
}
