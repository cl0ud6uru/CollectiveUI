import "server-only";
import { and, desc, eq, lt } from "drizzle-orm";
import sharp, { type OverlayOptions } from "sharp";
import { db, type Tx } from "@/db";
import { auditLog, botPets, petCatalog, petGenerationJobs, petGenerationSlots, providerConnections } from "@/db/schema";
import { loadPrincipal, type Principal } from "@/lib/auth/groups";
import { HttpError, listAccessibleBots } from "@/lib/authz";
import { assertFreshPetAdmin, assertPersonalPetAllowed, lockPetViewer } from "./authorization";
import { assertFreshPetGenerationAccess, userMayGeneratePet } from "./generation-access";
import { getSetting, type PetGenerationSettings } from "@/lib/settings";
import { OPENAI_DEFAULT_BASE_URL, generatePetImage } from "@/lib/llm/providers/openai";
import { PET_ANIMATIONS, PET_DIRECTIONS } from "./atlas";
import { normalizePetSprite, validateV2Cells } from "./import";
import type { PetManifest } from "./shared";
import { newId } from "@/lib/ids";

export const PET_IMAGE_MODEL = "gpt-image-2.5-sunburst" as const;
const IMAGE_LIMIT = 4 * 1024 * 1024;
const animationKeys = PET_ANIMATIONS.map(state => state.name);
const slotKeys = [...animationKeys, "directions"];

type ImageGenerator = typeof generatePetImage;
type SlotKey = typeof slotKeys[number];

async function configuredConnection() {
  const config = await getSetting("petGeneration");
  if (!config.enabled || !config.providerConnectionId || config.modelId !== PET_IMAGE_MODEL) {
    throw new HttpError(409, "Pet image generation is disabled or not configured.");
  }
  const [connection] = await db.select().from(providerConnections).where(eq(providerConnections.id, config.providerConnectionId));
  if (!connection || !connection.enabled || connection.provider !== "openai" ||
    (connection.baseUrl !== null && connection.baseUrl !== OPENAI_DEFAULT_BASE_URL)) {
    throw new HttpError(409, "Select an enabled saved OpenAI connection that uses the official API endpoint.");
  }
  return { config, connection };
}

async function currentConnectionForJob(job: typeof petGenerationJobs.$inferSelect) {
  const { config, connection } = await configuredConnection();
  if (config.providerConnectionId !== job.providerConnectionId || job.modelId !== PET_IMAGE_MODEL) throw new HttpError(409, "The selected provider or fixed model changed after this request was created.");
  return connection;
}

