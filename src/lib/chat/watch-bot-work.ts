import type { RosterStatus } from "./roster";

export type BotStatusSnapshot = Record<string, RosterStatus | null>;

/** Poll only while visible; coalesce events arriving during a request and discard results after teardown. */
export function watchBotWork(receive: (snapshot: BotStatusSnapshot) => void) {
  const controller = new AbortController();
  let pending = false, again = false;
  const refresh = async () => {
    if (document.hidden || controller.signal.aborted) return;
    if (pending) { again = true; return; }
    pending = true;
    try {
      const response = await fetch("/api/chat/bot-statuses", { cache: "no-store", signal: controller.signal });
      if (response.ok) {
        const snapshot = await response.json() as BotStatusSnapshot;
        if (!controller.signal.aborted) receive(snapshot);
      } else if ((response.status === 401 || response.status === 403) && !controller.signal.aborted) receive({});
    } catch { /* A reconnect or next poll replaces the last confirmed snapshot. */ }
    finally {
      pending = false;
      if (again) { again = false; void refresh(); }
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), 2000);
  window.addEventListener("focus", refresh);
  window.addEventListener("online", refresh);
  window.addEventListener("bot-work-changed", refresh);
  document.addEventListener("visibilitychange", refresh);
  return () => {
    controller.abort(); clearInterval(timer);
    window.removeEventListener("focus", refresh);
    window.removeEventListener("online", refresh);
    window.removeEventListener("bot-work-changed", refresh);
    document.removeEventListener("visibilitychange", refresh);
  };
}
