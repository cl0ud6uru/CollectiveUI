import { readLoginPetSprite } from "@/lib/branding/login-pet";
import { petImageType } from "@/lib/pets/response";
import { wantsHdSprite } from "@/lib/pets/shared";

export const dynamic = "force-dynamic";

/** Intentionally public: only the sign-in companion an admin confirmed for public display, at its pinned revision. */
export async function GET(request: Request) {
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  const sprite = await readLoginPetSprite(wantsHdSprite(request.url));
  if (!sprite) return new Response(null, { status: 404, headers });
  return new Response(new Uint8Array(sprite), { headers: { ...headers, "Content-Type": petImageType(sprite), "Content-Disposition": `inline; filename="login-pet.${petImageType(sprite).slice(6)}"` } });
}