export async function normalizePetReference(source: Buffer) {
  if (!source.length || source.length > 1024 * 1024) throw new HttpError(413, "Reference images must be 1 MB or smaller.");
  try {
    const metadata = await sharp(source, { limitInputPixels: 2048 * 2048, failOn: "warning" }).metadata();
    if (!metadata.format || !["png", "jpeg", "webp"].includes(metadata.format) || (metadata.pages ?? 1) !== 1) throw new Error("unsupported");
    const output = await sharp(source, { limitInputPixels: 2048 * 2048, failOn: "warning" }).timeout({ seconds: 5 })
      .rotate().resize(1024, 1024, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    if (output.length > 1024 * 1024) throw new Error("large");
    return output;
  } catch { throw new HttpError(400, "Choose one undamaged, static PNG, JPEG, or WebP reference image."); }
}

export async function createPetGenerationJob(p: Principal, input: { displayName: string; description: string; credit?: string; reference?: Buffer }) {
  await assertFreshPetGenerationAccess(p, db, true);
  const { connection } = await configuredConnection();
  const displayName = input.displayName.trim();
  const description = input.description.trim();
  const credit = (input.credit ?? "AI generated with OpenAI").trim();
  if (!displayName || displayName.length > 80 || (!description && !input.reference) || description.length > 1000 || credit.length > 240 ||
    /[\u0000-\u001f\u007f]/.test(displayName + description + credit)) throw new HttpError(400, "Provide plain text for the name, description and credit, within their listed limits.");
  return db.transaction(async tx => {
    await assertFreshPetGenerationAccess(p, tx, true);
    const [job] = await tx.insert(petGenerationJobs).values({ ownerId: p.user.id, providerConnectionId: connection.id, modelId: PET_IMAGE_MODEL,
      displayName, description, credit, reference: input.reference }).returning({ id: petGenerationJobs.id, appearanceState: petGenerationJobs.appearanceState });
    return job;
  });
}

export async function listPetGenerationJobs(p: Principal) {
  await assertFreshPetGenerationAccess(p);
  return db.select({ id: petGenerationJobs.id, displayName: petGenerationJobs.displayName, description: petGenerationJobs.description,
    appearanceState: petGenerationJobs.appearanceState, appearanceApprovedAt: petGenerationJobs.appearanceApprovedAt,
    buildConsentAt: petGenerationJobs.buildConsentAt, catalogPetId: petGenerationJobs.catalogPetId, createdAt: petGenerationJobs.createdAt,
  }).from(petGenerationJobs).where(eq(petGenerationJobs.ownerId, p.user.id)).orderBy(desc(petGenerationJobs.createdAt)).limit(25);
}

async function ownedJob(p: Principal, id: string) {
  await assertFreshPetGenerationAccess(p);
  const [job] = await db.select().from(petGenerationJobs).where(and(eq(petGenerationJobs.id, id), eq(petGenerationJobs.ownerId, p.user.id)));
  if (!job) throw new HttpError(404, "Pet generation draft not found.");
  return job;
}

export async function generateAppearance(p: Principal, id: string, consent: boolean, abortSignal?: AbortSignal, generator: ImageGenerator = generatePetImage, retry = false, beforeDispatch?: () => Promise<void>) {
  if (consent !== true) throw new HttpError(400, "Appearance generation requires explicit cost consent.");
  const { job, attemptId, attempt, prompt } = await db.transaction(async tx => {
    const [job] = await tx.select().from(petGenerationJobs).where(and(eq(petGenerationJobs.id, id), eq(petGenerationJobs.ownerId, p.user.id))).for("update");
    if (!job) throw new HttpError(404, "Pet generation draft not found.");
    await assertFreshPetGenerationAccess(p, tx, true);
    const allowed = retry ? ["failed", "uncertain"] : ["needs_consent"];
    if (!allowed.includes(job.appearanceState)) throw new HttpError(409, "Appearance generation has already started or needs a different action. Refresh this draft.");
    const [previous] = await tx.select({ attempt: petGenerationSlots.attempt, status: petGenerationSlots.status }).from(petGenerationSlots)
      .where(and(eq(petGenerationSlots.jobId, id), eq(petGenerationSlots.slotKey, "appearance"))).orderBy(desc(petGenerationSlots.attempt)).limit(1);
    if (retry && (!previous || previous.attempt >= 3 || !["failed", "uncertain"].includes(previous.status))) throw new HttpError(409, "Only failed or uncertain appearance requests can be retried, up to three attempts total.");
    const now = new Date();
    const attempt = (previous?.attempt ?? 0) + 1;
    const prompt = appearancePrompt(job);
    const consentSummary = retry
      ? "appearance-retry-v1: one additional paid image request; prior request may also have incurred cost; variable token usage; no fixed quote or hard cap"
      : "appearance-v1: one image request at published image input/output and separate text input rates; variable token usage; no fixed quote or hard cap";
    const [receipt] = await tx.insert(petGenerationSlots).values({ jobId: id, slotKey: "appearance", attempt, prompt, consentVersion: 1,
      consentSummary, status: "running", consentAt: now, startedAt: now }).returning({ id: petGenerationSlots.id });
    await tx.update(petGenerationJobs).set({ appearanceState: "running", appearanceAttempt: attempt, appearanceConsentAt: now, appearanceErrorCode: null, updatedAt: now }).where(eq(petGenerationJobs.id, id));
    return { job, attemptId: receipt.id, attempt, prompt };
  });
  let observedUsage: { inputTokens: number | null; outputTokens: number | null } | null = null;
  try {
    const connection = await currentConnectionForJob(job);
    await beforeDispatch?.();
    await assertFreshPetGenerationAccess(p, db, true);
    const result = await generator({ connection, modelId: PET_IMAGE_MODEL,
      prompt,
      ...(job.reference ? { reference: job.reference } : {}), ...(abortSignal ? { abortSignal } : {}),
    });
    observedUsage = { inputTokens: result.inputTokens ?? null, outputTokens: result.outputTokens ?? null };
    const appearance = await normalizeImage(result.image);
    await db.transaction(async tx => {
      const [done] = await tx.update(petGenerationJobs).set({ appearance, appearanceState: "succeeded", appearanceInputTokens: result.inputTokens ?? null,
        appearanceOutputTokens: result.outputTokens ?? null, appearanceErrorCode: null, updatedAt: new Date() })
        .where(and(eq(petGenerationJobs.id, id), eq(petGenerationJobs.ownerId, p.user.id), eq(petGenerationJobs.appearanceState, "running"), eq(petGenerationJobs.appearanceAttempt, attempt))).returning({ id: petGenerationJobs.id });
      if (!done) throw new Error("appearance_claim_lost");
      const [receipt] = await tx.update(petGenerationSlots).set({ status: "succeeded", image: appearance, inputTokens: result.inputTokens ?? null, outputTokens: result.outputTokens ?? null,
        finishedAt: new Date(), updatedAt: new Date() }).where(and(eq(petGenerationSlots.id, attemptId), eq(petGenerationSlots.status, "running"))).returning({ id: petGenerationSlots.id });
      if (!receipt) throw new Error("appearance_receipt_lost");
    });
    return { state: "succeeded" as const };
  } catch (error) {
    const invalidOutput = error instanceof Error && error.message === "invalid_image_output";
    const knownPreflightFailure = error instanceof HttpError;
    const authorizationFailure = error instanceof HttpError && error.status === 403;
    const status = invalidOutput || knownPreflightFailure ? "failed" : "uncertain";
    await db.transaction(async tx => {
      await tx.update(petGenerationJobs).set({ appearanceState: status,
      appearanceInputTokens: observedUsage?.inputTokens ?? null, appearanceOutputTokens: observedUsage?.outputTokens ?? null,
      appearanceErrorCode: invalidOutput ? "invalid_output" : authorizationFailure ? "authorization_revoked" : knownPreflightFailure ? "connection_unavailable" : "provider_uncertain", updatedAt: new Date() })
        .where(and(eq(petGenerationJobs.id, id), eq(petGenerationJobs.ownerId, p.user.id), eq(petGenerationJobs.appearanceState, "running"), eq(petGenerationJobs.appearanceAttempt, attempt)));
      await tx.update(petGenerationSlots).set({ status, inputTokens: observedUsage?.inputTokens ?? null, outputTokens: observedUsage?.outputTokens ?? null,
        errorCode: invalidOutput ? "invalid_output" : authorizationFailure ? "authorization_revoked" : knownPreflightFailure ? "connection_unavailable" : "provider_uncertain", finishedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(petGenerationSlots.id, attemptId), eq(petGenerationSlots.status, "running")));
    });
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "The provider response is uncertain. This request will not be replayed; inspect the receipt before choosing a separately consented retry.");
  }
}

