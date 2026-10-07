import { and, eq, sql } from "drizzle-orm";
import { tool } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { attachments, conversations, messages } from "@/db/schema";
import { storage } from "@/lib/files/storage";
import { cleanText } from "@/lib/sandbox/policy";
import { MAX_FILE_BYTES, type PortalWorkspace } from "@/lib/sandbox/session";
import type { AgentCtx, ToolEntry } from "../types";

export function importFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._ -]/g, "_").replace(/^[. ]+/, "").slice(-180).replace(/^[. ]+/, "") || "attachment";
}

/** Resolve original bytes from an owned, user-authored file part in this conversation, never from a model URL/path. */
export function workspaceAttachmentTool(ctx: AgentCtx, ws: PortalWorkspace): ToolEntry {
  return {
    name: "workspace_import_attachment", key: "workspace", sensitive: true,
    tool: tool({
      description: "Copy an uploaded attachment from this conversation into the user's private workspace. Use its attachment ID from the message. Returns the actual path. Original imports are preserved; write edited copies to another folder. Maximum 10 MB.",
      inputSchema: z.object({ attachmentId: z.string().regex(/^[A-Za-z0-9]{1,64}$/) }).strict(),
      async execute({ attachmentId }) {
        const userId = ctx.principal.user.id;
        const [attachment] = await db.select().from(attachments).where(and(eq(attachments.id, attachmentId), eq(attachments.userId, userId)));
        const [message] = attachment ? await db.select({ id: messages.id }).from(messages)
          .innerJoin(conversations, eq(conversations.id, messages.conversationId))
          .where(and(eq(messages.conversationId, ctx.conversationId), eq(conversations.userId, userId), eq(messages.role, "user"),
            sql`${messages.parts} @> ${JSON.stringify([{ type: "file", url: `/api/files/${attachmentId}` }])}::jsonb`)).limit(1) : [];
        if (!attachment || !message) return { ok: false, reason: "unavailable", message: "This attachment is unavailable in your current conversation. Upload it here before importing it." };
        if (attachment.size > MAX_FILE_BYTES) return { ok: false, reason: "too_large", message: "Workspace imports are limited to 10 MB. Upload a smaller file." };
        try {
          const data = await storage().get(attachment.storageKey);
          if (data.length > MAX_FILE_BYTES) return { ok: false, reason: "too_large", message: "Workspace imports are limited to 10 MB. Upload a smaller file." };
          const path = `uploads/${attachmentId}/${importFilename(attachment.filename)}`;
          return await ws.serialize(async () => {
            const existing = await ws.readRaw(path, MAX_FILE_BYTES);
            if (existing && (existing.truncated || !existing.bytes.equals(data)))
              return { ok: false, reason: "import_conflict", message: "The imported copy was changed. Upload the original again to get a new import path; existing files were preserved." };
            if (!existing) await ws.writeNow(path, data);
            return { ok: true, path, filename: attachment.filename, bytes: data.length, imported: !existing };
          });
        } catch (err) {
          return { ok: false, reason: "import_failed", message: cleanText(err instanceof Error ? err.message : String(err)).slice(0, 500) };
        }
      },
    }),
  };
}
