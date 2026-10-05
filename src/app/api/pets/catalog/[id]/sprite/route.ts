import { requirePrincipal } from "@/lib/session";
import { readCatalogSprite } from "@/lib/pets/catalog";
import { petImage, petError } from "@/lib/pets/response";
import { wantsHdSprite } from "@/lib/pets/shared";
export async function GET(request: Request, ctx: RouteContext<"/api/pets/catalog/[id]/sprite">) {
  try { return petImage(await readCatalogSprite(await requirePrincipal(), (await ctx.params).id, new URL(request.url).searchParams.get("v"), wantsHdSprite(request.url))); }
  catch (err) { return petError(err); }
}
