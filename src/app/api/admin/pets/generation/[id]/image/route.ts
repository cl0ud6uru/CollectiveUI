import { requirePrincipal } from "@/lib/session";
import { petGenerationImage } from "@/lib/pets/generation";
import { petError, petImage } from "@/lib/pets/response";
import { HttpError } from "@/lib/authz";

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const p = await requirePrincipal();
    const kind = new URL(request.url).searchParams.get("kind");
    if (kind !== "appearance" && kind !== "preview") throw new HttpError(400, "Choose a valid generated image.");
    return petImage(await petGenerationImage(p, (await context.params).id, kind));
  } catch (error) { return petError(error); }
}
