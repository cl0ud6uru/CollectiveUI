import { petError, petJson } from "@/lib/pets/response";
import { getUsableBot, HttpError } from "@/lib/authz";
import { requirePrincipal } from "@/lib/session";
import { assertPetOrigin, parsePetUpload, readPetBody } from "@/lib/pets/import";
import { petPreferencesSchema } from "@/lib/pets/shared";
import { readPet, replacePet, savePet } from "@/lib/pets/store";
import { assertPersonalPetAllowed } from "@/lib/pets/authorization";

export async function GET(request: Request, ctx: RouteContext<"/api/bots/[id]/pet">) {
  try { return petJson(await readPet(await requirePrincipal(), (await ctx.params).id, new URL(request.url).searchParams.get("editor") === "1")); }
  catch (err) { return petError(err); }
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/bots/[id]/pet">) {
  try {
    const p = await requirePrincipal();
    assertPetOrigin(request);
    let data: unknown;
    try { data = JSON.parse((await readPetBody(request, 1024)).toString("utf8")); }
    catch (err) { if (err instanceof HttpError) throw err; throw new HttpError(400, "Invalid preferences."); }
    const parsed = petPreferencesSchema.safeParse(data);
    if (!parsed.success) throw new HttpError(400, "Invalid preferences.");
    return petJson(await savePet(p, (await ctx.params).id, parsed.data));
  } catch (err) { return petError(err); }
}

export async function POST(request: Request, ctx: RouteContext<"/api/bots/[id]/pet">) {
  try {
    const p = await requirePrincipal();
    assertPetOrigin(request);
    const { id } = await ctx.params;
    assertPersonalPetAllowed(await getUsableBot(p, id)); // deny shared identity before reading/decoding
    const { manifest, sprite } = await parsePetUpload(request);
    return petJson(await replacePet(p, id, manifest, sprite));
  } catch (err) { return petError(err); }
}

export async function DELETE(request: Request, ctx: RouteContext<"/api/bots/[id]/pet">) {
  try {
    const p = await requirePrincipal();
    assertPetOrigin(request);
    return petJson(await replacePet(p, (await ctx.params).id, null, null));
  } catch (err) { return petError(err); }
}
