import { requireAdmin } from "@/lib/session";
import { assertPetOrigin, readPetBody } from "@/lib/pets/import";
import { approvePetAppearance, consentPetBuild, generateAppearance, getPetGenerationJob, rebuildPetGenerationPreview, retryPetGenerationSlot, runPetGenerationSlot, savePetGenerationPreview } from "@/lib/pets/generation";
import { petError, petJson } from "@/lib/pets/response";
import { HttpError } from "@/lib/authz";

type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  try { const p = await requireAdmin(); return petJson(await getPetGenerationJob(p, (await context.params).id)); }
  catch (error) { return petError(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    const p = await requireAdmin();
    assertPetOrigin(request);
    const body = JSON.parse((await readPetBody(request, 16 * 1024)).toString("utf8")) as Record<string, unknown>;
    const id = (await context.params).id;
    switch (body.action) {
      case "appearance": return petJson(await generateAppearance(p, id, body.consent === true, request.signal));
      case "retryAppearance": return petJson(await generateAppearance(p, id, body.consent === true, request.signal, undefined, true));
      case "approve": return petJson(await approvePetAppearance(p, id));
      case "build": return petJson(await consentPetBuild(p, id, body.consent === true));
      case "slot":
        if (typeof body.slotKey !== "string") throw new HttpError(400, "A sprite slot is required.");
        return petJson(await runPetGenerationSlot(p, id, body.slotKey, request.signal));
      case "retry":
        if (typeof body.slotKey !== "string") throw new HttpError(400, "A sprite slot is required.");
        return petJson(await retryPetGenerationSlot(p, id, body.slotKey, body.consent === true));
      case "save": return petJson(await savePetGenerationPreview(p, id, { rights: body.rights, visualReview: body.visualReview }));
      case "preview": return petJson(await rebuildPetGenerationPreview(p, id));
      default: throw new HttpError(400, "Unknown pet generation action.");
    }
  } catch (error) { return petError(error); }
}
