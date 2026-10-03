"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Dialog as D } from "radix-ui";
import { MessageSquare, Search, SquarePen } from "lucide-react";
import { BotAvatar } from "@/components/bots/bot-avatar";
import { useShell } from "./shell-context";

type Hit = { conversationId: string; title: string; snippet: string | null; updatedAt: string };

export function SearchDialog() {
  const { searchOpen, setSearchOpen, conversations, bots } = useShell();
  const [q, setQ] = useState("");
  const [result, setResult] = useState<{ q: string; hits: Hit[] } | null>(null);
  const hits = q.trim() && result?.q === q ? result.hits : null;

  useEffect(() => {
    if (!q.trim()) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
        if (res.ok) setResult({ q, hits: (await res.json()).results });
      } catch {}
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  const close = () => {
    setSearchOpen(false);
    setQ("");
  };
  const recent = conversations.slice(0, 8);
  const ql = q.trim().toLowerCase();
  const botHits = (ql ? bots.filter((b) => `${b.name} ${b.label ?? ""}`.toLowerCase().includes(ql)) : bots.filter((b) => !b.hidden)).slice(0, ql ? 6 : 4);
  const botList = botHits.length > 0 && (
    <>
      <div className="px-3 pb-1 pt-3 text-xs text-subtle">Bots</div>
      {botHits.map((b) => (
        <Link key={b.id} prefetch={false} href={`/?bot=${b.id}`} onClick={close} className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm hover:bg-hover">
          <BotAvatar botId={b.id} value={b.icon} size={20} className="h-5 w-5" />
          <span className="truncate">{b.name}</span>
          {b.label && <span className="truncate text-xs text-subtle">{b.label}</span>}
        </Link>
      ))}
    </>
  );

  return (
    <D.Root
      open={searchOpen}
      onOpenChange={(open) => {
        setSearchOpen(open);
        if (!open) setQ("");
      }}
    >
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <D.Content className="fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 overflow-hidden rounded-2xl bg-dialog shadow-2xl">
          <D.Title className="sr-only">Search chats</D.Title>
          <D.Description className="sr-only">Search your conversation history</D.Description>
          <div className="flex items-center gap-3 border-b border-border px-4">
            <Search className="h-5 w-5 text-subtle" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search chats and bots..."
              className="h-14 flex-1 bg-transparent text-base outline-none placeholder:text-subtle"
            />
          </div>
          <div className="max-h-[60vh] overflow-y-auto p-2">
            {!q.trim() && (
              <>
                <Link href="/" onClick={close} className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm hover:bg-hover">
                  <SquarePen className="h-4 w-4" /> New chat
                </Link>
                {botList}
                <div className="px-3 pb-1 pt-3 text-xs text-subtle">Recent</div>
                {recent.map((c) => (
                  <Link key={c.id} href={`/c/${c.id}`} onClick={close} className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm hover:bg-hover">
                    <MessageSquare className="h-4 w-4 shrink-0" />
                    <span className="truncate">{c.title}</span>
                  </Link>
                ))}
              </>
            )}
            {q.trim() && botList}
            {q.trim() && hits && hits.length > 0 && <div className="px-3 pb-1 pt-3 text-xs text-subtle">Chats</div>}
            {q.trim() && hits?.length === 0 && !botHits.length && <div className="px-3 py-8 text-center text-sm text-subtle">No results</div>}
            {hits?.map((h) => (
              <Link
                key={h.conversationId}
                href={`/c/${h.conversationId}`}
                onClick={close}
                className="flex items-start gap-3 rounded-xl px-3 py-2.5 text-sm hover:bg-hover"
              >
                <MessageSquare className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{h.title}</span>
                  {h.snippet && (
                    <span
                      className="line-clamp-2 text-xs text-muted [&_mark]:bg-transparent [&_mark]:font-semibold [&_mark]:text-fg"
                      dangerouslySetInnerHTML={{ __html: h.snippet }}
                    />
                  )}
                </span>
              </Link>
            ))}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
