import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/lib/auth/groups";

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
run("public sign-in companion", () => {
  let admin: Principal;
  let original: unknown;
  const assets: string[] = [];
  const manifest = { displayName: "Synthetic sign-in pet", description: "", spriteVersionNumber: 2 as const, credit: "Test · MIT" };
  beforeAll(async () => {
    const { db, schema } = await import("@/db");
    const { loadPrincipal } = await import("@/lib/auth/groups");
    const { getSetting } = await import("@/lib/settings");
    session.id = `login-pet-it-${Date.now()}`;
    await db.insert(schema.users).values({ id: session.id, upn: session.id, name: "Fixture", isAdmin: true, identityRealm: "local", authSource: "local" });
    admin = (await loadPrincipal(session.id))!;
    original = await getSetting("loginPet");
  });
  afterAll(async () => {
    session.status = 200;
    const { db, schema, pool } = await import("@/db");
    const { setSetting } = await import("@/lib/settings");
    await setSetting("loginPet", original as never);
    await db.delete(schema.auditLog).where(eq(schema.auditLog.actorId, session.id));
    if (assets.length) await db.delete(schema.petCatalog).where(inArray(schema.petCatalog.id, assets));
    await db.delete(schema.users).where(eq(schema.users.id, session.id));
    await pool.end();
  });

  it("refuses anonymous and non-admin changes", async () => {
    const { saveLoginPet } = await import("@/app/admin/actions");
    for (const status of [401, 403]) {
      session.status = status;
      await expect(saveLoginPet({ appearance: "moss", catalogId: null })).rejects.toMatchObject({ status });
    }
    session.status = 200;
  });

  it("serves only a published catalog pet an admin confirmed for public display, at the pinned revision", async () => {
    const { saveLoginPet } = await import("@/app/admin/actions");
    const { getPublicLoginPet } = await import("@/lib/branding/login-pet");
    const { GET } = await import("@/app/api/branding/login-pet/route");
    const { createCatalogPet, setCatalogStatus } = await import("@/lib/pets/catalog");
    const { db, schema } = await import("@/db");

    await saveLoginPet({ appearance: "moss", catalogId: null });
    expect(await getPublicLoginPet()).toEqual({ appearance: "moss", name: "Moss" });
    expect((await GET(new Request("http://localhost/api/branding/login-pet"))).status).toBe(404);

    const draft = await createCatalogPet(admin, manifest, Buffer.from("public-pixels"), "confirmed"); assets.push(draft.id);
    await expect(saveLoginPet({ appearance: "catalog", catalogId: draft.id }, "confirmed")).rejects.toThrow(/published/);
    await setCatalogStatus(admin, draft.id, "published", "confirmed");
    // Publishing covers signed-in users only; the public page needs its own confirmation.
    await expect(saveLoginPet({ appearance: "catalog", catalogId: draft.id })).rejects.toThrow(/publicly/);
    expect((await getPublicLoginPet()).appearance).toBe("moss");

    await saveLoginPet({ appearance: "catalog", catalogId: draft.id }, "confirmed");
    expect(await getPublicLoginPet()).toEqual({ appearance: "catalog", name: manifest.displayName, credit: manifest.credit, spriteVersionNumber: 2, spriteUrl: `/api/branding/login-pet?v=${draft.revision}`, spriteHdUrl: null });
    const response = await GET(new Request("http://localhost/api/branding/login-pet"));
    expect(response.status).toBe(200);
    // A pet without an HD rendition answers the 2× srcset candidate with a 404, so browsers use the v2 sheet.
    expect((await GET(new Request("http://localhost/api/branding/login-pet?size=2x"))).status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("public-pixels");
    const [entry] = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.actorId, session.id), eq(schema.auditLog.action, "settings.login_pet"), eq(schema.auditLog.target, draft.id)));
    expect(entry.details).toMatchObject({ revision: draft.revision, rights: "confirmed", audience: "public sign-in page" });

    // Unpublishing withdraws it from the public page; the selection returns with republication.
    await setCatalogStatus(admin, draft.id, "unpublished");
    expect(await getPublicLoginPet()).toEqual({ appearance: "off", name: "Portal bot" });
    expect((await GET(new Request("http://localhost/api/branding/login-pet"))).status).toBe(404);
    await setCatalogStatus(admin, draft.id, "published", "confirmed");
    expect((await getPublicLoginPet()).appearance).toBe("catalog");

    // A different revision than the one confirmed is never served.
    await db.update(schema.petCatalog).set({ revision: "replaced-revision" }).where(eq(schema.petCatalog.id, draft.id));
    expect((await getPublicLoginPet()).appearance).toBe("off");
    expect((await GET(new Request("http://localhost/api/branding/login-pet"))).status).toBe(404);
  });
});
