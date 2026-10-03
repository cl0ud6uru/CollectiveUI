import { requirePrincipal } from "@/lib/session";
import { readAccessiblePets } from "@/lib/pets/store";
import { petJson, petError } from "@/lib/pets/response";
export async function GET() {
  try { const p = await requirePrincipal(); return petJson({ userId: p.user.id, pets: await readAccessiblePets(p) }); }
  catch (err) { return petError(err); }
}
