import { requirePrincipal } from "@/lib/session";
import { readAvatarSprite } from "@/lib/pets/store";
import { petImage, petError } from "@/lib/pets/response";
export async function GET(request: Request, ctx: RouteContext<"/api/bots/[id]/pet/avatar">) {
  try { return petImage(await readAvatarSprite(await requirePrincipal(), (await ctx.params).id, new URL(request.url).searchParams.get("v"))); }
  catch (err) { return petError(err); }
}
