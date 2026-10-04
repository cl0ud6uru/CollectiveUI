import { petError, petImage } from "@/lib/pets/response";
import { requirePrincipal } from "@/lib/session";
import { readPetSprite } from "@/lib/pets/store";

export async function GET(request: Request, ctx: RouteContext<"/api/bots/[id]/pet/sprite">) {
  try {
    const sprite = await readPetSprite(await requirePrincipal(), (await ctx.params).id, new URL(request.url).searchParams.get("v"));
    return petImage(sprite);
  } catch (err) { return petError(err); }
}
