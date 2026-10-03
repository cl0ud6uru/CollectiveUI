import { CronExpressionParser } from "cron-parser";
import { AAD, decrypt, encrypt } from "@/lib/crypto";
import { newToken } from "@/lib/ids";

export function nextCronRun(cron: string, timezone: string, from = new Date()): Date {
  return CronExpressionParser.parse(cron, { currentDate: from, tz: timezone }).next().toDate();
}

export function isValidCron(cron: string, timezone = "UTC") {
  try {
    nextCronRun(cron, timezone);
    return true;
  } catch {
    return false;
  }
}

/** New webhook secret, encrypted for storage. */
export const newWebhookSecret = () => encrypt(newToken(), AAD.routineWebhookSecret);

/** Decrypts a stored webhook secret. Values written before encryption was added are plaintext tokens. */
export function openWebhookSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  return stored.startsWith("v2.") ? decrypt(stored, AAD.routineWebhookSecret) : stored;
}
