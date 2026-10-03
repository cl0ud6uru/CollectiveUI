"use client";

import { useEffect, useState } from "react";
import type { ConversationSnapshot } from "@/lib/chat/snapshot";
import { TaskChat } from "./task-chat";
import { Chat } from "./chat";
import { useShell } from "./shell-context";

/**
 * Back/forward can restore an old RSC payload after this chat has acquired messages or a live run.
 * Resolve a fresh owner-authorized snapshot on entry, before mounting useChat or allowing a send.
 * Sidebar revalidation doesn't remount this boundary or interrupt an active stream.
 */
export function SavedChat({ conversationId }: { conversationId: string }) {
  const { setCurrentConversation } = useShell();
  const [snapshot, setSnapshot] = useState<ConversationSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/chat/${encodeURIComponent(conversationId)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Could not load this conversation.");
        if (!controller.signal.aborted) {
          const next = data as ConversationSnapshot;
          setCurrentConversation(next.summary);
          setSnapshot(next);
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Could not load this conversation.");
      });
    return () => { controller.abort(); setCurrentConversation(null); };
  }, [conversationId, attempt, setCurrentConversation]);

  if (snapshot?.task) return <TaskChat key={snapshot.conversationId} snapshot={snapshot} />;
  if (snapshot) return <Chat key={snapshot.conversationId} isNew={false} {...snapshot} />;
  return <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-sm text-muted" role="status">
    <p>{error ?? "Loading conversation…"}</p>
    {error && <button className="rounded-lg border border-border px-4 py-2 hover:bg-hover" onClick={() => { setError(null); setAttempt((n) => n + 1); }}>Try again</button>}
  </div>;
}
