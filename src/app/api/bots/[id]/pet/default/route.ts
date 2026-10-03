import { requirePrincipal } from "@/lib/session";
import { HttpError } from "@/lib/authz";
import { assertPetOrigin, parsePetJson } from "@/lib/pets/import";
import { botDefaultSchema } from "@/lib/pets/shared";
import { readPet, saveBotDefault } from "@/lib/pets/store";
import { petJson, petError } from "@/lib/pets/response";
export async function PUT(request: Request, ctx: RouteContext<"/api/bots/[id]/pet/default">) {
  try {
    const p = await requirePrincipal(); assertPetOrigin(request);
    const parsed = botDefaultSchema.safeParse(await parsePetJson(request));
    if (!parsed.success) throw new HttpError(400, "Choose a built-in or published catalog pet.");
    const id = (await ctx.params).id;
    await saveBotDefault(p, id, parsed.data);
    return petJson(await readPet(p, id, true));
  } catch (err) { return petError(err); }
}
