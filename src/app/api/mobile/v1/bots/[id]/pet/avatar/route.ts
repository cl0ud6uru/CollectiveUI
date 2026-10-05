import { requireMobileSession } from "@/lib/session";
import { readAvatarSprite } from "@/lib/pets/store";
import { petImage, petError } from "@/lib/pets/response";

/** Read-only artwork for the effective bot identity; access and revision checks match the website. */
export async function GET(request: Request, ctx: RouteContext<"/api/mobile/v1/bots/[id]/pet/avatar">) {
  try {
    const { principal } = await requireMobileSession();
    const response = petImage(await readAvatarSprite(principal, (await ctx.params).id, new URL(request.url).searchParams.get("v")));
    response.headers.set("Vary", "Authorization");
    return response;
  } catch (err) {
    const response = petError(err);
    response.headers.set("Vary", "Authorization");
    return response;
  }
}
