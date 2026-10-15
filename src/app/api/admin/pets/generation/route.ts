import { requireAdmin } from "@/lib/session";
import { assertPetOrigin, readPetBody } from "@/lib/pets/import";
import { createPetGenerationJob, listPetGenerationJobs, normalizePetReference } from "@/lib/pets/generation";
import { petError, petJson } from "@/lib/pets/response";
import { HttpError } from "@/lib/authz";

export async function GET() {
  try { return petJson(await listPetGenerationJobs(await requireAdmin())); }
  catch (error) { return petError(error); }
}

export async function POST(request: Request) {
  try {
    const p = await requireAdmin();
    assertPetOrigin(request);
    const raw = await readPetBody(request, 1400 * 1024);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>; }
    catch { throw new HttpError(400, "Invalid pet generation draft."); }
    let reference: Buffer | undefined;
    if (typeof body.referenceBase64 === "string") {
      if (body.referenceBase64.length > 1400 * 1024) throw new HttpError(413, "Reference image is too large.");
      reference = await normalizePetReference(Buffer.from(body.referenceBase64, "base64"));
    }
    if (typeof body.displayName !== "string" || typeof body.description !== "string" || (body.credit !== undefined && typeof body.credit !== "string")) throw new HttpError(400, "Invalid pet generation draft.");
    return petJson(await createPetGenerationJob(p, { displayName: body.displayName, description: body.description,
      ...(typeof body.credit === "string" ? { credit: body.credit } : {}), ...(reference ? { reference } : {}) }));
  } catch (error) { return petError(error); }
}
