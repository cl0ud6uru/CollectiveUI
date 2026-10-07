import { z } from "zod";
import { HttpError } from "@/lib/authz";
import type { RemoteHermesSettings } from "@/lib/settings";

export function dashboardBase(raw: string): string {
  const url = new URL(raw.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new HttpError(400, 'Enter an http(s) dashboard URL without credentials, query parameters or a fragment.');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/api\/(?:status|ws|health)$/, '');
  return url.toString().replace(/\/$/, '');
}

export const remoteHermesSettingsSchema = z.object({
  enabled: z.boolean(),
  allowSessionYolo: z.boolean().default(false),
  privateGateways: z.array(z.string().max(2048).transform(dashboardBase)).max(100).transform(v => [...new Set(v)]),
});

export function assertRemoteHermesAdmission(settings: RemoteHermesSettings) {
  if (!settings.enabled) throw new HttpError(403, 'Personal remote Hermes connections are disabled by your administrator.');
}

export function assertSessionYoloAdmission(settings: RemoteHermesSettings) {
  assertRemoteHermesAdmission(settings);
  if (settings.allowSessionYolo !== true) throw new HttpError(403, 'Session YOLO changes are disabled by your administrator. Status inspection remains available.');
}

/** Called only with a binding loaded and authorized by the server, never a browser's active flag. */
export function assertRemoteHermesOperation(settings: RemoteHermesSettings, operation: 'start' | 'continue' | 'stop', binding: {
  ownerId: string; userId: string; status: 'running' | 'waiting' | 'completed';
}) {
  if (binding.ownerId !== binding.userId) throw new HttpError(404, 'Hermes run not found.');
  if (operation === 'start') return assertRemoteHermesAdmission(settings);
  if (!['running', 'waiting'].includes(binding.status)) throw new HttpError(409, 'This Hermes run has already finished.');
  // Disabling admission leaves previously admitted runs able to finish, answer prompts and stop.
}