async function normalizeImage(image: Buffer) {
  if (!image.length || image.length > IMAGE_LIMIT) throw new Error("image_output_size");
  try {
    const metadata = await sharp(image, { limitInputPixels: 1024 * 1024, failOn: "warning" }).metadata();
    if (metadata.format !== "png" || metadata.width !== 1024 || metadata.height !== 1024 || (metadata.pages ?? 1) !== 1) throw new Error("shape");
    return await sharp(image, { limitInputPixels: 1024 * 1024, failOn: "warning" }).timeout({ seconds: 5 }).png().toBuffer();
  } catch { throw new Error("invalid_image_output"); }
}

export async function approvePetAppearance(p: Principal, id: string) {
  return db.transaction(async tx => {
    const [job] = await tx.select({ id: petGenerationJobs.id }).from(petGenerationJobs)
      .where(and(eq(petGenerationJobs.id, id), eq(petGenerationJobs.ownerId, p.user.id))).for("update");
    if (!job) throw new HttpError(404, "Pet generation draft not found.");
    await assertFreshPetGenerationAccess(p, tx);
    const [row] = await tx.update(petGenerationJobs).set({ appearanceState: "approved", appearanceApprovedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(petGenerationJobs.id, id), eq(petGenerationJobs.ownerId, p.user.id), eq(petGenerationJobs.appearanceState, "succeeded"))).returning({ id: petGenerationJobs.id });
    if (!row) throw new HttpError(409, "Generate and inspect the appearance before approving it.");
    return { state: "approved" as const };
  });
}

export async function consentPetBuild(p: Principal, id: string, consent: boolean) {
  if (consent !== true) throw new HttpError(400, "Creating the nine animation rows and sixteen directions requires explicit consent to ten additional image requests at the published model rates; actual cost varies with token usage and has no fixed quote or hard cap.");
  const job = await ownedJob(p, id);
  if (job.appearanceState !== "approved" || !job.appearanceApprovedAt) throw new HttpError(409, "Approve the appearance before authorizing sprite generation.");
  await currentConnectionForJob(job);
  return db.transaction(async tx => {
    const [locked] = await tx.select().from(petGenerationJobs).where(and(eq(petGenerationJobs.id, id), eq(petGenerationJobs.ownerId, p.user.id))).for("update");
    if (!locked || locked.appearanceState !== "approved" || locked.buildConsentAt) throw new HttpError(409, "Sprite generation is already authorized or the appearance is not approved.");
    await assertFreshPetGenerationAccess(p, tx, true);
    const now = new Date();
    const consentSummary = "sprite-build-v1: ten separate image requests (nine animation grids, one 16-direction grid); published variable image/text token rates; no fixed quote or hard cap";
    await tx.insert(petGenerationSlots).values(slotKeys.map(slotKey => ({ jobId: id, slotKey, attempt: 1, prompt: slotPrompt(locked, slotKey),
      consentVersion: 1, consentSummary, status: "queued", consentAt: now })));
    await tx.update(petGenerationJobs).set({ buildConsentAt: now, updatedAt: now }).where(eq(petGenerationJobs.id, id));
    return { slots: slotKeys, requests: slotKeys.length };
  });
}

