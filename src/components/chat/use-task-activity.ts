"use client";

import { useEffect, useState } from "react";
import type { TaskActivity } from "@/lib/delegation/activity-summary";

export function useTaskActivity(taskId: string | undefined, status: string) {
  const [snapshot, setSnapshot] = useState<TaskActivity | null>(null);
  const [unavailableTask, setUnavailableTask] = useState<string | null>(null);
  useEffect(() => {
    if (!taskId || !["queued", "working"].includes(status)) return;
    let disposed = false, busy = false, finished = false;
    const controller = new AbortController();
    const poll = async () => {
      if (disposed || busy || finished || document.hidden) return;
      busy = true;
      try {
        const res = await fetch(`/api/delegation/${encodeURIComponent(taskId)}/activity`, { cache: "no-store", signal: controller.signal });
        if ([401, 403, 404].includes(res.status)) {
          finished = true;
          if (!disposed) setUnavailableTask(taskId);
          return;
        }
        if (!res.ok) { if (!disposed) setUnavailableTask(taskId); return; }
        const data = await res.json() as TaskActivity;
        if (!disposed && data.taskId === taskId && Array.isArray(data.steps)) {
          setSnapshot(data);
          setUnavailableTask(null);
          finished = !["queued", "working"].includes(data.status);
        }
      } catch { if (!disposed) setUnavailableTask(taskId); }
      finally { busy = false; }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    const resume = () => void poll();
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      disposed = true;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [taskId, status]);
  return {
    activity: ["queued", "working"].includes(status) && snapshot?.taskId === taskId ? snapshot : null,
    unavailable: ["queued", "working"].includes(status) && !!taskId && unavailableTask === taskId,
  };
}
