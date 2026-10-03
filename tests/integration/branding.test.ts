import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const session = vi.hoisted(() => ({ id: "", status: 200 }));
vi.mock("@/lib/session", async () => {
  const { HttpError } = await import("@/lib/authz");
  return {
    requireAdmin: async () => {
      if (session.status !== 200) throw new HttpError(session.status, "Denied");
      return { user: { id: session.id }, isAdmin: true };
    },
    errorResponse: (err: unknown) => err instanceof HttpError ? Response.json({ error: err.message }, { status: err.status }) : Response.json({ error: "Internal error" }, { status: 500 }),
  };
});
const run = process.env.DATABASE_URL ? describe : describe.skip;
run("branding storage and routes", () => {
  let originalBranding: unknown;
  let originalLogo: unknown;
  let png: Buffer;
  const url = "http://localhost:3000/api/admin/branding/logo";
  const request = (method: string, body?: Buffer, origin = "http://localhost:3000") => new Request(url, { method, headers: { origin, "Content-Type": "image/png" }, body: body ? new Uint8Array(body) : undefined });
  beforeAll(async () => {
    const { db } = await import("@/db");
    const { users } = await import("@/db/schema");
    const { getSetting, setSetting } = await import("@/lib/settings");
    session.id = `branding-it-${Date.now()}`;
    await db.insert(users).values({ id: session.id, upn: `${session.id}@corp.local`, name: "Brand Admin", authSource: "ldap" });
    originalBranding = await getSetting("branding");
    originalLogo = await getSetting("brandingLogo");
    await setSetting("brandingLogo", { id: null });
    png = await sharp({ create: { width: 30, height: 20, channels: 4, background: "#80ddbb" } }).png().toBuffer();
  });
  afterAll(async () => {
    session.status = 200;
    const { replaceLogo } = await import("@/lib/branding/store");
    const { setSetting } = await import("@/lib/settings");
    const { db, pool } = await import("@/db");
    const { users, auditLog } = await import("@/db/schema");
    await replaceLogo(session.id, null);
    await setSetting("branding", originalBranding as never);
    await setSetting("brandingLogo", originalLogo as never);
    await db.delete(auditLog).where(eq(auditLog.actorId, session.id));
    await db.delete(users).where(eq(users.id, session.id));
    await pool.end();
  });
  it("refuses anonymous and non-admin uploads/removals before processing input", async () => {
    const { POST, DELETE } = await import("@/app/api/admin/branding/logo/route");
    const { saveBranding } = await import("@/app/admin/actions");
    for (const status of [401, 403]) {
      session.status = status;
      await expect(saveBranding({ appName: "Denied", logoEmoji: "", welcomeText: "" })).rejects.toMatchObject({ status });
      expect((await POST(request("POST", png))).status).toBe(status);
      expect((await DELETE(request("DELETE"))).status).toBe(status);
    }
    session.status = 200;
    expect((await POST(request("POST", png, "https://evil.example"))).status).toBe(403);
    expect((await DELETE(request("DELETE", undefined, "https://evil.example"))).status).toBe(403);
  });
  it("uploads, persists, replaces, rejects bad replacements, serves only the active PNG, and removes", async () => {
    const { POST, DELETE } = await import("@/app/api/admin/branding/logo/route");
    const { GET } = await import("@/app/api/branding/logo/route");
    const { getSetting } = await import("@/lib/settings");
    const { storage } = await import("@/lib/files/storage");
    const { logoKey, getPublicBranding } = await import("@/lib/branding/store");
    expect((await GET()).status).toBe(404);
    const uploaded = await POST(request("POST", png));
    expect(uploaded.status).toBe(200);
    const first = (await getSetting("brandingLogo")).id!;
    expect(await storage().get(logoKey(first))).toBeInstanceOf(Buffer);
    const publicImage = await GET();
    expect(publicImage.headers.get("content-type")).toBe("image/png");
    expect(publicImage.headers.get("cache-control")).toBe("no-store");
    expect(publicImage.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await sharp(Buffer.from(await publicImage.arrayBuffer())).metadata()).format).toBe("png");
    expect(Object.keys(await getPublicBranding()).sort()).toEqual(["appName", "loginDescription", "loginHeadline", "logoEmoji", "logoUrl", "welcomeText"]);
    expect((await POST(request("POST", Buffer.from("<svg/>")))).status).toBe(415);
    expect((await getSetting("brandingLogo")).id).toBe(first);
    const { saveBranding } = await import("@/app/admin/actions");
    await saveBranding({ appName: "Test portal", logoEmoji: "🌱", welcomeText: "Hi", loginHeadline: "Together" });
    expect((await getSetting("brandingLogo")).id).toBe(first);
    expect((await POST(request("POST", png))).status).toBe(200);
    const second = (await getSetting("brandingLogo")).id!;
    expect(second).not.toBe(first);
    await expect(storage().get(logoKey(first))).rejects.toThrow();
    expect((await DELETE(request("DELETE"))).status).toBe(200);
    expect((await GET()).status).toBe(404);
    await expect(storage().get(logoKey(second))).rejects.toThrow();
    expect((await getPublicBranding()).logoUrl).toBeNull();
    expect((await DELETE(request("DELETE"))).status).toBe(200);
  });
  it("rolls back failed writes, and serializes concurrent swaps without leaving old blobs", async () => {
    const { replaceLogo, logoKey } = await import("@/lib/branding/store");
    const { getSetting } = await import("@/lib/settings");
    const { storage } = await import("@/lib/files/storage");
    await replaceLogo(session.id, png);
    const original = (await getSetting("brandingLogo")).id;
    const put = vi.spyOn(storage(), "put").mockRejectedValueOnce(new Error("disk full"));
    await expect(replaceLogo(session.id, png)).rejects.toThrow("disk full");
    put.mockRestore();
    expect((await getSetting("brandingLogo")).id).toBe(original);
    await expect(replaceLogo("nonexistent-actor", png)).rejects.toThrow();
    expect((await getSetting("brandingLogo")).id).toBe(original);
    const urls = await Promise.all([replaceLogo(session.id, png), replaceLogo(session.id, png), replaceLogo(session.id, png)]);
    const active = (await getSetting("brandingLogo")).id!;
    for (const url of urls) {
      const id = new URL(url!, "http://localhost").searchParams.get("v")!;
      if (id === active) expect(await storage().get(logoKey(id))).toBeInstanceOf(Buffer);
      else await expect(storage().get(logoKey(id))).rejects.toThrow();
    }
  });
});