function slotPrompt(job: typeof petGenerationJobs.$inferSelect, key: SlotKey) {
  const state = PET_ANIMATIONS.find(row => row.name === key);
  const brief = job.description ? `Description: ${job.description}` : "Follow the approved appearance exactly.";
  return key === "directions"
    ? `Use the attached approved character as an exact character reference. Create a transparent 4 by 4 contact sheet of the same full-body character at 16 evenly spaced viewing angles around it, starting from above/front and rotating clockwise. One centered figure per equal square cell, consistent scale, no gutters, labels, shadows, or background. ${brief}`
    : `Use the attached approved character as an exact character reference. Create a transparent 4 by 2 contact sheet of eight consecutive ${state!.label.toLowerCase()} animation frames for the same character. One centered full-body figure per equal cell, consistent scale, no gutters, labels, shadows, or background. ${brief}`;
}

function appearancePrompt(job: typeof petGenerationJobs.$inferSelect) {
  const brief = job.description ? `Appearance brief: ${job.description}` : "Use the supplied reference image as the appearance brief and create an original character based on it.";
  return `Create one original, friendly animated assistant pet character concept as a full-body front view. Transparent background, centered with clear margins, no text, no props. ${brief}`;
}

export async function runPetGenerationSlot(p: Principal, id: string, key: string, abortSignal?: AbortSignal, generator: ImageGenerator = generatePetImage, beforeDispatch?: () => Promise<void>) {
  if (!slotKeys.includes(key)) throw new HttpError(400, "Unknown sprite slot.");
  const job = await ownedJob(p, id);
  if (!job.buildConsentAt || job.appearanceState !== "approved" || !job.appearance) throw new HttpError(409, "Approve the appearance and consent to sprite costs before generation.");
  await currentConnectionForJob(job);
  const { slot, currentJob } = await db.transaction(async tx => {
    const [currentJob] = await tx.select().from(petGenerationJobs).where(and(eq(petGenerationJobs.id, id), eq(petGenerationJobs.ownerId, p.user.id))).for("update");
    if (!currentJob || !currentJob.buildConsentAt || currentJob.appearanceState !== "approved" || !currentJob.appearance) throw new HttpError(409, "Approve the appearance and consent to sprite costs before generation.");
    await assertFreshPetGenerationAccess(p, tx, true);
    const [slot] = await tx.select().from(petGenerationSlots).where(and(eq(petGenerationSlots.jobId, id), eq(petGenerationSlots.slotKey, key))).orderBy(desc(petGenerationSlots.attempt)).limit(1).for("update");
    if (!slot || slot.status !== "queued") throw new HttpError(409, "This slot has no queued request. Running or uncertain requests are never replayed automatically.");
    const [claimed] = await tx.update(petGenerationSlots).set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(petGenerationSlots.id, slot.id), eq(petGenerationSlots.status, "queued"))).returning({ id: petGenerationSlots.id });
    if (!claimed) throw new HttpError(409, "This slot request is already running or complete.");
    return { slot, currentJob };
  });
  let observedUsage: { inputTokens: number | null; outputTokens: number | null } | null = null;
  try {
    const dispatchConnection = await currentConnectionForJob(currentJob);
    await beforeDispatch?.();
    await assertFreshPetGenerationAccess(p, db, true);
    const output = await generator({ connection: dispatchConnection, modelId: PET_IMAGE_MODEL, prompt: slot.prompt, reference: currentJob.appearance!, ...(abortSignal ? { abortSignal } : {}) });
    const inputTokens = output.inputTokens ?? null, outputTokens = output.outputTokens ?? null;
    observedUsage = { inputTokens, outputTokens };
    const image = await normalizeImage(output.image);
    // Image and text input token categories have distinct published rates. The SDK's aggregate input count is
    // insufficient for a trustworthy total, so cost stays null instead of implying a fixed or undercounted bill.
    const costMicros = null;
    const [saved] = await db.update(petGenerationSlots).set({ status: "succeeded", image, inputTokens, outputTokens, costMicros, finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(petGenerationSlots.id, slot.id), eq(petGenerationSlots.status, "running"))).returning({ id: petGenerationSlots.id });
    if (!saved) throw new Error("slot_claim_lost");
    try { await refreshPreview(p, id); }
    catch (error) {
      const failed = failedAtlasSlots(error);
      if (failed.length) throw new HttpError(400, `Generated cells failed v2 validation in ${failed.join(", ")}. Authorize a separate paid retry for those slots.`);
      throw error;
    }
    return { status: "succeeded" as const, costMicros };
  } catch (error) {
    const invalidOutput = error instanceof Error && error.message === "invalid_image_output";
    const authorizationFailure = error instanceof HttpError && error.status === 403;
    await db.update(petGenerationSlots).set({ status: invalidOutput || authorizationFailure ? "failed" : "uncertain", inputTokens: observedUsage?.inputTokens ?? null, outputTokens: observedUsage?.outputTokens ?? null,
      errorCode: invalidOutput ? "invalid_output" : authorizationFailure ? "authorization_revoked" : "provider_uncertain", finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(petGenerationSlots.id, slot.id), eq(petGenerationSlots.status, "running")));
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, invalidOutput ? "The provider returned an unusable image. Authorize a separate paid retry to replace this slot." : "The provider response is uncertain. This request will not be replayed; authorize a separate paid retry only after reviewing its receipt.");
  }
}

