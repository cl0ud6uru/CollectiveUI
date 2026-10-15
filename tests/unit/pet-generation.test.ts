import { readFileSync, readdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Principal } from "@/lib/auth/groups";

const fixture = vi.hoisted(() => ({ client: null as PGlite | null }));
vi.mock("server-only", () => ({}));
vi.mock("@/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@/db/schema");
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client, { schema }), schema };
});

import { db, schema } from "@/db";
import { loadPrincipal } from "@/lib/auth/groups";
import { setSetting } from "@/lib/settings";
import { generatePetImage } from "@/lib/llm/providers/openai";
import { PET_ANIMATIONS } from "@/lib/pets/atlas";
import { approvePetAppearance, consentPetBuild, createPetGenerationJob, generateAppearance, getPetGenerationJob, retryPetGenerationSlot, runPetGenerationSlot, savePetGenerationPreview } from "@/lib/pets/generation";

let admin: Principal;
const configure = async () => {
  await db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.id, "admin"));
  admin = (await loadPrincipal("admin"))!;
  await db.insert(schema.providerConnections).values({ id: "official-openai", name: "Fixture OpenAI", provider: "openai", baseUrl: null,
    credentialEnc: "fixture-encrypted-secret", enabled: true, createdBy: "admin" });
  await setSetting("petGeneration", { enabled: true, providerConnectionId: "official-openai", modelId: "gpt-image-2.5-sunburst", access: "selected", allowedGroupIds: [], allowedUpns: [] });
};

beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const file of readdirSync("src/db/migrations").filter(name => name.endsWith(".sql")).sort()) {
    await fixture.client!.exec(readFileSync(`src/db/migrations/${file}`, "utf8").replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]"));
  }
}, 45000);
beforeEach(async () => {
  await fixture.client!.exec("TRUNCATE users, ai_apps, settings CASCADE");
  await db.insert(schema.users).values([
    { id: "admin", name: "Admin", upn: "admin@fixture.invalid", authSource: "ldap" },
    { id: "member", name: "Member", upn: "member@fixture.invalid", authSource: "ldap" },
  ]);
  await configure();
});
afterAll(async () => { await fixture.client?.close(); });

