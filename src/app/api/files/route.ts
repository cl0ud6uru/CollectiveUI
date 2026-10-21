import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { attachments } from "@/db/schema";
import { extractText, isImage } from "@/lib/files/extract";
import { storage } from "@/lib/files/storage";
import { newId } from "@/lib/ids";
import { HttpError } from "@/lib/authz";
import { errorResponse, requirePrincipal } from "@/lib/session";
import { getSetting } from "@/lib/settings";
import { effectiveUploadMaxMb } from "@/lib/files/upload-limits";
import { assertMutationRequest } from "@/lib/auth/mutation-request";

const BLOCKED = /\.(exe|dll|bat|cmd|msi|scr|com|vbs|js\.map)$/i;

export async function POST(req: Request) {
  try {
    const p = await requirePrincipal();
    assertMutationRequest(req, "multipart/form-data");
    const limits = await getSetting("limits");
    const uploadMaxMb = effectiveUploadMaxMb(limits.uploadMaxMb);
    // A body cut off by the proxy's buffer limit fails to parse; report it as too large rather than an internal error.
    const form = await req.formData().catch(() => {
      throw new HttpError(413, `The upload was too large or incomplete. Files must be ${uploadMaxMb} MB or smaller.`);
    });
    const file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(400, "No file");
    if (file.size > uploadMaxMb * 1024 * 1024) throw new HttpError(413, `Files must be ${uploadMaxMb} MB or smaller.`);
    if (BLOCKED.test(file.name)) throw new HttpError(415, "This file type is not allowed");

    const data = Buffer.from(await file.arrayBuffer());
    const id = newId();
    const mediaType = file.type || "application/octet-stream";
    const storageKey = `${p.user.id}/${id}`;
    // Record the key before writing bytes. A failed upload remains recoverable by the orphan sweep.
    await db.insert(attachments).values({
      id,
      userId: p.user.id,
      filename: file.name.slice(0, 250),
      mediaType,
      size: file.size,
      storageKey,
      uploadComplete: false,
    });
    const extractedText = await db.transaction(async tx => {
      // An active upload holds only its own row lock, so an aged sweep cannot delete bytes while put is running.
      const [pending] = await tx.select({ id: attachments.id }).from(attachments)
        .where(and(eq(attachments.id, id), isNull(attachments.deletedAt))).for("update");
      if (!pending) throw new HttpError(410, "This upload expired. Please upload the file again.");
      await storage().put(storageKey, data);
      const text = isImage(mediaType) ? null : await extractText(data, mediaType, file.name);
      await tx.update(attachments).set({ extractedText: text, uploadComplete: true }).where(eq(attachments.id, id));
      return text;
    });
    return Response.json({ id, url: `/api/files/${id}`, filename: file.name, mediaType, readable: isImage(mediaType) || !!extractedText });
  } catch (err) {
    return errorResponse(err);
  }
}
