import { describe, expect, it } from "vitest";
import { decrypt, encrypt, hmacSha256Hex, safeEqual } from "@/lib/crypto";
import { chunkText } from "@/lib/files/extract";
import { hostAllowed, isPrivateAddress } from "@/lib/agent/tools/web";
import { isValidCron, nextCronRun } from "@/lib/routines";
import { groupByDate } from "@/components/sidebar/group-by-date";

describe("crypto", () => {
  it("round-trips and uses a random IV", () => {
    const a = encrypt("secret-key");
    expect(decrypt(a)).toBe("secret-key");
    expect(encrypt("secret-key")).not.toBe(a);
  });
  it("detects tampering", () => {
    const [v, kid, data] = encrypt("x").split(".");
    const a = Buffer.from(data, "base64");
    a[a.length - 1] ^= 1;
    expect(() => decrypt(`${v}.${kid}.${a.toString("base64")}`)).toThrow();
  });
  it("hmac + constant-time compare", () => {
    const sig = hmacSha256Hex("s", "body");
    expect(safeEqual(sig, hmacSha256Hex("s", "body"))).toBe(true);
    expect(safeEqual(sig, hmacSha256Hex("s", "body2"))).toBe(false);
  });
});

describe("SSRF guard helpers", () => {
  it("flags private addresses", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "192.168.1.5", "172.20.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.1.1.1"])
      expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "172.32.0.1", "2606:4700::1111"]) expect(isPrivateAddress(ip)).toBe(false);
  });
  it("matches allowlisted domains and subdomains only", () => {
    expect(hostAllowed("docs.corp.com", ["corp.com"])).toBe(true);
    expect(hostAllowed("corp.com", ["corp.com"])).toBe(true);
    expect(hostAllowed("evilcorp.com", ["corp.com"])).toBe(false);
  });
});

describe("routines", () => {
  it("computes the next run in a timezone", () => {
    const next = nextCronRun("0 8 * * 1-5", "Europe/London", new Date("2026-09-25T12:00:00Z")); // Friday
    expect(next.toISOString()).toBe("2026-09-28T07:00:00.000Z"); // Monday 08:00 BST
  });
  it("validates cron expressions", () => {
    expect(isValidCron("*/15 * * * *")).toBe(true);
    expect(isValidCron("not a cron")).toBe(false);
  });
});

describe("chunkText", () => {
  it("splits long text with bounded chunk size", () => {
    const text = Array.from({ length: 50 }, (_, i) => `Paragraph ${i} ` + "lorem ipsum ".repeat(30)).join("\n\n");
    const chunks = chunkText(text, 1000, 100);
    expect(chunks.length).toBeGreaterThan(5);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(1600);
  });
});

describe("history grouping", () => {
  it("buckets by recency like ChatGPT", () => {
    const now = new Date("2026-09-24T12:00:00");
    const mk = (d: string) => ({ id: d, title: d, pinned: false, folderId: null, botId: null, appId: null, source: "chat" as const, updatedAt: new Date(d).toISOString() });
    const groups = groupByDate([mk("2026-09-24T09:00:00"), mk("2026-09-23T09:00:00"), mk("2026-09-20T09:00:00"), mk("2026-09-01T09:00:00"), mk("2026-03-01T09:00:00"), mk("2025-03-01T09:00:00")], now);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "March", "2025"]);
  });
});
