import "server-only";
import type { Principal } from "@/lib/auth/groups";
import { getAccessibleModel } from "@/lib/authz";
import { getSetting } from "@/lib/settings";
import type { VoiceTarget } from "./session";

export async function configureVoiceTarget(p: Principal, target: VoiceTarget): Promise<VoiceTarget> {
  const settings = await getSetting("voice");
  if (!settings.providerAppId) return target;
  // The transport connection's audience is checked in addition to the bot's audience.
  return { ...target, voiceApp: await getAccessibleModel(p, settings.providerAppId) };
}
