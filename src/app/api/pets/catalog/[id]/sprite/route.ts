import { requirePrincipal } from "@/lib/session";
import { readCatalogSprite } from "@/lib/pets/catalog";
import { petImage, petError } from "@/lib/pets/response";
export async function GET(request: Request, ctx: RouteContext<"/api/pets/catalog/[id]/sprite">) {
  try { return petImage(await readCatalogSprite(await requirePrincipal(), (await ctx.params).id, new URL(request.url).searchParams.get("v"))); }
  catch (err) { return petError(err); }
}