export async function retryPetGenerationSlot(p: Principal, id: string, key: string, consent: boolean) {
  if (consent !== true) throw new HttpError(400, "A retry is a new paid request and requires fresh explicit consent.");
  if (!slotKeys.includes(key)) throw new HttpError(400, "Unknown sprite slot.");
  const job = await ownedJob(p, id);
  if (!job.buildConsentAt || job.appearanceState !== "approved") throw new HttpError(409, "The approved, cost-consented job is required before retrying.");
  await currentConnectionForJob(job);
  return db.transaction(async tx => {
    const [lockedJob] = await tx.select().from(petGenerationJobs)
      .where(and(eq(petGenerationJobs.id, id), eq(petGenerationJobs.ownerId, p.user.id))).for("update");
    if (!lockedJob) throw new HttpError(404, "Pet generation draft not found.");
    await assertFreshPetGenerationAccess(p, tx, true);
    if (lockedJob.catalogPetId) throw new HttpError(409, "A saved catalog draft cannot be changed by generating replacement states.");
    if (!lockedJob.buildConsentAt || lockedJob.appearanceState !== "approved") throw new HttpError(409, "The approved, cost-consented job is required before retrying.");
    const [current] = await tx.select().from(petGenerationSlots).where(and(eq(petGenerationSlots.jobId, id), eq(petGenerationSlots.slotKey, key))).orderBy(desc(petGenerationSlots.attempt)).limit(1).for("update");
    if (!current || current.attempt >= 3 || !["failed", "uncertain", "succeeded"].includes(current.status)) throw new HttpError(409, "Only failed, uncertain, or successful slots can receive a new, separately consented attempt, up to three attempts total.");
    const replacement = current.status === "succeeded";
    const [next] = await tx.insert(petGenerationSlots).values({ jobId: id, slotKey: key, attempt: current.attempt + 1, prompt: current.prompt,
      consentVersion: 1, consentSummary: replacement
        ? "slot-replacement-v1: one additional paid image request to replace a successful but unsatisfactory state; prior request already incurred cost; variable token usage; no fixed quote or hard cap"
        : "slot-retry-v1: one additional paid image request; prior request may also have incurred cost; variable token usage; no fixed quote or hard cap",
      status: "queued", consentAt: new Date() }).returning({ id: petGenerationSlots.id, attempt: petGenerationSlots.attempt });
    await tx.update(petGenerationJobs).set({ preview: null, previewErrorCode: null, updatedAt: new Date() }).where(eq(petGenerationJobs.id, id));
    return { status: "queued" as const, attempt: next.attempt };
  });
}

export async function getPetGenerationJob(p: Principal, id: string) {
  const job = await ownedJob(p, id);
  const staleBefore = new Date(Date.now() - 15 * 60 * 1000);
  const stale = await db.select({ id: petGenerationSlots.id, slotKey: petGenerationSlots.slotKey, attempt: petGenerationSlots.attempt }).from(petGenerationSlots)
    .where(and(eq(petGenerationSlots.jobId, id), eq(petGenerationSlots.status, "running"), lt(petGenerationSlots.updatedAt, staleBefore)));
  if (stale.length) await db.transaction(async tx => {
    await assertFreshPetGenerationAccess(p, tx);
    for (const slot of stale) await tx.update(petGenerationSlots).set({ status: "uncertain", errorCode: "stale_after_restart", finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(petGenerationSlots.id, slot.id), eq(petGenerationSlots.status, "running")));
    const staleAppearance = stale.find(slot => slot.slotKey === "appearance");
    if (staleAppearance) await tx.update(petGenerationJobs).set({ appearanceState: "uncertain", appearanceErrorCode: "stale_after_restart", updatedAt: new Date() })
      .where(and(eq(petGenerationJobs.id, id), eq(petGenerationJobs.appearanceState, "running"), eq(petGenerationJobs.appearanceAttempt, staleAppearance.attempt)));
  });
  const currentJob = stale.length ? await ownedJob(p, id) : job;
  const slots = await db.select({ slotKey: petGenerationSlots.slotKey, attempt: petGenerationSlots.attempt, status: petGenerationSlots.status,
    inputTokens: petGenerationSlots.inputTokens, outputTokens: petGenerationSlots.outputTokens, costMicros: petGenerationSlots.costMicros,
    errorCode: petGenerationSlots.errorCode, consentVersion: petGenerationSlots.consentVersion, consentSummary: petGenerationSlots.consentSummary, updatedAt: petGenerationSlots.updatedAt,
  }).from(petGenerationSlots).where(eq(petGenerationSlots.jobId, id)).orderBy(petGenerationSlots.slotKey, desc(petGenerationSlots.attempt));
  const latest = new Map<string, number>();
  for (const slot of slots) latest.set(slot.slotKey, Math.max(latest.get(slot.slotKey) ?? 0, slot.attempt));
  return { id: currentJob.id, displayName: currentJob.displayName, description: currentJob.description, credit: currentJob.credit, appearanceState: currentJob.appearanceState,
    appearanceConsentAt: currentJob.appearanceConsentAt, appearanceApprovedAt: currentJob.appearanceApprovedAt, buildConsentAt: currentJob.buildConsentAt,
    hasAppearance: !!currentJob.appearance, hasPreview: !!currentJob.preview, previewErrorCode: currentJob.previewErrorCode, catalogPetId: currentJob.catalogPetId,
    slots: slots.map(slot => ({ ...slot, isLatest: latest.get(slot.slotKey) === slot.attempt })) };
}

