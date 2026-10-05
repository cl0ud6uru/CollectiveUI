import { requirePrincipal } from "@/lib/session";
import { readAvatarSprite } from "@/lib/pets/store";
import { petImage, petError } from "@/lib/pets/response";
import { wantsHdSprite } from "@/lib/pets/shared";
export async function GET(request: Request, ctx: RouteContext<"/api/bots/[id]/pet/avatar">) {
  try { return petImage(await readAvatarSprite(await requirePrincipal(), (await ctx.params).id, new URL(request.url).searchParams.get("v"), wantsHdSprite(request.url))); }
  catch (err) { return petError(err); }
}
