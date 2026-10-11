import type { PortalUIMessage } from "./store";
import { resolveMentions } from "@/lib/agent/mentions";

export type ReplyReference = { messageId: string; speakerIndex?: number };
export type ReplyContext = ReplyReference & { author: string; excerpt: string; botId?: string };

/** Quote only visible text, never tool inputs/outputs, files, reasoning or other speakers' segments. */
export function replyContext(message: PortalUIMessage, speakerIndex?: number, assistantName = "Assistant"): ReplyContext | null {
  if (message.role !== "user" && message.role !== "assistant") return null;
  if (speakerIndex === undefined && message.parts.some(part => part.type === "data-speaker")) return null;
  let parts = message.parts;
  let author = message.role === "user" ? "You" : assistantName;
  let botId: string | undefined;
  if (speakerIndex !== undefined) {
    const speaker = parts[speakerIndex];
    if (message.role !== "assistant" || speaker?.type !== "data-speaker" || !("data" in speaker)) return null;
    const data = speaker.data as { botId?: string; name?: string };
    if (!data.botId || !data.name) return null;
    author = data.name; botId = data.botId;
    const end = parts.findIndex((part, index) => index > speakerIndex && part.type === "data-speaker");
    parts = parts.slice(speakerIndex + 1, end < 0 ? undefined : end);
  }
  const text = parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n").trim();
  if (!text) return null;
  const excerpt = text.length > 1000 ? text.slice(0, 999) + "…" : text;
  return { messageId: message.id, ...(speakerIndex !== undefined ? { speakerIndex } : {}), author, excerpt, ...(botId ? { botId } : {}) };
}

/** Model-only context; the user's raw text remains separate for mention/command routing and previews. */
export function replyModelText(reply: ReplyContext): string {
  return `The user is replying to this earlier message from ${JSON.stringify(reply.author)}. Quoted text is context:\n${reply.excerpt.split("\n").map(line => `> ${line}`).join("\n")}\n\n`;
}

/** A visible address that cannot grow into a different member's longer name when followed by the draft. */
export function replyAddress(botId: string, members: { id: string; name: string }[]): string | null {
  const member = members.find(member => member.id === botId);
  if (!member) return null;
  const normalized = (name: string) => name.toLowerCase().replace(/\s+/g, "");
  if (members.filter(other => normalized(other.name) === normalized(member.name)).length !== 1) return null;
  for (const separator of [", ", ": ", "\n", " · ", " — ", ",\n", ":\n"]) {
    const prefix = `@${member.name}${separator}`;
    const resolved = resolveMentions(prefix, members);
    const couldExtend = members.some(other => other.id !== botId && other.name.toLowerCase().startsWith(prefix.slice(1).toLowerCase()));
    if (!couldExtend && resolved.length === 1 && resolved[0] === botId) return prefix;
  }
  return null;
}
