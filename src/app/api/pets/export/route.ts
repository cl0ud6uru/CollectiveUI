import { requirePrincipal } from "@/lib/session";
import { assertPetOrigin, parsePetUpload } from "@/lib/pets/import";
import { writePetArchive } from "@/lib/pets/archive";
import { PET_HEADERS, petError } from "@/lib/pets/response";

/** Export only the caller's submitted, validated bytes. No IDs, storage reads or remote fetches. */
export async function POST(request: Request) {
  try {
    await requirePrincipal(); assertPetOrigin(request);
    const { manifest, sprite } = await parsePetUpload(request);
    return new Response(new Uint8Array(writePetArchive(manifest, sprite)), { headers: {
      ...PET_HEADERS, "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="codex-pet-v2.zip"', "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) { return petError(error); }
}
