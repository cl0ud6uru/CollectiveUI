import { requireAdmin } from "@/lib/session";
import { createCatalogPet, listAdminCatalog } from "@/lib/pets/catalog";
import { assertPetOrigin, parsePetUpload } from "@/lib/pets/import";
import { petJson, petError } from "@/lib/pets/response";
export async function GET() {
  try { return petJson(await listAdminCatalog(await requireAdmin())); }
  catch (err) { return petError(err); }
}
export async function POST(request: Request) {
  try {
    const p = await requireAdmin();
    assertPetOrigin(request);
    const { manifest, sprite, rights } = await parsePetUpload(request);
    return petJson(await createCatalogPet(p, manifest, sprite, rights));
  } catch (err) { return petError(err); }
}