describe("durable admin pet generation", () => {
  it("keeps generation unavailable when its default-off setting is disabled", async () => {
    await setSetting("petGeneration", { enabled: false, providerConnectionId: null, modelId: "gpt-image-2.5-sunburst", access: "selected", allowedGroupIds: [], allowedUpns: [] });
    await expect(createPetGenerationJob(admin, { displayName: "Fixture pet", description: "A blue helper character." })).rejects.toMatchObject({ status: 409 });
  });

  it("requires staged consent, never replays a slot and validates a complete v2 preview before draft save", async () => {
    const generatedImage = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 33, g: 128, b: 200, alpha: 1 } } }).png().toBuffer();
    const generator = vi.fn(async () => ({ image: generatedImage, inputTokens: 10, outputTokens: 20 })) as unknown as typeof generatePetImage;
    const job = await createPetGenerationJob(admin, { displayName: "Fixture pet", description: "A blue helper character." });
    await expect(generateAppearance(admin, job.id, false, undefined, generator)).rejects.toMatchObject({ status: 400 });
    expect(generator).not.toHaveBeenCalled();
    await expect(getPetGenerationJob((await loadPrincipal("member"))!, job.id)).rejects.toMatchObject({ status: 403 });
    await expect(generateAppearance(admin, job.id, true, undefined, generator)).resolves.toEqual({ state: "succeeded" });
    await expect(generateAppearance(admin, job.id, true, undefined, generator)).rejects.toMatchObject({ status: 409 });
    await approvePetAppearance(admin, job.id);
    await expect(consentPetBuild(admin, job.id, false)).rejects.toMatchObject({ status: 400 });
    await expect(consentPetBuild(admin, job.id, true)).resolves.toMatchObject({ requests: 10 });
    await expect(runPetGenerationSlot(admin, job.id, PET_ANIMATIONS[0].name, undefined, generator)).resolves.toMatchObject({ status: "succeeded", costMicros: null });
    await expect(runPetGenerationSlot(admin, job.id, PET_ANIMATIONS[0].name, undefined, generator)).rejects.toMatchObject({ status: 409 });
    for (const key of [...PET_ANIMATIONS.slice(1).map(state => state.name), "directions"]) await runPetGenerationSlot(admin, job.id, key, undefined, generator);
    const receipt = await getPetGenerationJob(admin, job.id);
    expect(receipt.hasPreview).toBe(true);
    expect(receipt.slots).toHaveLength(11);
    expect(receipt.slots.every(slot => slot.status === "succeeded" && slot.inputTokens === 10 && slot.outputTokens === 20 && slot.costMicros === null)).toBe(true);
    expect(receipt.slots.every(slot => slot.consentVersion === 1 && slot.consentSummary.length > 20)).toBe(true);
    await expect(savePetGenerationPreview(admin, job.id, "unconfirmed")).rejects.toMatchObject({ status: 400 });
    expect((await savePetGenerationPreview(admin, job.id, "confirmed")).status).toBe("draft");
    expect(generator).toHaveBeenCalledTimes(11);
    await expect(savePetGenerationPreview(admin, job.id, "confirmed")).rejects.toMatchObject({ status: 409 });
  });

  it("records an ambiguous lost reply as uncertain and only retries with a new consent receipt", async () => {
    const generatedImage = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 33, g: 128, b: 200, alpha: 1 } } }).png().toBuffer();
    const job = await createPetGenerationJob(admin, { displayName: "Fixture pet", description: "A blue helper character." });
    await generateAppearance(admin, job.id, true, undefined, vi.fn(async () => ({ image: generatedImage, inputTokens: 1, outputTokens: 1 })) as unknown as typeof generatePetImage);
    await approvePetAppearance(admin, job.id);
    await consentPetBuild(admin, job.id, true);
    const lostReply = vi.fn(async () => { throw new Error("connection closed after provider admission"); }) as unknown as typeof generatePetImage;
    await expect(runPetGenerationSlot(admin, job.id, "idle", undefined, lostReply)).rejects.toMatchObject({ status: 502 });
    await expect(runPetGenerationSlot(admin, job.id, "idle", undefined, lostReply)).rejects.toMatchObject({ status: 409 });
    const receipt = await getPetGenerationJob(admin, job.id);
    expect(receipt.slots.find(slot => slot.slotKey === "idle")).toMatchObject({ slotKey: "idle", attempt: 1, status: "uncertain", errorCode: "provider_uncertain" });
    await expect(retryPetGenerationSlot(admin, job.id, "idle", false)).rejects.toMatchObject({ status: 400 });
    expect(await retryPetGenerationSlot(admin, job.id, "idle", true)).toEqual({ status: "queued", attempt: 2 });
    expect((await db.select().from(schema.petGenerationSlots).where(eq(schema.petGenerationSlots.jobId, job.id))).find(slot => slot.slotKey === "idle" && slot.attempt === 2)?.consentSummary).toContain("one additional paid image request");
    await expect(runPetGenerationSlot(admin, job.id, "idle", undefined, vi.fn(async () => ({ image: generatedImage })) as unknown as typeof generatePetImage)).resolves.toMatchObject({ status: "succeeded" });
    expect((await getPetGenerationJob(admin, job.id)).slots.find(slot => slot.slotKey === "idle" && slot.isLatest)).toMatchObject({ slotKey: "idle", attempt: 2, status: "succeeded" });
  });

  it("rejects an atlas with empty cells and only exposes a preview after a paid retry fills the failed state", async () => {
    const generatedImage = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 33, g: 128, b: 200, alpha: 1 } } }).png().toBuffer();
    const blankImage = await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const job = await createPetGenerationJob(admin, { displayName: "Fixture pet", description: "A blue helper character." });
    await generateAppearance(admin, job.id, true, undefined, vi.fn(async () => ({ image: generatedImage })) as unknown as typeof generatePetImage);
    await approvePetAppearance(admin, job.id);
    await consentPetBuild(admin, job.id, true);
    const generator = vi.fn(async (input: { prompt: string }) => ({ image: input.prompt.includes("animation frames") && input.prompt.includes("idle") ? blankImage : generatedImage, inputTokens: 2, outputTokens: 3 })) as unknown as typeof generatePetImage;
    for (const key of [...PET_ANIMATIONS.map(state => state.name), "directions"].slice(0, -1)) await runPetGenerationSlot(admin, job.id, key, undefined, generator);
    await expect(runPetGenerationSlot(admin, job.id, "directions", undefined, generator)).rejects.toMatchObject({ status: 400 });
    expect((await getPetGenerationJob(admin, job.id)).hasPreview).toBe(false);
    expect((await getPetGenerationJob(admin, job.id)).slots.find(slot => slot.slotKey === "idle" && slot.isLatest)).toMatchObject({ status: "failed", errorCode: "atlas_validation" });
    await retryPetGenerationSlot(admin, job.id, "idle", true);
    await runPetGenerationSlot(admin, job.id, "idle", undefined, vi.fn(async () => ({ image: generatedImage })) as unknown as typeof generatePetImage);
    expect((await getPetGenerationJob(admin, job.id)).hasPreview).toBe(true);
  });

  it("marks stale running receipts uncertain after a simulated process restart without replaying them", async () => {
    const job = await createPetGenerationJob(admin, { displayName: "Fixture pet", description: "A blue helper character." });
    const old = new Date(Date.now() - 16 * 60 * 1000);
    await db.update(schema.petGenerationJobs).set({ appearanceState: "running", appearanceAttempt: 1, appearanceConsentAt: old }).where(eq(schema.petGenerationJobs.id, job.id));
    await db.insert(schema.petGenerationSlots).values({ jobId: job.id, slotKey: "appearance", attempt: 1, prompt: "fixture", consentVersion: 1, consentSummary: "synthetic consent receipt", status: "running", consentAt: old, startedAt: old, updatedAt: old });
    const status = await getPetGenerationJob(admin, job.id);
    expect(status.appearanceState).toBe("uncertain");
    expect(status.slots[0]).toMatchObject({ slotKey: "appearance", status: "uncertain", errorCode: "stale_after_restart" });
  });
});
