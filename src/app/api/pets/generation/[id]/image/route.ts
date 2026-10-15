import { requirePrincipal } from "@/lib/session";
import { GET as getImage } from "@/app/api/admin/pets/generation/[id]/image/route";

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  await requirePrincipal();
  return getImage(request, context);
}
