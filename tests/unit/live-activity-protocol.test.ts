import { EventEmitter } from "node:events";
import { generateKeyPairSync, verify } from "node:crypto";
import type { ClientHttp2Session } from "node:http2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyResponse, contentFor, payloadFor, phaseFor, pushToken, registration } from "@/lib/live-activities/protocol";
import { apnsConfig, providerToken, sendActivity, type APNsConfig } from "@/lib/live-activities/apns";

const token = "ab".repeat(32);
afterEach(() => vi.unstubAllEnvs());
describe("ActivityKit privacy and lifecycle protocol", () => {
  it("validates opaque tokens and rejects malformed/oversized/odd tokens without echoing them", () => {
    expect(pushToken.parse(token.toUpperCase())).toBe(token);
    for (const bad of ["", "abc", "g".repeat(64), "a".repeat(63), "a".repeat(1025), ` ${token}`]) expect(pushToken.safeParse(bad).success).toBe(false);
    expect(pushToken.safeParse("ab".repeat(100)).success).toBe(true);
    expect(registration.safeParse({ activityId: "a", runId: "r", pushToken: token, tokenVersion: 1 }).success).toBe(true);
    for (const extra of [{ ownerId: "other" }, { environment: "production" }, { topic: "other" }, { tokenVersion: -1 }, { runId: "../admin" }])
      expect(registration.safeParse({ activityId: "a", runId: "r", pushToken: token, tokenVersion: 1, ...extra }).success).toBe(false);
  });
  it("maps server authority, approval attention, confirmed Stop and all terminal states", () => {
    expect(phaseFor("running", false)).toBe("working");
    expect(phaseFor("running", true)).toBe("working");
    expect(phaseFor("waiting", false)).toBe("attention");
    expect(phaseFor("waiting_tasks", false)).toBe("working");
    expect(phaseFor("queued", false)).toBe("queued");
    expect(phaseFor("succeeded", false)).toBe("completed");
    expect(phaseFor("cancelled", true)).toBe("cancelled");
    expect(phaseFor("interrupted", false)).toBe("failed");
    expect(phaseFor("failed", false)).toBe("failed");
  });
  it("exposes only generic status and includes stale/final dismissal times", () => {
    const state = contentFor({ status: "waiting", cancelRequestedAt: null, updatedAt: new Date(200_000), lastSeq: 9 });
    expect(state).toEqual({ phase: "attention", updatedAt: 200, revision: 9 });
    expect(payloadFor(state, 210)).toEqual({ aps: { timestamp: 210, event: "update", "content-state": state, "stale-date": 390 } });
    expect(payloadFor({ ...state, phase: "completed" }, 220).aps).toMatchObject({ event: "end", "dismissal-date": 520 });
    expect(JSON.stringify(payloadFor(state, 210))).not.toMatch(/title|message|error|body|alert|botId|userId/);
  });
  it("invalidates stale/bad tokens, retries rate limits/server errors, and keeps auth/config failures separate", () => {
    expect(classifyResponse(200, "")).toBe("delivered");
    expect(classifyResponse(410, "Unregistered")).toBe("invalid-token");
    expect(classifyResponse(400, "BadDeviceToken")).toBe("invalid-token");
    expect(classifyResponse(400, "DeviceTokenNotForTopic")).toBe("invalid-token");
    expect(classifyResponse(429, "TooManyRequests")).toBe("retry");
    expect(classifyResponse(503, "ServiceUnavailable")).toBe("retry");
    expect(classifyResponse(403, "InvalidProviderToken")).toBe("configuration-error");
  });
});

// Synthetic in-memory signing key; no Apple account, real credential, or external connection.
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const config: APNsConfig = { teamId: "TESTTEAM00", keyId: "TESTKEY000", bundleId: "test.collectiveui", environment: "sandbox", key: privateKey };
describe("documented APNs HTTP/2 delivery", () => {
  it("is off by default and reports malformed configuration without exposing key material", () => {
    vi.stubEnv("LIVE_ACTIVITIES_ENABLED", "false");
    expect(apnsConfig()).toBeNull();
    vi.stubEnv("LIVE_ACTIVITIES_ENABLED", "true");
    vi.stubEnv("APNS_TEAM_ID", "private-do-not-log");
    expect(() => apnsConfig()).toThrow("Live Activity APNs configuration is incomplete");
  });
  it("signs ES256 JWTs with a bounded refresh interval", () => {
    const jwt = providerToken(config, 100);
    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "ES256", kid: config.keyId });
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toEqual({ iss: config.teamId, iat: 100 });
    expect(verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"))).toBe(true);
    expect(providerToken(config, 120)).toBe(jwt);
    expect(providerToken(config, 3200)).not.toBe(jwt);
  });
  it("uses Apple's fixed sandbox host, liveactivity topic/type, low priority and redacted content", async () => {
    let headers: Record<string, unknown> = {}; let payload = ""; let host = "";
    const req = new EventEmitter() as EventEmitter & { end: (body: string) => void };
    req.end = (body) => { payload = body; queueMicrotask(() => { req.emit("response", { ":status": 200 }); req.emit("end"); }); };
    const client = new EventEmitter() as EventEmitter & { request: (h: typeof headers) => typeof req; destroy: () => void };
    client.request = (h) => { headers = h; return req; }; client.destroy = vi.fn();
    const result = await sendActivity(config, token, { phase: "working", updatedAt: 100, revision: 1 }, 101,
      (origin) => { host = origin; return client as unknown as ClientHttp2Session; });
    expect(result).toBe("delivered");
    expect(host).toBe("https://api.sandbox.push.apple.com");
    expect(headers).toMatchObject({ ":method": "POST", ":path": `/3/device/${token}`, "apns-topic": "test.collectiveui.push-type.liveactivity",
      "apns-push-type": "liveactivity", "apns-priority": "5", "apns-expiration": "281" });
    expect(JSON.parse(payload).aps.event).toBe("update");
    expect(client.destroy).toHaveBeenCalledOnce();
  });
  it("never dials for malformed tokens and handles network errors without secret-bearing exception text", async () => {
    const dial = vi.fn(() => { throw new Error(`secret ${token}`); });
    expect(await sendActivity(config, "bad", { phase: "working", updatedAt: 100, revision: 0 }, 100, dial)).toBe("invalid-token");
    expect(dial).not.toHaveBeenCalled();
    expect(await sendActivity(config, token, { phase: "failed", updatedAt: 100, revision: 0 }, 100, dial)).toBe("retry");
  });
});
