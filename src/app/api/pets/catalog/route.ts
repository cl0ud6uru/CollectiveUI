import { requirePrincipal } from "@/lib/session";
import { listCatalog } from "@/lib/pets/catalog";
import { petJson, petError } from "@/lib/pets/response";
export async function GET() {
  try { return petJson(await listCatalog(await requirePrincipal())); }
  catch (err) { return petError(err); }
}
