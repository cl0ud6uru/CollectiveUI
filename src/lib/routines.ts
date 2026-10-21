import { CronExpressionParser } from "cron-parser";
import { AAD, decrypt, encrypt } from "@/lib/crypto";
import { newToken } from "@/lib/ids";

export function nextCronRun(cron: string, timezone: string, from = new Date()): Date {
  if (cron.trim().split(/\s+/).length !== 5) throw new Error("Use a five-field cron schedule (without seconds).");
  const expression = CronExpressionParser.parse(cron, { currentDate: from, tz: timezone });
  // Check every selected time, rather than just the next two occurrences: the latter
  // can miss a one-minute burst depending on when a schedule is saved. Calendar
  // fields may remove days, but cannot make a close pair of daily slots safe.
  const slots = expression.fields.hour.values.flatMap(hour => expression.fields.minute.values.map(minute => hour * 60 + minute));
  if (slots.some((slot, index) => ((slots[(index + 1) % slots.length] - slot + 1440) % 1440 || 1440) < 5))
    throw new Error("Scheduled times must be at least five minutes apart.");
  return expression.next().toDate();
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
