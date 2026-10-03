import { db } from "@/db";
import { attachments } from "@/db/schema";
import { extractText, isImage } from "@/lib/files/extract";
import { storage } from "@/lib/files/storage";
import { newId } from "@/lib/ids";
import { HttpError } from "@/lib/authz";
import { errorResponse, requirePrincipal } from "@/lib/session";
import { getSetting } from "@/lib/settings";

const BLOCKED = /\.(exe|dll|bat|cmd|msi|scr|com|vbs|js\.map)$/i;

export async function POST(req: Request) {
  try {
    const p = await requirePrincipal();
    const limits = await getSetting("limits");
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new HttpError(400, "No file");
    if (file.size > limits.uploadMaxMb * 1024 * 1024) throw new HttpError(413, `Files must be under ${limits.uploadMaxMb} MB`);
    if (BLOCKED.test(file.name)) throw new HttpError(415, "This file type is not allowed");

    const data = Buffer.from(await file.arrayBuffer());
    const id = newId();
    const mediaType = file.type || "application/octet-stream";
    const storageKey = `${p.user.id}/${id}`;
    await storage().put(storageKey, data);
    const extractedText = isImage(mediaType) ? null : await extractText(data, mediaType, file.name);
    await db.insert(attachments).values({
      id,
      userId: p.user.id,
      filename: file.name.slice(0, 250),
      mediaType,
      size: file.size,
      storageKey,
      extractedText,
    });
    return Response.json({ id, url: `/api/files/${id}`, filename: file.name, mediaType, readable: isImage(mediaType) || !!extractedText });
  } catch (err) {
    return errorResponse(err);
  }
}
