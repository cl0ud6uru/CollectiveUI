import { z } from "zod";
import { requireAdmin } from "@/lib/session";
import { HttpError } from "@/lib/authz";
import { deleteCatalogPet, setCatalogStatus } from "@/lib/pets/catalog";
import { assertPetOrigin, parsePetJson } from "@/lib/pets/import";
import { petJson, petError } from "@/lib/pets/response";
const schema = z.object({ status: z.enum(["published", "unpublished"]), rights: z.literal("confirmed").optional() }).strict();
export async function PATCH(request: Request, ctx: RouteContext<"/api/admin/pets/[id]">) {
  try {
    const p = await requireAdmin(); assertPetOrigin(request);
    const parsed = schema.safeParse(await parsePetJson(request));
    if (!parsed.success || (parsed.data.status === "published" && parsed.data.rights !== "confirmed")) throw new HttpError(400, "Confirm you have permission to share this artwork with all signed-in users.");
    return petJson(await setCatalogStatus(p, (await ctx.params).id, parsed.data.status, parsed.data.rights));
  } catch (err) { return petError(err); }
}
/** Permanent removal. The body repeats the pet ID so a stray or replayed request can't delete a different pet. */
const removal = z.object({ confirm: z.string().min(1).max(100) }).strict();
export async function DELETE(request: Request, ctx: RouteContext<"/api/admin/pets/[id]">) {
  try {
    const p = await requireAdmin(); assertPetOrigin(request);
    const id = (await ctx.params).id;
    const parsed = removal.safeParse(await parsePetJson(request));
    if (!parsed.success || parsed.data.confirm !== id) throw new HttpError(400, "Confirm which pet to delete.");
    return petJson(await deleteCatalogPet(p, id));
  } catch (err) { return petError(err); }
}
