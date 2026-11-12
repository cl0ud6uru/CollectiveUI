import { createHash } from "node:crypto";
import { hmacSha256Hex, safeEqual } from "@/lib/crypto";
import { HttpError } from "@/lib/http-error";

export const WEBHOOK_MAX_AGE_SECONDS = 300;
export type WebhookDelivery = { id: string; payloadHash: string; timestamp: number };

export function assertWebhookFresh(timestamp: number, now = Date.now()) {
  if (!Number.isSafeInteger(timestamp) || Math.abs(Math.floor(now / 1000) - timestamp) > WEBHOOK_MAX_AGE_SECONDS)
    throw new HttpError(401, "Webhook timestamp is outside the five-minute acceptance window.");
}

/** The signature binds freshness, delivery identity and the exact request bytes together. */
export function authenticateRoutineWebhook(headers: Headers, secret: string, raw: string, now = Date.now()): WebhookDelivery | undefined {
  if (headers.has("x-portal-signature")) {
    const timestamp = headers.get("x-portal-timestamp") ?? "";
    const id = headers.get("x-portal-delivery-id") ?? "";
    const signature = headers.get("x-portal-signature") ?? "";
    if (!/^[0-9]{1,12}$/.test(timestamp) || !/^[A-Za-z0-9_-]{16,100}$/.test(id) || !/^sha256=[a-f0-9]{64}$/.test(signature))
      throw new HttpError(401, "Signed webhooks require X-Portal-Timestamp and X-Portal-Delivery-Id.");
    assertWebhookFresh(Number(timestamp), now);
    if (!safeEqual(signature.slice(7), hmacSha256Hex(secret, `${timestamp}.${id}.${raw}`)))
      throw new HttpError(401, "Invalid signature");
    return { id, timestamp: Number(timestamp), payloadHash: createHash("sha256").update(raw).digest("hex") };
  }
  const bearer = headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!bearer || !safeEqual(bearer, secret)) throw new HttpError(401, "Invalid signature");
}
