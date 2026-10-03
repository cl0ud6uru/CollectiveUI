import { revalidatePath } from "next/cache";
import { requireAdmin, errorResponse } from "@/lib/session";
import { assertBrandingOrigin, normalizeLogo, readLogoBody } from "@/lib/branding/logo";
import { replaceLogo } from "@/lib/branding/store";

export async function POST(request: Request) {
  try {
    const p = await requireAdmin();
    assertBrandingOrigin(request);
    const png = await normalizeLogo(await readLogoBody(request), request.headers.get("content-type")!);
    const logoUrl = await replaceLogo(p.user.id, png);
    revalidatePath("/", "layout");
    return Response.json({ logoUrl });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const p = await requireAdmin();
    assertBrandingOrigin(request);
    await replaceLogo(p.user.id, null);
    revalidatePath("/", "layout");
    return Response.json({ logoUrl: null });
  } catch (err) {
    return errorResponse(err);
  }
}
