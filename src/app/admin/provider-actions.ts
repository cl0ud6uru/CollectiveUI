"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { aiApps, providerConnections } from "@/db/schema";
import { requireAdmin } from "@/lib/session";
import { HttpError } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { newId } from "@/lib/ids";
import { CONFIG_SCHEMAS, normalizeBaseUrl } from "@/lib/llm/catalog";
import { encodeSecretInput, openAppSecret } from "@/lib/llm/secrets";
import { providerConnectionView, sealProviderCredential } from "@/lib/llm/provider-connections";

const nameSchema = z.string().trim().min(1).max(80);
const Input = z.object({
  id: z.string().min(1).optional(), name: nameSchema,
  baseUrl: z.string().max(500).nullable().optional(),
  organization: z.string().trim().max(100).nullable().optional(), project: z.string().trim().max(100).nullable().optional(),
  apiKey: z.string().max(10000).optional(), enabled: z.boolean(),
});
export type ProviderConnectionInput = z.input<typeof Input>;

export async function saveProviderConnection(raw: ProviderConnectionInput) {
  const p = await requireAdmin();
  const input = Input.parse(raw);
  const normalized = normalizeBaseUrl("openai", input.baseUrl);
  if (!normalized.ok) throw new HttpError(400, normalized.error);
  const target = { baseUrl: normalized.value, organization: input.organization || null, project: input.project || null };
  const secret = encodeSecretInput("openai", CONFIG_SCHEMAS.openai.parse({}), { apiKey: input.apiKey });
  const id = input.id ?? newId();
  const view = await db.transaction(async tx => {
    const [existing] = input.id ? await tx.select().from(providerConnections).where(eq(providerConnections.id, id)).for("update") : [];
    if (input.id && !existing) throw new HttpError(404, "Provider connection not found");
    if (existing && (existing.baseUrl !== target.baseUrl || existing.organization !== target.organization || existing.project !== target.project))
      throw new HttpError(400, "The endpoint and billing destination cannot be changed. Create a separate provider connection.");
    if (!existing && !secret) throw new HttpError(400, "Enter the API credential for this provider connection.");
    const values = { name: input.name, enabled: input.enabled, updatedAt: new Date(), ...(secret ? { credentialEnc: sealProviderCredential(id, secret) } : {}) };
    const [row] = existing
      ? await tx.update(providerConnections).set(values).where(eq(providerConnections.id, id)).returning()
      : await tx.insert(providerConnections).values({ id, ...values, ...target, credentialEnc: sealProviderCredential(id, secret!), createdBy: p.user.id }).returning();
    return providerConnectionView(row);
  });
  await audit(p.user.id, input.id ? "provider_connection.update" : "provider_connection.create", id, { rotated: !!input.id && !!secret, enabled: input.enabled });
  revalidatePath("/", "layout");
  return view;
}

export async function deleteProviderConnection(id: string) {
  const p = await requireAdmin();
  await db.transaction(async tx => {
    const [row] = await tx.select().from(providerConnections).where(eq(providerConnections.id, id)).for("update");
    if (!row) throw new HttpError(404, "Provider connection not found");
    const dependencies = await tx.select({ id: aiApps.id }).from(aiApps).where(eq(aiApps.providerConnectionId, id));
    if (dependencies.length) throw new HttpError(409, `This provider connection is used by ${dependencies.length} model(s). Reassign or delete those models first.`);
    await tx.delete(providerConnections).where(eq(providerConnections.id, id));
  });
  await audit(p.user.id, "provider_connection.delete", id);
  revalidatePath("/", "layout");
}

/** Opt-in, one model at a time. No grouping by provider name or plaintext; the original billing target stays exact. */
export async function migrateAppProviderConnection(appId: string, name: string) {
  const p = await requireAdmin();
  const label = nameSchema.parse(name);
  const result = await db.transaction(async tx => {
    const [app] = await tx.select().from(aiApps).where(eq(aiApps.id, appId)).for("update");
    if (!app) throw new HttpError(404, "Model not found");
    if (app.providerConnectionId) return { id: app.providerConnectionId }; // retry is idempotent
    if (app.provider !== "openai" || app.credentialMode !== "org" || !app.apiKeyEnc)
      throw new HttpError(400, "Only an OpenAI API model with its own saved credential can be migrated.");
    const config = CONFIG_SCHEMAS.openai.parse(app.providerConfig);
    let plaintext: string | undefined;
    try { plaintext = openAppSecret(app); } catch { throw new HttpError(400, "The model credential could not be decrypted. Check the server encryption configuration."); }
    if (!plaintext) throw new HttpError(400, "This model has no credential to migrate.");
    const id = newId();
    await tx.insert(providerConnections).values({ id, name: label, baseUrl: app.baseUrl, organization: config.organization || null, project: config.project || null,
      credentialEnc: sealProviderCredential(id, plaintext), createdBy: p.user.id });
    await tx.update(aiApps).set({ providerConnectionId: id, apiKeyEnc: null, updatedAt: new Date() }).where(eq(aiApps.id, appId));
    return { id };
  });
  await audit(p.user.id, "provider_connection.migrate", result.id, { appId });
  revalidatePath("/", "layout");
  return result;
}
