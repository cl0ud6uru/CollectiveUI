import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { attachments, type AiApp } from "@/db/schema";
import type { PortalUIMessage } from "@/lib/chat/store";
import { isImage } from "@/lib/files/extract";
import { storage } from "@/lib/files/storage";

const FILE_URL_RE = /^\/api\/files\/([A-Za-z0-9]+)$/;

/**
 * Convert UI file parts (which point at /api/files/<id>) into something the model can consume:
 * images → inline data (vision models), documents → extracted text.
 * Only attachments owned by `userId` are resolved.
 */
export async function resolveAttachmentsForModel(
  history: PortalUIMessage[],
  app: AiApp,
  userId: string,
): Promise<PortalUIMessage[]> {
  const ids = new Set<string>();
  for (const m of history)
    for (const p of m.parts) if (p.type === "file") {
      const id = FILE_URL_RE.exec(p.url)?.[1];
      if (id) ids.add(id);
    }
  const rows = ids.size
    ? await db
        .select()
        .from(attachments)
        .where(and(inArray(attachments.id, [...ids]), eq(attachments.userId, userId)))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));

  const out: PortalUIMessage[] = [];
  for (const m of history) {
    const parts: PortalUIMessage["parts"] = [];
    for (const p of m.parts) {
      if (p.type !== "file") {
        parts.push(p);
        continue;
      }
      const att = byId.get(FILE_URL_RE.exec(p.url)?.[1] ?? "");
      if (!att) {
        parts.push({ type: "text", text: `[Attachment ${p.filename ?? ""} is unavailable]` });
      } else if (isImage(att.mediaType)) {
        if (app.supportsVision) {
          const data = await storage().get(att.storageKey);
          parts.push({ type: "file", mediaType: att.mediaType, filename: att.filename, url: `data:${att.mediaType};base64,${data.toString("base64")}` });
        } else {
          parts.push({ type: "text", text: `[The user attached an image "${att.filename}", but this model cannot view images.]` });
        }
      } else if (att.extractedText) {
        parts.push({ type: "text", text: `<file name="${att.filename}">\n${att.extractedText}\n</file>` });
      } else {
        parts.push({ type: "text", text: `[The user attached "${att.filename}" (${att.mediaType}), which could not be read as text.]` });
      }
    }
    out.push({ ...m, parts });
  }
  return out;
}