export async function petGenerationImage(p: Principal, id: string, kind: "appearance" | "preview") {
  const job = await ownedJob(p, id);
  const data = kind === "appearance" ? job.appearance : job.preview;
  if (!data) throw new HttpError(404, "Image is not available yet.");
  return data;
}

export async function getPetGenerationMemberPageData(p: Principal) {
  const fresh = await loadPrincipal(p.user.id);
  if (!fresh || fresh.user.sessionVersion !== p.user.sessionVersion) throw new HttpError(403, "Your access changed. Sign in again.");
  const settings = await getSetting("petGeneration");
  const allowed = userMayGeneratePet(fresh, settings);
  const [jobs, bots] = allowed ? await Promise.all([listPetGenerationJobs(fresh), listAccessibleBots(fresh)]) : [[], []];
  return {
    allowed,
    settings: { enabled: allowed && settings.enabled, providerConnectionId: null, modelId: settings.modelId,
      access: settings.access, allowedGroupIds: [], allowedUpns: [] } satisfies PetGenerationSettings,
    jobs,
    assignableBots: bots.filter(bot => bot.visibility === "private" && bot.executionMode === "caller")
      .map(bot => ({ id: bot.id, name: bot.name })),
  };
}

export async function rebuildPetGenerationPreview(p: Principal, id: string, beforePreviewCommit?: () => Promise<void>) {
  const job = await ownedJob(p, id);
  if (!job.buildConsentAt || job.appearanceState !== "approved") throw new HttpError(409, "Approve the appearance and authorize sprite generation first.");
  try { await refreshPreview(p, id, beforePreviewCommit); }
  catch (error) {
    const failed = failedAtlasSlots(error);
    if (failed.length) throw new HttpError(400, `Generated cells failed v2 validation in ${failed.join(", ")}. Authorize a separately consented paid retry for those slots.`);
    throw error;
  }
  return getPetGenerationJob(p, id);
}

/** Copy the owner's reviewed v2 preview into their private bot-pet row, using existing bot edit rules. */
export async function assignPetGenerationPreviewPrivately(p: Principal, id: string, botId: string, visualReview: boolean) {
  if (visualReview !== true) throw new HttpError(400, "Review all animation states, directions, and avatar previews before assigning this private pet.");
  return db.transaction(async tx => {
    const [job] = await tx.select().from(petGenerationJobs)
      .where(and(eq(petGenerationJobs.id, id), eq(petGenerationJobs.ownerId, p.user.id))).for("update");
    if (!job?.preview) throw new HttpError(409, "A complete validated preview is required before assigning a private pet.");
    await assertFreshPetGenerationAccess(p, tx);
    const bot = await lockPetViewer(p, botId, tx);
    assertPersonalPetAllowed(bot);
    await assertFreshPetGenerationAccess(p, tx);
    const slots = await tx.select({ key: petGenerationSlots.slotKey, attempt: petGenerationSlots.attempt, status: petGenerationSlots.status })
      .from(petGenerationSlots).where(eq(petGenerationSlots.jobId, id)).orderBy(petGenerationSlots.slotKey, desc(petGenerationSlots.attempt)).for("update");
    const latest = new Map<string, typeof slots[number]>();
    for (const slot of slots) if (!latest.has(slot.key)) latest.set(slot.key, slot);
    if (slotKeys.some(key => latest.get(key)?.status !== "succeeded")) throw new HttpError(409, "The preview no longer matches the latest successful slot receipts. Rebuild it before assigning.");
    const manifest: PetManifest = { displayName: job.displayName, description: job.description, spriteVersionNumber: 2, credit: job.credit };
    await tx.insert(botPets).values({ userId: p.user.id, botId, mode: "personal", appearance: "custom", catalogId: null,
      enabled: true, custom: manifest, sprite: job.preview, revision: newId() })
      .onConflictDoUpdate({ target: [botPets.userId, botPets.botId], set: { mode: "personal", appearance: "custom", catalogId: null,
        enabled: true, custom: manifest, sprite: job.preview, revision: newId() } });
    return { status: "assigned" as const, botId, botName: bot.name };
  });
}

