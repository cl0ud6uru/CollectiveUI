import { replyContext } from "./reply";
import type { PortalUIMessage } from "./store";

export type CopiedReplyTarget = { source: PortalUIMessage; copy: PortalUIMessage };

/** Only earlier messages in the copied branch can remain reply targets. */
export function copiedMessageMetadata(metadata: Record<string, unknown> | null, targets: ReadonlyMap<string, CopiedReplyTarget>) {
  if (!metadata) return metadata;
  const { replayKey: _replayKey, replyTo: raw, ...safe } = metadata;
  void _replayKey;
  if (!raw || typeof raw !== "object" || !("messageId" in raw) || typeof raw.messageId !== "string") return safe;
  const target = targets.get(raw.messageId);
  if (!target) return safe;
  const sourceIndex = "speakerIndex" in raw ? raw.speakerIndex : undefined;
  if (sourceIndex !== undefined && (typeof sourceIndex !== "number" || !Number.isInteger(sourceIndex) || sourceIndex < 0)) return safe;
  const author = "author" in raw && typeof raw.author === "string" ? raw.author : "Assistant";
  const reply = replyContext(target.source, sourceIndex, author);
  if (!reply) return safe;

  let speakerIndex: number | undefined;
  if (sourceIndex !== undefined) {
    // Removing private file parts shifts group speaker indexes. Preserve the selected
    // occurrence, including when the same bot speaks more than once in a message.
    const ordinal = target.source.parts.slice(0, sourceIndex).filter(part => part.type === "data-speaker").length;
    speakerIndex = target.copy.parts.flatMap((part, index) => part.type === "data-speaker" ? [index] : [])[ordinal];
    if (speakerIndex === undefined) return safe;
  }
  return { ...safe, replyTo: { ...reply, messageId: target.copy.id, ...(speakerIndex !== undefined ? { speakerIndex } : {}) } };
}
