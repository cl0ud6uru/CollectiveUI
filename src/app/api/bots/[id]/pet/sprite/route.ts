import { petError, petImage } from "@/lib/pets/response";
import { requirePrincipal } from "@/lib/session";
import { readPetSprite } from "@/lib/pets/store";

export async function GET(_request: Request, ctx: RouteContext<"/api/bots/[id]/pet/sprite">) {
  try {
    const sprite = await readPetSprite(await requirePrincipal(), (await ctx.params).id);
    return petImage(sprite);
  } catch (err) { return petError(err); }
}
