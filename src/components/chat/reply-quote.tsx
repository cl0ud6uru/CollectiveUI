import type { ReplyContext } from "@/lib/chat/reply";

export function ReplyQuote({ reply }: { reply: ReplyContext }) {
  return <blockquote className="mb-2 max-w-full border-l-2 border-accent pl-3 text-sm" aria-label={`In reply to ${reply.author}`}>
    <p className="font-medium">{reply.author}</p><p className="line-clamp-3 whitespace-pre-wrap break-words text-muted">{reply.excerpt}</p>
  </blockquote>;
}
