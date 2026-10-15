import { eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, providerConnections } from "@/db/schema";
import { requireAdmin } from "@/lib/session";
import { OPENAI_DEFAULT_BASE_URL } from "@/lib/llm/providers/openai";
import { getSetting, setSetting } from "@/lib/settings";
import { PET_IMAGE_MODEL } from "@/lib/pets/generation";
import { assertPetOrigin } from "@/lib/pets/import";
import { HttpError } from "@/lib/authz";
import { petError, petJson } from "@/lib/pets/response";
import { readPetBody } from "@/lib/pets/import";

export async function GET() {
  try {
    await requireAdmin();
    const [settings, connections] = await Promise.all([
      getSetting("petGeneration"),
      db.select({ id: providerConnections.id, name: providerConnections.name, provider: providerConnections.provider,
        baseUrl: providerConnections.baseUrl, enabled: providerConnections.enabled }).from(providerConnections).where(eq(providerConnections.enabled, true)),
    ]);
    return petJson({ settings, connections: connections.filter(connection => connection.provider === "openai" &&
      (connection.baseUrl === null || connection.baseUrl === OPENAI_DEFAULT_BASE_URL)) });
  } catch (error) { return petError(error); }
}

export async function PATCH(request: Request) {
  try {
    const p = await requireAdmin();
    assertPetOrigin(request);
    const raw = await readPetBody(request, 8 * 1024);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>; }
    catch { throw new HttpError(400, "Invalid pet generation settings."); }
    if (typeof body.enabled !== "boolean" || (body.access !== "everyone" && body.access !== "selected") || !Array.isArray(body.allowedGroupIds) || body.allowedGroupIds.length > 100 || !body.allowedGroupIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 200) || !Array.isArray(body.allowedUpns) || body.allowedUpns.length > 100 || !body.allowedUpns.every(upn => typeof upn === "string" && upn.length > 0 && upn.length <= 320) || (body.providerConnectionId !== null && (typeof body.providerConnectionId !== "string" || body.providerConnectionId.length > 100))) {
      throw new HttpError(400, "Invalid pet generation settings.");
    }
    if (body.enabled && body.providerConnectionId) {
      const [connection] = await db.select().from(providerConnections).where(eq(providerConnections.id, body.providerConnectionId));
      if (!connection || !connection.enabled || connection.provider !== "openai" || (connection.baseUrl !== null && connection.baseUrl !== OPENAI_DEFAULT_BASE_URL)) {
        throw new HttpError(400, "Select an enabled saved OpenAI connection that uses the official API endpoint.");
      }
    } else if (body.enabled) throw new HttpError(400, "Select a saved OpenAI connection before enabling pet generation.");
    const current = await getSetting("petGeneration");
    const settings = { ...current, enabled: body.enabled, providerConnectionId: body.providerConnectionId as string | null,
      modelId: PET_IMAGE_MODEL, access: body.access as "everyone" | "selected", allowedGroupIds: body.allowedGroupIds as string[], allowedUpns: body.allowedUpns as string[] };
    await setSetting("petGeneration", settings);
    await db.insert(auditLog).values({ actorId: p.user.id, action: "pet.generation.settings", target: settings.providerConnectionId,
      details: { enabled: settings.enabled, modelId: settings.modelId, access: settings.access, allowedGroupCount: settings.allowedGroupIds.length, allowedUpnCount: settings.allowedUpns.length } });
    return petJson({ ...settings, updatedBy: p.user.id });
  } catch (error) { return petError(error); }
}
