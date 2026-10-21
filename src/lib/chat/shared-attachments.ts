export const SHARED_ATTACHMENT_NOTICE = "Attachments are private and were omitted from this shared conversation.";

/** Shared snapshots never grant access to the owner's uploads, including when the viewer continues a copy. */
export function withoutSharedAttachments(parts: unknown[]) {
  const safe = parts.filter(part => !part || typeof part !== "object" || !("type" in part) || part.type !== "file");
  const omitted = safe.length !== parts.length;
  return { omitted, parts: omitted ? [...safe, { type: "text", text: SHARED_ATTACHMENT_NOTICE }] : safe };
}
