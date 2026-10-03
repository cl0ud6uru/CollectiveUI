import { z } from "zod";
import { requireAdmin } from "@/lib/session";
import { HttpError } from "@/lib/authz";
import { copyOwnImport } from "@/lib/pets/catalog";
import { assertPetOrigin, parsePetJson } from "@/lib/pets/import";
import { petJson, petError } from "@/lib/pets/response";
const schema = z.object({ botId: z.string().min(1).max(100), revision: z.string().min(1).max(100), rights: z.literal("confirmed") }).strict();
export async function POST(request: Request) {
  try {
    const p = await requireAdmin(); assertPetOrigin(request);
    const parsed = schema.safeParse(await parsePetJson(request));
    if (!parsed.success) throw new HttpError(400, "Select your own import and confirm permission to share it.");
    return petJson(await copyOwnImport(p, parsed.data.botId, parsed.data.revision, parsed.data.rights));
  } catch (err) { return petError(err); }
}