async function refreshPreview(p: Principal, id: string, beforePreviewCommit?: () => Promise<void>) {
  const slots = await db.select().from(petGenerationSlots).where(eq(petGenerationSlots.jobId, id)).orderBy(petGenerationSlots.slotKey, desc(petGenerationSlots.attempt));
  const latest = new Map<string, (typeof slots)[number]>();
  for (const slot of slots) if (!latest.has(slot.slotKey)) latest.set(slot.slotKey, slot);
  if (slotKeys.some(key => latest.get(key)?.status !== "succeeded")) return;
  const snapshot = new Map(slotKeys.map(key => [key, latest.get(key)!.id]));
  let normalized: Buffer;
  try {
    const canvas = sharp({ create: { width: 1536, height: 2288, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
    const layers: OverlayOptions[] = [];
    for (const [stateIndex, state] of PET_ANIMATIONS.entries()) {
      const source = latest.get(state.name)!.image!;
      for (let index = 0; index < state.durations.length; index++) layers.push(await atlasCell(source, index, 4, 2, index * 192, stateIndex * 208));
    }
    const directions = latest.get("directions")!.image!;
    for (let index = 0; index < PET_DIRECTIONS.length; index++) {
      const direction = PET_DIRECTIONS[index];
      layers.push(await atlasCell(directions, index, 4, 4, direction.column * 192, direction.row * 208));
    }
    const png = await canvas.composite(layers).png().toBuffer();
    normalized = await normalizePetSprite(png, 2, "spritesheet.png");
  } catch {
    await beforePreviewCommit?.();
    const current = await db.transaction(async tx => {
      await assertFreshPetGenerationAccess(p, tx);
      const [job] = await tx.select({ id: petGenerationJobs.id }).from(petGenerationJobs)
        .where(and(eq(petGenerationJobs.id, id), eq(petGenerationJobs.ownerId, p.user.id))).for("update");
      if (!job || !await previewSnapshotIsCurrent(tx, id, snapshot)) return false;
      await tx.update(petGenerationJobs).set({ preview: null, previewErrorCode: "assembly_failed", updatedAt: new Date() })
        .where(eq(petGenerationJobs.id, id));
      return true;
    });
    if (!current) return;
    throw new HttpError(500, "The saved sprite requests could not be assembled into a preview. Retry nonbillable preview assembly; no new image request is needed.");
  }
  try { await validateV2Cells(normalized); }
  catch (error) {
    if (error instanceof HttpError && error.message.includes("Fix these v2 cells:")) {
      await beforePreviewCommit?.();
      const failed = await markAtlasValidationFailures(p, id, error, snapshot);
      if (!failed.length) return;
      throw error;
    }
    await beforePreviewCommit?.();
    const current = await db.transaction(async tx => {
      await assertFreshPetGenerationAccess(p, tx);
      const [job] = await tx.select({ id: petGenerationJobs.id }).from(petGenerationJobs)
        .where(and(eq(petGenerationJobs.id, id), eq(petGenerationJobs.ownerId, p.user.id))).for("update");
      if (!job || !await previewSnapshotIsCurrent(tx, id, snapshot)) return false;
      await tx.update(petGenerationJobs).set({ preview: null, previewErrorCode: "assembly_failed", updatedAt: new Date() })
        .where(eq(petGenerationJobs.id, id));
      return true;
    });
    if (!current) return;
    throw new HttpError(500, "The saved sprite requests could not be validated as a preview. Retry nonbillable preview assembly; no new image request is needed.");
  }
  await beforePreviewCommit?.();
  await db.transaction(async tx => {
    await assertFreshPetGenerationAccess(p, tx);
    const [job] = await tx.select({ id: petGenerationJobs.id }).from(petGenerationJobs)
      .where(and(eq(petGenerationJobs.id, id), eq(petGenerationJobs.ownerId, p.user.id))).for("update");
    if (!job || !await previewSnapshotIsCurrent(tx, id, snapshot)) return;
    await tx.update(petGenerationJobs).set({ preview: normalized, previewErrorCode: null, updatedAt: new Date() }).where(eq(petGenerationJobs.id, id));
  });
}

async function previewSnapshotIsCurrent(tx: Tx, id: string, snapshot: Map<string, string>) {
  const rows = await tx.select({ id: petGenerationSlots.id, key: petGenerationSlots.slotKey, status: petGenerationSlots.status })
    .from(petGenerationSlots).where(eq(petGenerationSlots.jobId, id)).orderBy(petGenerationSlots.slotKey, desc(petGenerationSlots.attempt)).for("update");
  const latest = new Map<string, typeof rows[number]>();
  for (const row of rows) if (!latest.has(row.key)) latest.set(row.key, row);
  return slotKeys.every(key => latest.get(key)?.id === snapshot.get(key) && latest.get(key)?.status === "succeeded");
}

function failedAtlasSlots(error: unknown) {
  if (!(error instanceof HttpError) || !error.message.includes("Fix these v2 cells:")) return [] as string[];
  const failed = new Set<string>();
  for (const state of PET_ANIMATIONS) if (error.message.includes(`${state.name} frame `) || error.message.includes(`${state.name} unused cell `)) failed.add(state.name);
  if (error.message.includes("look ")) failed.add("directions");
  return [...failed];
}

async function markAtlasValidationFailures(p: Principal, id: string, error: unknown, snapshot: Map<string, string>) {
  const failed = failedAtlasSlots(error);
  if (!failed.length) return failed;
  return db.transaction(async tx => {
    await assertFreshPetGenerationAccess(p, tx);
    const [job] = await tx.select({ id: petGenerationJobs.id }).from(petGenerationJobs)
      .where(and(eq(petGenerationJobs.id, id), eq(petGenerationJobs.ownerId, p.user.id))).for("update");
    if (!job || !await previewSnapshotIsCurrent(tx, id, snapshot)) return [] as string[];
    for (const key of failed) {
      const receiptId = snapshot.get(key);
      if (receiptId) await tx.update(petGenerationSlots).set({ status: "failed", errorCode: "atlas_validation", updatedAt: new Date() })
        .where(and(eq(petGenerationSlots.id, receiptId), eq(petGenerationSlots.status, "succeeded")));
    }
    return failed;
  });
}

async function atlasCell(source: Buffer, index: number, columns: number, rows: number, left: number, top: number): Promise<OverlayOptions> {
  const width = 1024 / columns, height = 1024 / rows;
  const cell = await sharp(source).extract({ left: index % columns * width, top: Math.floor(index / columns) * height, width, height })
    .resize(192, 208, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  return { input: cell, left, top };
}

export async function savePetGenerationPreview(p: Principal, id: string, consent: { rights: unknown; visualReview: unknown }) {
  if (consent.visualReview !== true) throw new HttpError(400, "Review all animation states, directions, and avatar previews before saving.");
  if (consent.rights !== "confirmed") throw new HttpError(400, "Confirm permission to share this generated artwork with signed-in users before saving a catalog draft.");
  const job = await ownedJob(p, id);
  if (!job.preview || job.catalogPetId) throw new HttpError(409, "A complete validated preview is required; refresh to check for an existing draft.");
  await validateV2Cells(job.preview);
  return db.transaction(async tx => {
    const [locked] = await tx.select().from(petGenerationJobs).where(and(eq(petGenerationJobs.id, id), eq(petGenerationJobs.ownerId, p.user.id))).for("update");
    if (!locked?.preview || locked.catalogPetId) throw new HttpError(409, "This preview was already saved or changed. Refresh the draft.");
    await assertFreshPetAdmin(p, tx);
    const slots = await tx.select({ key: petGenerationSlots.slotKey, attempt: petGenerationSlots.attempt, status: petGenerationSlots.status })
      .from(petGenerationSlots).where(eq(petGenerationSlots.jobId, id)).orderBy(petGenerationSlots.slotKey, desc(petGenerationSlots.attempt)).for("update");
    const latest = new Map<string, typeof slots[number]>();
    for (const slot of slots) if (!latest.has(slot.key)) latest.set(slot.key, slot);
    if (slotKeys.some(key => latest.get(key)?.status !== "succeeded")) throw new HttpError(409, "The preview no longer matches the latest successful slot receipts. Rebuild it before saving.");
    const manifest: PetManifest = { displayName: locked.displayName, description: locked.description, spriteVersionNumber: 2, credit: locked.credit };
    const [pet] = await tx.insert(petCatalog).values({ createdBy: p.user.id, manifest, sprite: locked.preview }).returning({ id: petCatalog.id, revision: petCatalog.revision, status: petCatalog.status });
    await tx.insert(auditLog).values({ actorId: p.user.id, action: "pet.catalog_draft", target: pet.id,
      details: { rights: "confirmed", affirmationVersion: 1, visualReview: "confirmed", visualReviewVersion: 1,
        audience: "signed-in users", revision: pet.revision, generatedFrom: id } });
    await tx.update(petGenerationJobs).set({ catalogPetId: pet.id, updatedAt: new Date() }).where(eq(petGenerationJobs.id, id));
    return pet;
  });
}
