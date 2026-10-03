import { eq } from "drizzle-orm";
import { db } from "@/db";
import { attachments } from "@/db/schema";
import { isImage } from "@/lib/files/extract";
import { storage } from "@/lib/files/storage";
import { HttpError } from "@/lib/authz";
import { errorResponse, requirePrincipal } from "@/lib/session";

export async function GET(_req: Request, ctx: RouteContext<"/api/files/[id]">) {
  try {
    const p = await requirePrincipal();
    const { id } = await ctx.params;
    const [att] = await db.select().from(attachments).where(eq(attachments.id, id));
    if (!att || (att.userId !== p.user.id && !p.isAdmin)) throw new HttpError(404, "Not found");
    const data = await storage().get(att.storageKey);
    const inline = isImage(att.mediaType) || att.mediaType === "application/pdf";
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": inline ? att.mediaType : "application/octet-stream",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
