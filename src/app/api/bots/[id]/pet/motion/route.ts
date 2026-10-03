import { z } from "zod";
import { requirePrincipal } from "@/lib/session";
import { HttpError } from "@/lib/authz";
import { assertPetOrigin, parsePetJson } from "@/lib/pets/import";
import { petJson, petError } from "@/lib/pets/response";
import { savePetMotion } from "@/lib/pets/store";
const schema = z.object({ motion: z.enum(["auto", "still"]) }).strict();
export async function PATCH(request: Request, ctx: RouteContext<"/api/bots/[id]/pet/motion">) {
  try {
    const p = await requirePrincipal(); assertPetOrigin(request);
    const parsed = schema.safeParse(await parsePetJson(request));
    if (!parsed.success) throw new HttpError(400, "Choose an animation preference.");
    return petJson(await savePetMotion(p, (await ctx.params).id, parsed.data.motion));
  } catch (err) { return petError(err); }
}
