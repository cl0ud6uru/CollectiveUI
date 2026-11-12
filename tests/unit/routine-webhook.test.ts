import { describe, expect, it } from "vitest";
import { hmacSha256Hex } from "@/lib/crypto";
import { authenticateRoutineWebhook } from "@/lib/routines/webhook";

const secret = "synthetic-webhook-secret";
const now = 1_800_000_000_000;
const raw = '{"ticket":"INC-123"}';
const id = "synthetic-delivery-123";
function signed(timestamp = String(now / 1000)) {
  return new Headers({ "x-portal-timestamp": timestamp, "x-portal-delivery-id": id,
    "x-portal-signature": `sha256=${hmacSha256Hex(secret, `${timestamp}.${id}.${raw}`)}` });
}
describe("signed routine webhook authentication", () => {
  it("binds timestamp, delivery ID and exact raw payload", () => {
    expect(authenticateRoutineWebhook(signed(), secret, raw, now)).toMatchObject({ id, timestamp: now / 1000, payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    for (const field of ["x-portal-timestamp", "x-portal-delivery-id", "x-portal-signature"]) {
      const headers = signed(); headers.set(field, headers.get(field)! + "0");
      expect(() => authenticateRoutineWebhook(headers, secret, raw, now)).toThrow();
    }
    expect(() => authenticateRoutineWebhook(signed(), secret, raw + " ", now)).toThrow("Invalid signature");
  });
  it.each([-301, 301])("rejects signed timestamps %s seconds from the server clock", offset => {
    expect(() => authenticateRoutineWebhook(signed(String(now / 1000 + offset)), secret, raw, now)).toThrow("five-minute");
  });
  it("rejects legacy body-only HMAC and never falls back from a bad signature to bearer", () => {
    expect(() => authenticateRoutineWebhook(new Headers({ "x-portal-signature": `sha256=${hmacSha256Hex(secret, raw)}` }), secret, raw, now)).toThrow("X-Portal-Timestamp");
    const headers = signed(); headers.set("authorization", `Bearer ${secret}`); headers.set("x-portal-signature", "bad");
    expect(() => authenticateRoutineWebhook(headers, secret, raw, now)).toThrow();
  });
  it("preserves bearer-only clients and rejects invalid credentials", () => {
    expect(authenticateRoutineWebhook(new Headers({ authorization: `Bearer ${secret}` }), secret, raw, now)).toBeUndefined();
    expect(() => authenticateRoutineWebhook(new Headers({ authorization: "Bearer invalid" }), secret, raw, now)).toThrow("Invalid signature");
  });
});
