"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { aiApps, bots } from "@/db/schema";
import { requireAdmin } from "@/lib/session";
import { HttpError } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { newId } from "@/lib/ids";
import { HERMES_PROTOCOL, managedConfig } from "@/lib/hermes-provisioning/config";
import { registerConnection, rotateDashboardToken, setConnectionEnabled } from "@/lib/hermes-provisioning/store";

import { approveManagedBot } from "@/lib/hermes-provisioning/bot-policy";

const resultError = (err: unknown) => ({ error: err instanceof HttpError ? err.message : "The settings could not be saved. Check the required fields and try again." });
export async function registerHermesConnection(form: FormData) {
  const p = await requireAdmin();
  // FormData also keeps Next's development action-argument logger from serializing secret object fields.
  try {
    if (!(form instanceof FormData)) throw new HttpError(400, "Invalid connection form");
    await registerConnection(p, {
      userId: form.get("userId"), boundaryId: form.get("boundaryId"), isolated: form.get("isolated") === "on", protocol: HERMES_PROTOCOL,
      dashboardUrl: form.get("dashboardUrl"), runsUrl: form.get("runsUrl"), expectedVersion: form.get("expectedVersion"), expectedDisplayVersion: form.get("expectedDisplayVersion"),
      dashboardToken: form.get("dashboardToken"), provider: form.get("provider"), providerKey: form.get("providerKey"),
      profileKeys: String(form.get("profileKeys") ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    });
    revalidatePath("/admin/hermes"); return { ok: true };
  }
  catch (err) { return resultError(err); }
}
export async function toggleHermesConnection(id: string, enabled: boolean) {
  const p = await requireAdmin();
  if (typeof id !== "string" || typeof enabled !== "boolean") return { error: "Invalid connection" };
  await setConnectionEnabled(p, id, enabled);
  revalidatePath("/admin/hermes");
  return { ok: true };
}
/** Session tokens can expire on Hermes restart. Replace only the token, under the same row-bound encryption. */
export async function rotateHermesDashboardToken(form: FormData) {
  const p = await requireAdmin();
  if (!(form instanceof FormData)) return { error: "Invalid token form" };
  const id = String(form.get("id") ?? ""), token = String(form.get("token") ?? "");
  try {
    await rotateDashboardToken(p, id, token);
    return { ok: true };
  } catch (err) { return resultError(err); }
}
export async function createManagedHermesBot(raw: unknown) {
  const p = await requireAdmin();
  try {
    const input = z.object({ name: z.string().trim().min(1).max(80), instructions: z.string().trim().min(1).max(20000), config: managedConfig }).strict().parse(raw);
    const appId = newId(), botId = newId();
    await db.transaction(async (tx) => {
      await tx.insert(aiApps).values({ id: appId, name: `${input.name} · private Hermes profiles`, provider: "hermes", model: input.config.model,
        baseUrl: "http://127.0.0.1", providerConfig: { profile: "managed", approvalTimeoutSec: 300, allowedModels: "", managed: input.config, managedBotId: botId }, supportsTools: true });
      await tx.insert(bots).values({ id: botId, ownerId: p.user.id, name: input.name, instructions: input.instructions, appId, visibility: "org" });
    });
    await audit(p.user.id, "hermes.template.create", botId, { appId });
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (err) { return resultError(err); }
}

export async function approveExistingManagedHermesBot(appId: string, botId: string) {
  const p = await requireAdmin();
  try {
    if (typeof appId !== "string" || typeof botId !== "string") throw new HttpError(400, "Select an existing bot.");
    await approveManagedBot(p, appId, botId);
    await audit(p.user.id, "hermes.template.approve", botId, { appId });
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (err) { return resultError(err); }
}

export async function restoreManagedHermesBot(form: FormData) {
  const p = await requireAdmin();
  try {
    if (!(form instanceof FormData)) throw new HttpError(400, "Invalid restoration form");
    const appId = String(form.get("appId") ?? ""), botId = String(form.get("botId") ?? "");
    await approveManagedBot(p, appId, botId, { name: form.get("name"), description: form.get("description") || null, instructions: form.get("instructions") || null, boundaries: form.get("boundaries") || null });
    await audit(p.user.id, "hermes.template.restore", botId, { appId });
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (err) { return resultError(err); }
}
