"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { TaskView } from "@/lib/delegation/view";
import { isFinal } from "@/lib/runs/types";

/** Only a mounted, visible child with its saved terminal transcript can acknowledge completion. */
export function useTaskRead(conversationId: string, task: TaskView, transcriptReady: boolean) {
  const router = useRouter();
  const { runId, status, lastSeq } = task;
  useEffect(() => {
    if (!transcriptReady || !isFinal(status)) return;
    let read = false, pending = false;
    const controller = new AbortController();
    const acknowledge = async () => {
      if (read || pending || controller.signal.aborted || document.hidden || !document.hasFocus() || window.location.pathname !== `/c/${conversationId}`) return;
      pending = true;
      try {
        const response = await fetch(`/api/chat/${conversationId}/read`, { method: "POST", signal: controller.signal,
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId, status, lastSeq }) });
        if (response.ok && !controller.signal.aborted) {
          read = true;
          window.dispatchEvent(new Event("recent-tasks-changed"));
          // The same acknowledgement clears an Inbox item. Refresh its badge from the server too;
          // SavedChat retains the mounted transcript across layout refreshes.
          router.refresh();
        }
      } catch { /* Retry on focus, reconnect or the next tick. */ }
      finally { pending = false; }
    };
    void acknowledge();
    const timer = setInterval(() => void acknowledge(), 2000);
    window.addEventListener("focus", acknowledge);
    window.addEventListener("online", acknowledge);
    document.addEventListener("visibilitychange", acknowledge);
    return () => {
      controller.abort(); clearInterval(timer);
      window.removeEventListener("focus", acknowledge);
      window.removeEventListener("online", acknowledge);
      document.removeEventListener("visibilitychange", acknowledge);
    };
  }, [conversationId, runId, status, lastSeq, transcriptReady, router]);
}
