import { z } from 'zod';
import { HttpError } from '@/lib/authz';

export const COMPANION_PROTOCOL = 'collective-chatgpt-companion-v1';
export function companionConfiguration() {
  try {
    if (process.env.CHATGPT_COMPANION_ENABLED !== 'true') return null;
    const origin = new URL(process.env.AUTH_URL || '');
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.hash || origin.search) return null;
    const download = z.url().safeParse(process.env.CHATGPT_COMPANION_DOWNLOAD_URL);
    if (!download.success || new URL(download.data).protocol !== 'https:') return null;
    return { origin: origin.origin, downloadUrl: download.data };
  } catch { return null; }
}
export function requireCompanionConfiguration() {
  const configuration = companionConfiguration();
  if (!configuration) throw new HttpError(409, 'An operator must install and enable the reviewed local sign-in app for this installation.');
  return configuration;
}
