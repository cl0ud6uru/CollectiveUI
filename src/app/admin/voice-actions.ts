"use server";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { getAccessibleModel, HttpError } from "@/lib/authz";
import { voiceSettingsSchema } from "@/lib/voice/policy";
import { voiceEligibility } from "@/lib/voice/session";
import { setSetting } from "@/lib/settings";
import { audit } from "@/lib/audit";

export async function saveVoiceSettings(raw: unknown) {
  const p = await requireAdmin();
  const value = voiceSettingsSchema.parse(raw);
  if (value.providerAppId) {
    const app = await getAccessibleModel(p, value.providerAppId);
    const eligible = await voiceEligibility({ app, bot: null });
    if (!eligible.supported) throw new HttpError(400, eligible.reason);
  }
  await setSetting("voice", value);
  await audit(p.user.id, "settings.voice", undefined, value);
  revalidatePath("/admin/tools");
}
